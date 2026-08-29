// @vitest-environment jsdom
// CanvasView behavior: a three-pane workspace — outline (roots), canvas
// (index cards), inspector (detail / input). Dispatches decisions through the
// injected remote actions; creates new roots through the injected sender.

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CanvasView,
  type CanvasNodeView,
  type CanvasSessionProjection,
  type CanvasTaskSuggestionView,
  type CanvasTreeView,
  type CanvasViewProps,
  type CanvasViewRemoteActions,
  type CanvasWorkflowPlanView,
  type CanvasWorkflowSuggestionView,
} from '../src/client/CanvasView.tsx'

afterEach(cleanup)

function projection(
  nodes: CanvasNodeView[],
  suggestions: CanvasTaskSuggestionView[] = [],
  workflow?: CanvasWorkflowSuggestionView,
  workflowPlan?: CanvasWorkflowPlanView,
): CanvasSessionProjection {
  return {
    nodes,
    suggestions,
    ...workflow === undefined ? {} : { workflow },
    ...workflowPlan === undefined ? {} : { workflowPlan },
  }
}

function makeActions(over: Partial<CanvasViewRemoteActions> = {}): CanvasViewRemoteActions {
  const emptyTree: CanvasTreeView = { root: { sessionId: 'session-1', nodes: [], children: [] }, sessionCount: 1, nodeCount: 0 }
  return {
    loadTree: vi.fn<CanvasViewRemoteActions['loadTree']>(async () => ({ ok: true, value: emptyTree })),
    confirmNode: vi.fn<CanvasViewRemoteActions['confirmNode']>(async () => ({ ok: true, value: undefined })),
    pinNode: vi.fn<CanvasViewRemoteActions['pinNode']>(async () => ({ ok: true, value: undefined })),
    removeNode: vi.fn<CanvasViewRemoteActions['removeNode']>(async () => ({ ok: true, value: undefined })),
    setNodeTitle: vi.fn<CanvasViewRemoteActions['setNodeTitle']>(async () => ({ ok: true, value: undefined })),
    adoptSuggestion: vi.fn<CanvasViewRemoteActions['adoptSuggestion']>(async () => ({ ok: true, value: undefined })),
    removeSuggestion: vi.fn<CanvasViewRemoteActions['removeSuggestion']>(async () => ({ ok: true, value: undefined })),
    adoptWorkflow: vi.fn<CanvasViewRemoteActions['adoptWorkflow']>(async () => ({ ok: true, value: undefined })),
    removeWorkflow: vi.fn<CanvasViewRemoteActions['removeWorkflow']>(async () => ({ ok: true, value: undefined })),
    forkNode: vi.fn<CanvasViewRemoteActions['forkNode']>(async () => ({ ok: true, value: 'child-session' as never })),
    ...over,
  }
}

function makeProps(over: Partial<CanvasViewProps> = {}): CanvasViewProps {
  return {
    sessionId: 'session-1' as CanvasViewProps['sessionId'],
    useProjection: (() => undefined) as unknown as CanvasViewProps['useProjection'],
    useSessions: (() => ({ byId: {} })) as unknown as CanvasViewProps['useSessions'],
    actions: makeActions(),
    openFile: vi.fn(),
    sendPrompt: vi.fn<CanvasViewProps['sendPrompt']>(async () => {}),
    setComposerTarget: vi.fn<CanvasViewProps['setComposerTarget']>(),
    ...over,
  } as CanvasViewProps
}

function node(turn: number, state: 'settled' | 'pending' | 'removed' = 'settled', pinned = false): CanvasNodeView {
  return {
    turn,
    startSeq: turn * 10,
    endSeq: turn * 10 + 4,
    outputSeq: turn * 10 + 3,
    output: { text: `输出内容 ${turn}`, blocks: [{ type: 'text', text: `输出内容 ${turn}` }] },
    state,
    time: turn * 1000,
    pinned,
  }
}

/** The canvas card for a root (the outline lists the same label). */
function rootCard(turn: number): Element {
  return screen.getAllByText(`根 #${turn}`).at(-1)!
}

describe('CanvasView', () => {
  it('shows the loading hint when the canvasTree projection is absent', () => {
    render(<CanvasView {...makeProps()} />)
    expect(screen.getAllByText(/加载中|投影未挂载/).length).toBeGreaterThan(0)
  })

  it('shows the empty hint when the projection has no nodes', () => {
    const useProjection = (() => projection([])) as unknown as CanvasViewProps['useProjection']
    render(<CanvasView {...makeProps({ useProjection })} />)
    expect(screen.getAllByText(/暂无节点——双击空白新建根任务/).length).toBeGreaterThan(0)
  })

  it('renders roots as index cards with badges', () => {
    const useProjection = (() => projection([node(1), node(2)])) as unknown as CanvasViewProps['useProjection']
    render(<CanvasView {...makeProps({ useProjection })} />)
    expect(rootCard(1)).toBeTruthy()
    expect(rootCard(2)).toBeTruthy()
    expect(screen.getByText(/2 节点/).textContent).toContain('2 节点')
  })

  it('selecting a root opens the inspector detail with full output, actions, and the branch-new entry', () => {
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    render(<CanvasView {...makeProps({ useProjection, actions })} />)
    fireEvent.click(rootCard(1))
    // Detail pane shows the full text (card summary + detail both carry it)
    // and the decision buttons. Selecting the session's LAST node routes the
    // rail composer to continue that session.
    expect(screen.getAllByText('输出内容 1').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    expect(actions.removeNode).toHaveBeenCalledWith('session-1', 1)
  })

  it('switching sessions resets per-session view state and the composer target', () => {
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    const props = makeProps({ useProjection, setComposerTarget })
    const view = render(<CanvasView {...props} />)
    // Select the node: the detail pane opens and the composer routes to it.
    fireEvent.click(rootCard(1))
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy()
    expect(setComposerTarget).toHaveBeenLastCalledWith({ kind: 'session', sessionId: 'session-1' })
    // Collapse the right rail, then switch sessions: selection, inspector,
    // composer target, and the collapsed rail must not leak over.
    fireEvent.click(screen.getByRole('button', { name: /右栏/ }))
    view.rerender(<CanvasView {...props} sessionId={'session-2' as CanvasViewProps['sessionId']} />)
    expect(screen.queryByRole('button', { name: '删除' })).toBeNull()
    expect(setComposerTarget).toHaveBeenLastCalledWith(null)
    expect(view.container.querySelector('[data-canvas-inspector-collapsed]')).toBeNull()
  })

  it('toolbar toggle collapses and expands the right rail', () => {
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const { container } = render(<CanvasView {...makeProps({ useProjection })} />)
    expect(container.querySelector('[data-canvas-inspector-collapsed]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /右栏/ }))
    expect(container.querySelector('[data-canvas-inspector-collapsed]')).not.toBeNull()
    expect(screen.getByRole('button', { name: /◀ 右栏/ })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /◀ 右栏/ }))
    expect(container.querySelector('[data-canvas-inspector-collapsed]')).toBeNull()
    expect(screen.getByRole('button', { name: /▶ 右栏/ })).toBeTruthy()
  })

  it('a workflow step waiting for input reopens a collapsed rail (input backstop)', async () => {
    let current = projection([])
    const useProjection = (() => current) as unknown as CanvasViewProps['useProjection']
    const props = makeProps({ useProjection })
    const view = render(<CanvasView {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /右栏/ }))
    expect(view.container.querySelector('[data-canvas-inspector-collapsed]')).not.toBeNull()
    // A workflow step starts waiting for input: the rail must slide open so
    // the user cannot miss the per-run input box.
    current = projection([], [], undefined, {
      batchSeq: 7,
      nodes: [{ id: 'topic', title: '确定今日主题', input: true }],
      edges: [],
    })
    view.rerender(<CanvasView {...props} />)
    await vi.waitFor(() => {
      expect(view.container.querySelector('[data-canvas-inspector-collapsed]')).toBeNull()
    })
  })

  it('grandchildren wait for confirmation; the detail pane offers it', async () => {
    const useProjection = (() => projection([])) as unknown as CanvasViewProps['useProjection']
    const tree: CanvasTreeView = {
      root: {
        sessionId: 'trunk-session',
        nodes: [],
        children: [{
          sessionId: 'child-session',
          parentSessionId: 'trunk-session',
          nodes: [],
          children: [{
            sessionId: 'grandchild-session',
            parentSessionId: 'child-session',
            nodes: [node(1, 'pending')],
            children: [],
          }],
        }],
      },
      sessionCount: 3,
      nodeCount: 1,
    }
    const actions = makeActions({
      loadTree: vi.fn<CanvasViewRemoteActions['loadTree']>(async () => ({ ok: true, value: tree })),
    })
    render(<CanvasView {...makeProps({ useProjection, actions })} />)
    fireEvent.click(await screen.findByText(/⎇ #1/))
    expect(screen.getByRole('button', { name: '确认' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    expect(actions.confirmNode).toHaveBeenCalledWith('grandchild-session', 1, 13)
  })

  it('selecting a node routes the rail composer: last node continues, others fork', async () => {
    // Trunk has two roots; node 1 is not the last, node 2 is.
    const useProjection = (() => projection([node(1), node(2)])) as unknown as CanvasViewProps['useProjection']
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    render(<CanvasView {...makeProps({ useProjection, setComposerTarget })} />)
    // A non-last root forks the node.
    fireEvent.click(rootCard(1))
    expect(setComposerTarget).toHaveBeenLastCalledWith({ kind: 'fork', sessionId: 'session-1', turn: 1 })
    // The session's last root continues the session.
    fireEvent.click(rootCard(2))
    expect(setComposerTarget).toHaveBeenLastCalledWith({ kind: 'session', sessionId: 'session-1' })
  })

  it('double-clicking empty canvas clears the composer target (new root)', () => {
    const useProjection = (() => projection([])) as unknown as CanvasViewProps['useProjection']
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    const { container } = render(<CanvasView {...makeProps({ useProjection, setComposerTarget })} />)
    const viewport = container.querySelector('[data-canvas-viewport]') as HTMLElement
    fireEvent.doubleClick(viewport, { clientX: 300, clientY: 300 })
    expect(setComposerTarget).toHaveBeenLastCalledWith(null)
  })

  it('opens a produced file through the host opener from the detail pane', () => {
    const producedNode = { ...node(1), produced: ['out/report.md'] }
    const useProjection = (() => projection([producedNode])) as unknown as CanvasViewProps['useProjection']
    const openFile = vi.fn()
    render(<CanvasView {...makeProps({ useProjection, openFile })} />)
    fireEvent.click(rootCard(1))
    fireEvent.click(screen.getByText(/report\.md/))
    expect(openFile).toHaveBeenCalledWith('out/report.md')
  })

  it('a named node shows its title on the card and in the outline', () => {
    const namedNode = { ...node(1), title: '设计数据模型' }
    const useProjection = (() => projection([namedNode])) as unknown as CanvasViewProps['useProjection']
    render(<CanvasView {...makeProps({ useProjection })} />)
    // The title (not the bare number) is the card's identity.
    expect(screen.getAllByText('设计数据模型').length).toBeGreaterThan(0)
    fireEvent.click(rootCard(1))
    // The detail pane shows the title with the rename affordance.
    expect(screen.getAllByText('设计数据模型').length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: /命名/ })).toBeTruthy()
  })

  it('auto-names a node from its turn prompt (the task) the moment it renders', () => {
    const promptNode = { ...node(1), prompt: '设计画布节点的数据模型' }
    const useProjection = (() => projection([promptNode])) as unknown as CanvasViewProps['useProjection']
    render(<CanvasView {...makeProps({ useProjection })} />)
    // The card shows the task prompt — specific and user-recognizable.
    expect(screen.getAllByText('设计画布节点的数据模型').length).toBeGreaterThan(0)
  })

  it('renaming a node in the detail pane dispatches setNodeTitle', () => {
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    render(<CanvasView {...makeProps({ useProjection, actions })} />)
    fireEvent.click(rootCard(1))
    fireEvent.click(screen.getByRole('button', { name: /命名/ }))
    const titleInput = screen.getByPlaceholderText('节点标题') as HTMLInputElement
    fireEvent.change(titleInput, { target: { value: '新标题' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(actions.setNodeTitle).toHaveBeenCalledWith('session-1', 1, 13, '新标题')
  })

  it('outline lists roots and can hide', () => {
    const useProjection = (() => projection([node(1), node(2)])) as unknown as CanvasViewProps['useProjection']
    const { container } = render(<CanvasView {...makeProps({ useProjection })} />)
    expect(container.querySelector('[data-canvas-outline]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /大纲/ }))
    expect(container.querySelector('[data-canvas-outline]')).toBeNull()
  })

  it('pans by the gesture delta from the drag origin without accumulating', () => {
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const { container } = render(<CanvasView {...makeProps({ useProjection })} />)
    const viewport = container.querySelector('[data-canvas-viewport]') as HTMLElement
    const layer = container.querySelector('[data-canvas-layer]') as HTMLElement
    expect(layer.style.transform).toBe('translate(0px, 0px) scale(1)')
    fireEvent.pointerDown(viewport, { clientX: 10, clientY: 10 })
    fireEvent.pointerMove(viewport, { clientX: 110, clientY: 70 })
    expect(layer.style.transform).toBe('translate(100px, 60px) scale(1)')
    fireEvent.pointerUp(viewport)
  })

  it('inspector pointer events do not trigger canvas pan gestures', () => {
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const { container } = render(<CanvasView {...makeProps({ useProjection })} />)
    fireEvent.click(rootCard(1))
    const layer = container.querySelector('[data-canvas-layer]') as HTMLElement
    const inspector = container.querySelector('[data-canvas-inspector]') as HTMLElement
    fireEvent.pointerDown(inspector, { clientX: 100, clientY: 100 })
    fireEvent.pointerMove(inspector, { clientX: 300, clientY: 300 })
    fireEvent.pointerUp(inspector)
    expect(layer.style.transform).toBe('translate(0px, 0px) scale(1)')
  })

  it('places many roots in rows instead of one long row', () => {
    const nodes = Array.from({ length: 6 }, (_, index) => node(index + 1))
    const useProjection = (() => projection(nodes)) as unknown as CanvasViewProps['useProjection']
    render(<CanvasView {...makeProps({ useProjection })} />)
    const firstY = Number(rootCard(1).closest('g')?.querySelector('rect')?.getAttribute('y'))
    const sixthY = Number(rootCard(6).closest('g')?.querySelector('rect')?.getAttribute('y'))
    // 6 roots at 5 per row: the sixth lands on the second row.
    expect(sixthY).toBeGreaterThan(firstY)
  })

  it('outline recurses: a fork session hangs under the node it forked from', async () => {
    const useProjection = (() => projection([])) as unknown as CanvasViewProps['useProjection']
    const tree: CanvasTreeView = {
      root: {
        sessionId: 'trunk-session',
        nodes: [node(1)],
        children: [{
          sessionId: 'child-session',
          parentSessionId: 'trunk-session',
          // Fork boundary = trunk node(1).endSeq (14), so seedLength = 15.
          seedLength: 15,
          nodes: [node(1)],
          children: [],
        }],
      },
      sessionCount: 2,
      nodeCount: 2,
    }
    const actions = makeActions({
      loadTree: vi.fn<CanvasViewRemoteActions['loadTree']>(async () => ({ ok: true, value: tree })),
    })
    const { container } = render(<CanvasView {...makeProps({ useProjection, actions })} />)
    // Wait for the loaded tree to reach the outline (trunk + fork rows).
    await screen.findAllByText('输出内容 1')
    const outline = container.querySelector('[data-canvas-outline]') as HTMLElement
    // Trunk at depth 0, its fork child nested at depth 1.
    expect(outline.querySelector('[data-depth="0"]')).toBeTruthy()
    expect(outline.querySelector('[data-depth="1"]')).toBeTruthy()
  })

  it('outline groups roots and branches; a branch subtree collapses and expands', async () => {
    const useProjection = (() => projection([])) as unknown as CanvasViewProps['useProjection']
    const tree: CanvasTreeView = {
      root: {
        sessionId: 'trunk-session',
        nodes: [node(1)],
        children: [{
          sessionId: 'child-session',
          parentSessionId: 'trunk-session',
          seedLength: 15,
          nodes: [node(1)],
          children: [{
            sessionId: 'grandchild-session',
            parentSessionId: 'child-session',
            seedLength: 15,
            nodes: [node(1)],
            children: [],
          }],
        }],
      },
      sessionCount: 3,
      nodeCount: 3,
    }
    const actions = makeActions({
      loadTree: vi.fn<CanvasViewRemoteActions['loadTree']>(async () => ({ ok: true, value: tree })),
    })
    const { container } = render(<CanvasView {...makeProps({ useProjection, actions })} />)
    await screen.findAllByText('输出内容 1')
    const outline = container.querySelector('[data-canvas-outline]') as HTMLElement
    // Roots and branches render as two groups; depth 2 grandchild nested under
    // the branch session at depth 2.
    expect(outline.querySelector('[data-outline-group="roots"] [data-depth="0"]')).toBeTruthy()
    expect(outline.querySelector('[data-outline-group="branches"] [data-depth="1"]')).toBeTruthy()
    expect(outline.querySelector('[data-depth="2"]')).toBeTruthy()
    // Collapse the branch subtree (the branch node's twisty hides its children).
    fireEvent.click(screen.getByRole('button', { name: '折叠' }))
    expect(outline.querySelector('[data-depth="2"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '展开' }))
    expect(outline.querySelector('[data-depth="2"]')).toBeTruthy()
  })

  it('search highlights matches and clicking one pans the canvas to it', async () => {
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const { container } = render(<CanvasView {...makeProps({ useProjection })} />)
    const input = container.querySelector('[data-canvas-outline] input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '输出内容' } })
    const matched = container.querySelector('[data-canvas-outline] [data-matched]') as Element
    expect(matched).toBeTruthy()
    fireEvent.click(matched)
    // The node card pans to center over a short tween: trunk node(1) sits at
    // (40, 40), card 200x84, viewport 0x0 → settles at translate(-140, -82).
    const layer = container.querySelector('[data-canvas-layer]') as HTMLElement
    await vi.waitFor(() => {
      expect(layer.style.transform).toBe('translate(-140px, -82px) scale(1)')
    })
  })

  it('shows a corner badge for pending suggestions and opens the review pane', () => {
    const useProjection = (() => projection([node(1)], [
      { batchSeq: 7, index: 0, title: '设计数据模型', detail: '表结构与索引' },
      { batchSeq: 7, index: 1, title: '实现 API 路由' },
    ])) as unknown as CanvasViewProps['useProjection']
    render(<CanvasView {...makeProps({ useProjection })} />)
    expect(screen.getByText(/2 条任务建议/)).toBeTruthy()
    fireEvent.click(screen.getByText(/2 条任务建议/))
    expect(screen.getByText(/任务建议（2）/)).toBeTruthy()
    expect(screen.getByText('表结构与索引')).toBeTruthy()
    expect(screen.getByDisplayValue('设计数据模型')).toBeTruthy()
  })

  it('adopting a suggestion sends its prompt and records the adoption', async () => {
    const useProjection = (() => projection([node(1)], [
      { batchSeq: 7, index: 0, title: '设计数据模型' },
    ])) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    const sendPrompt = vi.fn<CanvasViewProps['sendPrompt']>(async () => {})
    render(<CanvasView {...makeProps({ useProjection, actions, sendPrompt })} />)
    fireEvent.click(screen.getByText(/1 条任务建议/))
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await vi.waitFor(() => {
      expect(sendPrompt).toHaveBeenCalledWith('session-1', '设计数据模型')
      expect(actions.adoptSuggestion).toHaveBeenCalledWith('session-1', 7, 0)
    })
  })

  it('edits a suggestion title before adopting; removal drops it without a prompt', async () => {
    const useProjection = (() => projection([node(1)], [
      { batchSeq: 7, index: 0, title: '旧标题' },
      { batchSeq: 7, index: 1, title: '不要这条' },
    ])) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    const sendPrompt = vi.fn<CanvasViewProps['sendPrompt']>(async () => {})
    render(<CanvasView {...makeProps({ useProjection, actions, sendPrompt })} />)
    fireEvent.click(screen.getByText(/2 条任务建议/))
    // Edit the first suggestion's title, then confirm it.
    fireEvent.change(screen.getByDisplayValue('旧标题'), { target: { value: '新标题' } })
    fireEvent.click(screen.getAllByRole('button', { name: '确认' })[0]!)
    await vi.waitFor(() => {
      expect(sendPrompt).toHaveBeenCalledWith('session-1', '新标题')
    })
    // Remove the remaining suggestion: no prompt, only the removal record.
    fireEvent.click(screen.getAllByRole('button', { name: '删除' }).at(-1)!)
    await vi.waitFor(() => {
      expect(sendPrompt).toHaveBeenCalledTimes(1)
      expect(actions.removeSuggestion).toHaveBeenCalledWith('session-1', 7, 1)
    })
  })

  it('adopt-all sends every suggestion as a root task in order', async () => {
    const useProjection = (() => projection([node(1)], [
      { batchSeq: 7, index: 0, title: '任务甲' },
      { batchSeq: 7, index: 1, title: '任务乙' },
    ])) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    const sendPrompt = vi.fn<CanvasViewProps['sendPrompt']>(async () => {})
    render(<CanvasView {...makeProps({ useProjection, actions, sendPrompt })} />)
    fireEvent.click(screen.getByText(/2 条任务建议/))
    fireEvent.click(screen.getByRole('button', { name: /全部确认/ }))
    await vi.waitFor(() => {
      expect(sendPrompt.mock.calls.map(call => call[1])).toEqual(['任务甲', '任务乙'])
      expect(actions.adoptSuggestion).toHaveBeenCalledTimes(2)
    })
  })

  it('merging selected suggestions sends one combined prompt and removes them all', async () => {
    const useProjection = (() => projection([node(1)], [
      { batchSeq: 7, index: 0, title: '任务甲' },
      { batchSeq: 7, index: 1, title: '任务乙' },
    ])) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    const sendPrompt = vi.fn<CanvasViewProps['sendPrompt']>(async () => {})
    render(<CanvasView {...makeProps({ useProjection, actions, sendPrompt })} />)
    fireEvent.click(screen.getByText(/2 条任务建议/))
    // Select both suggestions, then merge.
    const checkboxes = screen.getAllByRole('checkbox')
    fireEvent.click(checkboxes[0]!)
    fireEvent.click(checkboxes[1]!)
    fireEvent.click(screen.getByRole('button', { name: /合并选中（2）/ }))
    await vi.waitFor(() => {
      expect(sendPrompt).toHaveBeenCalledWith('session-1', '任务甲（另含：任务乙）')
      expect(actions.removeSuggestion).toHaveBeenCalledTimes(2)
    })
  })

  it('the canvas tools bar fits the view and zooms', () => {
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const { container } = render(<CanvasView {...makeProps({ useProjection })} />)
    const tools = container.querySelector('[data-canvas-tools]') as HTMLElement
    expect(tools).toBeTruthy()
    // Fit and zoom buttons exist and are clickable (a zero-size viewport
    // makes fit a no-op, which is the safe behavior in tests).
    fireEvent.click(screen.getByRole('button', { name: /适应/ }))
    fireEvent.click(screen.getByRole('button', { name: /100%/ }))
    const layer = container.querySelector('[data-canvas-layer]') as HTMLElement
    expect(layer.style.transform).toMatch(/scale\(1(\.0+)?\)/)
  })

  it('Shift+drag box-selects nodes and the batch bar removes them', async () => {
    const useProjection = (() => projection([node(1), node(2)])) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    const { container } = render(<CanvasView {...makeProps({ useProjection, actions })} />)
    const viewport = container.querySelector('[data-canvas-viewport]') as HTMLElement
    // Box-select over the whole canvas (Shift+drag empty space).
    fireEvent.pointerDown(viewport, { clientX: 0, clientY: 0, shiftKey: true })
    fireEvent.pointerMove(viewport, { clientX: 600, clientY: 400, shiftKey: true })
    fireEvent.pointerUp(viewport)
    expect(screen.getByText(/已选 2 个节点/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '批量删除' }))
    await vi.waitFor(() => {
      expect(actions.removeNode).toHaveBeenCalledTimes(2)
    })
  })

  it('renders fork connectors from parent to child session', async () => {
    // The trunk node comes live from the projection; the child from the tree.
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const tree: CanvasTreeView = {
      root: {
        sessionId: 'session-1',
        nodes: [],
        children: [{
          sessionId: 'child-session',
          parentSessionId: 'session-1',
          seedLength: 15,
          nodes: [node(1)],
          children: [],
        }],
      },
      sessionCount: 2,
      nodeCount: 1,
    }
    const actions = makeActions({
      loadTree: vi.fn<CanvasViewRemoteActions['loadTree']>(async () => ({ ok: true, value: tree })),
    })
    const { container } = render(<CanvasView {...makeProps({ useProjection, actions })} />)
    await screen.findAllByText('输出内容 1')
    // The fork connector path exists between the trunk node and the child.
    expect(container.querySelector('path[d^="M "]')).toBeTruthy()
  })

  it('shows a workflow badge and adopting sends every node as a root task', async () => {
    const useProjection = (() => projection([node(1)], [], {
      batchSeq: 7,
      nodes: [
        { id: 'research', title: '调研需求', detail: '访谈与竞品' },
        { id: 'build', title: '实现' },
      ],
      edges: [{ from: 'research', to: 'build' }],
    })) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    const sendPrompt = vi.fn<CanvasViewProps['sendPrompt']>(async () => {})
    render(<CanvasView {...makeProps({ useProjection, actions, sendPrompt })} />)
    expect(screen.getByText(/2 步工作流/)).toBeTruthy()
    fireEvent.click(screen.getByText(/2 步工作流/))
    expect(screen.getByText(/工作流（2 步）/)).toBeTruthy()
    expect(screen.getByText('调研需求')).toBeTruthy()
    expect(screen.getByText('依赖它：实现')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /确认工作流/ }))
    await vi.waitFor(() => {
      // Adopt records the decision; the plan drives execution (tested
      // separately with a plan in the projection).
      expect(actions.adoptWorkflow).toHaveBeenCalledWith('session-1', 7)
      expect(sendPrompt).not.toHaveBeenCalled()
    })
  })

  it('dismissing the workflow removes it without sending prompts', async () => {
    const useProjection = (() => projection([node(1)], [], {
      batchSeq: 7,
      nodes: [{ id: 'a', title: '任务甲' }],
      edges: [],
    })) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    const sendPrompt = vi.fn<CanvasViewProps['sendPrompt']>(async () => {})
    render(<CanvasView {...makeProps({ useProjection, actions, sendPrompt })} />)
    fireEvent.click(screen.getByText(/1 步工作流/))
    fireEvent.click(screen.getByRole('button', { name: '放弃' }))
    await vi.waitFor(() => {
      expect(actions.removeWorkflow).toHaveBeenCalledWith('session-1', 7)
      expect(sendPrompt).not.toHaveBeenCalled()
    })
  })

  it('executes a plan in dependency order: a step waits for its dependency', async () => {
    // Neither node is realized; 'build' depends on 'research', so neither
    // sends until research completes.
    const useProjection = (() => projection([], [], undefined, {
      batchSeq: 7,
      nodes: [
        { id: 'research', title: '调研需求' },
        { id: 'build', title: '实现' },
      ],
      edges: [{ from: 'research', to: 'build' }],
    })) as unknown as CanvasViewProps['useProjection']
    const sendPrompt = vi.fn<CanvasViewProps['sendPrompt']>(async () => {})
    render(<CanvasView {...makeProps({ useProjection, sendPrompt })} />)
    // Both placeholders render; research is ready (no deps) and sends, build
    // waits on research so only research goes out.
    await vi.waitFor(() => {
      expect(sendPrompt.mock.calls.map(call => call[1])).toEqual(['调研需求'])
    })
  })

  it('scheduling a workflow tells the agent to register a timed run', async () => {
    const useProjection = (() => projection([node(1)], [], {
      batchSeq: 7,
      nodes: [
        { id: 'research', title: '调研需求' },
        { id: 'build', title: '实现' },
      ],
      edges: [{ from: 'research', to: 'build' }],
    })) as unknown as CanvasViewProps['useProjection']
    const sendPrompt = vi.fn<CanvasViewProps['sendPrompt']>(async () => {})
    render(<CanvasView {...makeProps({ useProjection, sendPrompt })} />)
    fireEvent.click(screen.getByText(/2 步工作流/))
    fireEvent.change(screen.getByPlaceholderText(/定时执行描述/), { target: { value: '每天早上 9 点' } })
    fireEvent.click(screen.getByRole('button', { name: /设置定时/ }))
    await vi.waitFor(() => {
      const text = sendPrompt.mock.calls[0]?.[1] ?? ''
      expect(text).toContain('每天早上 9 点')
      expect(text).toContain('schedule_create')
      expect(text).toContain('调研需求 → 实现')
    })
  })

  it('reruns an adopted plan from the toolbar badge', async () => {
    const useProjection = (() => projection([], [], undefined, {
      batchSeq: 7,
      nodes: [{ id: 'a', title: '任务甲' }],
      edges: [],
    })) as unknown as CanvasViewProps['useProjection']
    const sendPrompt = vi.fn<CanvasViewProps['sendPrompt']>(async () => {})
    const { container } = render(<CanvasView {...makeProps({ useProjection, sendPrompt })} />)
    // First run sends the step.
    await vi.waitFor(() => {
      expect(sendPrompt.mock.calls.map(call => call[1])).toEqual(['任务甲'])
    })
    // Rerun resets the sent-set and re-sends the ready step.
    const rerun = container.querySelector('[data-canvas-workflow-rerun]') as HTMLElement
    expect(rerun).toBeTruthy()
    fireEvent.click(rerun)
    await vi.waitFor(() => {
      expect(sendPrompt.mock.calls.map(call => call[1])).toEqual(['任务甲', '任务甲'])
    })
  })

  it('a step declaring input waits, slides the rail open, and submits with the user value', async () => {
    const useProjection = (() => projection([], [], undefined, {
      batchSeq: 7,
      nodes: [
        { id: 'topic', title: '确定今日主题', input: true },
        { id: 'make', title: '生成内容' },
      ],
      edges: [{ from: 'topic', to: 'make' }],
    })) as unknown as CanvasViewProps['useProjection']
    const sendPrompt = vi.fn<CanvasViewProps['sendPrompt']>(async () => {})
    render(<CanvasView {...makeProps({ useProjection, sendPrompt })} />)
    // The waiting banner appears; nothing sends until the user supplies input.
    await screen.findByText(/工作流等待你的输入/)
    expect(screen.getAllByText(/确定今日主题/).length).toBeGreaterThan(0)
    expect(sendPrompt).not.toHaveBeenCalled()
    // Submit the per-run input: the step runs with the user value appended.
    fireEvent.change(screen.getByPlaceholderText(/输入今日主题/), { target: { value: 'AI 绘图' } })
    fireEvent.click(screen.getByRole('button', { name: /提交并继续/ }))
    await vi.waitFor(() => {
      expect(sendPrompt.mock.calls.map(call => call[1])).toEqual(['确定今日主题（用户输入：AI 绘图）'])
    })
  })

  it('shows realized workflow outputs and opens a result for modification', async () => {
    // The plan step is already realized: a real root carries its prompt.
    const madeNode = { ...node(1), prompt: '生成日报', produced: ['out/daily.md'] }
    const useProjection = (() => projection([madeNode], [], undefined, {
      batchSeq: 7,
      nodes: [{ id: 'make', title: '生成日报' }],
      edges: [],
    })) as unknown as CanvasViewProps['useProjection']
    const { container } = render(<CanvasView {...makeProps({ useProjection })} />)
    const resultsBadge = container.querySelector('[data-canvas-workflow-results]') as HTMLElement
    expect(resultsBadge).toBeTruthy()
    fireEvent.click(resultsBadge)
    expect(screen.getByText(/工作流产物/)).toBeTruthy()
    expect(screen.getAllByText(/生成日报/).length).toBeGreaterThan(0)
    // Opening a result selects the node (the rail then allows modifying it).
    const resultItem = container.querySelector('[data-workflow-result]') as HTMLElement
    fireEvent.click(resultItem)
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy()
  })

  it('marks the document title while a step waits for input (cross-tab backstop)', async () => {
    const useProjection = (() => projection([], [], undefined, {
      batchSeq: 7,
      nodes: [{ id: 'topic', title: '确定今日主题', input: true }],
      edges: [],
    })) as unknown as CanvasViewProps['useProjection']
    render(<CanvasView {...makeProps({ useProjection })} />)
    await screen.findByText(/工作流等待你的输入/)
    expect(document.title).toContain('等待输入')
    expect(document.title).toContain('确定今日主题')
  })
})
