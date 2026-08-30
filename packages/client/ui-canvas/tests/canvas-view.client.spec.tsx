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
    moveNode: vi.fn<CanvasViewRemoteActions['moveNode']>(async () => ({ ok: true, value: undefined })),
    ...over,
  }
}

function makeProps(over: Partial<CanvasViewProps> = {}): CanvasViewProps {
  return {
    sessionId: 'session-1' as CanvasViewProps['sessionId'],
    useProjection: (() => undefined) as unknown as CanvasViewProps['useProjection'],
    useSessions: (() => ({ byId: {} })) as unknown as CanvasViewProps['useSessions'],
    useSession: ((selector: (s: unknown) => unknown) =>
      selector({ chat: { order: [], nodes: new Map() } })) as unknown as CanvasViewProps['useSession'],
    renderChatNode: ((_key: string, _owner: object, opts?: { fallback?: React.ReactNode }) =>
      opts?.fallback ?? null) as unknown as CanvasViewProps['renderChatNode'],
    loadImage: vi.fn(async () => 'data:image/png;base64,'),
    forkAt: vi.fn(),
    actions: makeActions(),
    openFile: vi.fn(),
    sendPrompt: vi.fn<CanvasViewProps['sendPrompt']>(async () => {}),
    setComposerTarget: vi.fn<CanvasViewProps['setComposerTarget']>(),
    setRailTarget: vi.fn<CanvasViewProps['setRailTarget']>(),
    forkToRail: vi.fn<CanvasViewProps['forkToRail']>(async () => {}),
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

  it('renders adopted plan placeholder cards even on an empty canvas', () => {
    // A fresh session with no realized output adopts a plan: the placeholder
    // cards must render (queued), not be hidden behind the empty hint.
    const useProjection = (() => projection([], [], undefined, {
      batchSeq: 7,
      nodes: [
        { id: 'research', title: '调研需求' },
        { id: 'build', title: '实现' },
      ],
      edges: [{ from: 'research', to: 'build' }],
    })) as unknown as CanvasViewProps['useProjection']
    const { container } = render(<CanvasView {...makeProps({ useProjection })} />)
    expect(screen.getAllByText(/调研需求/).length).toBeGreaterThan(0)
    expect(screen.getAllByText(/实现/).length).toBeGreaterThan(0)
    // The canvas empty hint must not show while a plan is on the canvas (the
    // outline's own "暂无节点" fold note may still show — it lists real
    // roots only, not plan placeholders).
    expect(container.querySelector('[data-canvas-empty]')).toBeNull()
  })

  it('clicking a plan placeholder card targets the composer at that step', () => {
    const useProjection = (() => projection([], [], undefined, {
      batchSeq: 7,
      nodes: [{ id: 'a', title: '任务甲' }],
      edges: [],
    })) as unknown as CanvasViewProps['useProjection']
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    render(<CanvasView {...makeProps({ useProjection, setComposerTarget })} />)
    fireEvent.click(screen.getAllByText(/任务甲/).at(-1)!)
    // The composer targets the step: the user's message becomes that step's
    // refinement (sent as `<title>：<message>` upstream).
    expect(setComposerTarget).toHaveBeenLastCalledWith({
      kind: 'plan-step',
      sessionId: 'session-1',
      title: '任务甲',
    })
  })

  it('clicking a plan card then a root card switches selection back', () => {
    const useProjection = (() => projection([node(1)], [], undefined, {
      batchSeq: 7,
      nodes: [{ id: 'a', title: '任务甲' }],
      edges: [],
    })) as unknown as CanvasViewProps['useProjection']
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    render(<CanvasView {...makeProps({ useProjection, setComposerTarget })} />)
    // Click the plan placeholder card first: the composer targets the step.
    fireEvent.click(screen.getAllByText(/任务甲/).at(-1)!)
    expect(setComposerTarget).toHaveBeenLastCalledWith({
      kind: 'plan-step', sessionId: 'session-1', title: '任务甲',
    })
    // Click the root card: a single root is the last — the overall conversation.
    fireEvent.click(rootCard(1))
    expect(setComposerTarget).toHaveBeenLastCalledWith({ kind: 'session', sessionId: 'session-1' })
  })

  it('surfaces a pending question on the canvas and submits the answer', async () => {
    let snap: unknown = { pending: [], chat: { order: [], nodes: new Map() } }
    const useSession = ((selector: (s: unknown) => unknown) =>
      selector(snap)) as unknown as CanvasViewProps['useSession']
    const props = makeProps({ useSession })
    const view = render(<CanvasView {...props} />)
    expect(view.container.querySelector('[data-canvas-question]')).toBeNull()
    // A question takeover arrives: the canvas must show it (the bottom
    // composer seat is hidden while the canvas tab is active).
    const respond = vi.fn(async () => ({ accepted: true as const, reason: '' }))
    snap = {
      chat: { order: [], nodes: new Map() },
      pending: [{
        kind: 'question',
        key: 'q1',
        sessionId: 'session-1',
        payload: {
          questions: [
            { id: 'a', question: '按哪个方案推进？', options: [{ label: '方案一' }, { label: '方案二' }] },
          ],
        },
        respond,
      }],
    }
    view.rerender(<CanvasView {...props} />)
    await screen.findByText(/Agent 需要确认/)
    expect(screen.getByText('按哪个方案推进？')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '方案一' }))
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith({
        ok: true,
        value: {
          sessionId: 'session-1',
          answer: { answers: [{ id: 'a', selected: ['方案一'] }] },
        },
      })
    })
  })

  it('surfaces a pending approval on the canvas and answers it', async () => {
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const respond = vi.fn(() => Promise.resolve({ accepted: true }))
    const pending = [{
      kind: 'approval' as const,
      key: 'a:1',
      sessionId: 'session-1' as never,
      payload: { approvalId: 'ap-1', toolName: 'rm', reason: '删除危险文件' },
      respond,
    }]
    const useSession = ((selector: (s: unknown) => unknown) =>
      selector({ chat: { order: [], nodes: new Map() }, pending })) as unknown as CanvasViewProps['useSession']
    render(<CanvasView {...makeProps({ useProjection, useSession })} />)
    expect(screen.getByText(/等待审批/)).toBeTruthy()
    expect(screen.getByText('删除危险文件')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '允许一次' }))
    await vi.waitFor(() => {
      expect(respond).toHaveBeenCalledWith({
        ok: true,
        value: { sessionId: 'session-1', approvalId: 'ap-1', outcome: 'allowed-once' },
      })
    })
    fireEvent.click(screen.getByRole('button', { name: '拒绝' }))
    await vi.waitFor(() => {
      expect(respond).toHaveBeenLastCalledWith({
        ok: true,
        value: { sessionId: 'session-1', approvalId: 'ap-1', outcome: 'rejected' },
      })
    })
  })

  it('renders roots as index cards with badges', () => {
    const useProjection = (() => projection([node(1), node(2)])) as unknown as CanvasViewProps['useProjection']
    render(<CanvasView {...makeProps({ useProjection })} />)
    expect(rootCard(1)).toBeTruthy()
    expect(rootCard(2)).toBeTruthy()
    expect(screen.getByText(/2 节点/).textContent).toContain('2 节点')
  })

  it('clicking a node keeps one canvas: composer continues the session', () => {
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    render(<CanvasView {...makeProps({ useProjection, setComposerTarget })} />)
    fireEvent.click(rootCard(1))
    expect(setComposerTarget).toHaveBeenLastCalledWith({ kind: 'session', sessionId: 'session-1' })
  })

  it('a waiting step does not steal the selection after the rail opened on it', async () => {
    const useProjection = (() => projection([node(1)], [], undefined, {
      batchSeq: 7,
      nodes: [{ id: 'topic', title: '确定今日主题', input: true }],
      edges: [],
    })) as unknown as CanvasViewProps['useProjection']
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    render(<CanvasView {...makeProps({ useProjection, setComposerTarget })} />)
    // The waiting step auto-selects once (input backstop) and the rail opens.
    await screen.findByText(/工作流等待你的输入/)
    expect(setComposerTarget).toHaveBeenLastCalledWith({
      kind: 'plan-step', sessionId: 'session-1', title: '确定今日主题',
    })
    // The user clicks the root card: a single root is the last — the overall
    // conversation (the waiting-step effect must not steal the selection).
    fireEvent.click(rootCard(1))
    expect(setComposerTarget).toHaveBeenLastCalledWith({ kind: 'session', sessionId: 'session-1' })
  })

  it('switching sessions resets per-session view state and the composer target', () => {
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    const props = makeProps({ useProjection, setComposerTarget })
    const view = render(<CanvasView {...props} />)
    // Clicking the root: a single root is the last — the overall conversation.
    fireEvent.click(rootCard(1))
    expect(setComposerTarget).toHaveBeenLastCalledWith({ kind: 'session', sessionId: 'session-1' })
    // Collapse the right rail, then switch sessions: the collapsed rail must
    // not leak over.
    fireEvent.click(screen.getByRole('button', { name: /右栏/ }))
    view.rerender(<CanvasView {...props} sessionId={'session-2' as CanvasViewProps['sessionId']} />)
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
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    render(<CanvasView {...makeProps({ useProjection, actions, setComposerTarget })} />)
    fireEvent.click(await screen.findByText(/⎇ #1/))
    // One canvas = one session: even a branch node stays in its session.
    expect(setComposerTarget).toHaveBeenLastCalledWith({
      kind: 'session', sessionId: 'grandchild-session',
    })
  })

  it('clicking a node keeps one canvas: composer continues the session, rail locates the message', () => {
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    const setRailTarget = vi.fn<CanvasViewProps['setRailTarget']>()
    render(<CanvasView {...makeProps({ useProjection, setComposerTarget, setRailTarget })} />)
    fireEvent.click(rootCard(1))
    // One canvas = one session: composer continues, nothing new is created,
    // and the rail points at the node's own conversation (no workspace switch).
    expect(setComposerTarget).toHaveBeenLastCalledWith({ kind: 'session', sessionId: 'session-1' })
    expect(setRailTarget).toHaveBeenLastCalledWith('session-1')
  })

  it('clicking a mid node forks it into the rail without switching the workspace', async () => {
    // Two roots: clicking the older (non-last) node must fork, not switch.
    const useProjection = (() => projection([node(1), node(2)])) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    const setRailTarget = vi.fn<CanvasViewProps['setRailTarget']>()
    const forkToRail = vi.fn<CanvasViewProps['forkToRail']>(async () => undefined)
    render(<CanvasView {...makeProps({ useProjection, actions, setComposerTarget, setRailTarget, forkToRail })} />)
    await vi.waitFor(() => { expect(actions.loadTree).toHaveBeenCalledTimes(1) })
    fireEvent.click(rootCard(1))
    // The node IS the branch button: fork it into the rail — the canvas and
    // the workspace selection never move (no composer session target, no rail
    // switch to the source session before the fork lands; the mount reset
    // already cleared the rail once).
    expect(forkToRail).toHaveBeenCalledWith('session-1', 1)
    expect(setComposerTarget).not.toHaveBeenCalledWith({ kind: 'session', sessionId: 'session-1' })
    expect(setRailTarget).not.toHaveBeenCalledWith('session-1')
    // The fork settled: the tree reloads so the branch subtree appears under
    // the clicked node.
    await vi.waitFor(() => { expect(actions.loadTree).toHaveBeenCalledTimes(2) })
  })

  it('clicking the same mid node twice forks once, then only opens the branch', async () => {
    const useProjection = (() => projection([node(1), node(2)])) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions() // empty tree: the fork ledger alone carries the branch
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    const setRailTarget = vi.fn<CanvasViewProps['setRailTarget']>()
    const forkToRail = vi.fn<CanvasViewProps['forkToRail']>(async () => 'child-session' as never)
    render(<CanvasView {...makeProps({ useProjection, actions, setComposerTarget, setRailTarget, forkToRail })} />)
    await vi.waitFor(() => { expect(actions.loadTree).toHaveBeenCalledTimes(1) })
    fireEvent.click(rootCard(1))
    expect(forkToRail).toHaveBeenCalledTimes(1)
    // The fork settled and the ledger remembered node(1) → child-session.
    await vi.waitFor(() => { expect(actions.loadTree).toHaveBeenCalledTimes(2) })
    fireEvent.click(rootCard(1))
    // The second click only OPENS the existing branch — no second fork.
    expect(forkToRail).toHaveBeenCalledTimes(1)
    expect(setRailTarget).toHaveBeenLastCalledWith('child-session')
    expect(setComposerTarget).toHaveBeenLastCalledWith({ kind: 'session', sessionId: 'child-session' })
  })

  it('clicking a node with an existing branch (from the tree) only opens it, no second fork', async () => {
    const useProjection = (() => projection([node(1), node(2)])) as unknown as CanvasViewProps['useProjection']
    const tree: CanvasTreeView = {
      root: {
        sessionId: 'session-1',
        nodes: [node(1), node(2)],
        children: [{
          sessionId: 'child-session',
          parentSessionId: 'session-1',
          // Fork boundary = node(1).endSeq (14), so seedLength = 15.
          seedLength: 15,
          nodes: [node(1)],
          children: [],
        }],
      },
      sessionCount: 2,
      nodeCount: 3,
    }
    const actions = makeActions({
      loadTree: vi.fn<CanvasViewRemoteActions['loadTree']>(async () => ({ ok: true, value: tree })),
    })
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    const setRailTarget = vi.fn<CanvasViewProps['setRailTarget']>()
    const forkToRail = vi.fn<CanvasViewProps['forkToRail']>(async () => 'child-session' as never)
    render(<CanvasView {...makeProps({ useProjection, actions, setComposerTarget, setRailTarget, forkToRail })} />)
    // Wait for the loaded tree: the branch card (⎇ #1) hangs under node 1.
    await screen.findAllByText(/⎇ #1/)
    fireEvent.click(rootCard(1))
    // node(1) already has a branch under it: open it, do NOT fork again.
    expect(forkToRail).not.toHaveBeenCalled()
    expect(setRailTarget).toHaveBeenLastCalledWith('child-session')
    expect(setComposerTarget).toHaveBeenLastCalledWith({ kind: 'session', sessionId: 'child-session' })
  })

  it('reloads the tree when a fork child finishes a turn (new nodes under the node)', async () => {
    const useProjection = (() => projection([])) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    let byId: Record<string, { running: boolean }> = {}
    const useSessions = ((selector: (s: unknown) => unknown) =>
      selector({ byId })) as unknown as CanvasViewProps['useSessions']
    const { rerender } = render(<CanvasView {...makeProps({ useProjection, actions, useSessions })} />)
    await vi.waitFor(() => { expect(actions.loadTree).toHaveBeenCalledTimes(1) })
    // A fork child starts and finishes a turn (the rail's continued message):
    // the running true→false edge reloads the tree so the new node appears.
    byId = { 'child-session': { running: true } }
    rerender(<CanvasView {...makeProps({ useProjection, actions, useSessions })} />)
    byId = { 'child-session': { running: false } }
    rerender(<CanvasView {...makeProps({ useProjection, actions, useSessions })} />)
    await vi.waitFor(() => { expect(actions.loadTree).toHaveBeenCalledTimes(2) })
  })

  it('double-clicking empty canvas clears the composer and rail targets (new root)', () => {
    const useProjection = (() => projection([])) as unknown as CanvasViewProps['useProjection']
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    const setRailTarget = vi.fn<CanvasViewProps['setRailTarget']>()
    const { container } = render(<CanvasView {...makeProps({ useProjection, setComposerTarget, setRailTarget })} />)
    const viewport = container.querySelector('[data-canvas-viewport]') as HTMLElement
    fireEvent.doubleClick(viewport, { clientX: 300, clientY: 300 })
    expect(setComposerTarget).toHaveBeenLastCalledWith(null)
    expect(setRailTarget).toHaveBeenLastCalledWith(null)
  })

  it('a named node shows its title on the card and in the outline', () => {
    const namedNode = { ...node(1), title: '设计数据模型' }
    const useProjection = (() => projection([namedNode])) as unknown as CanvasViewProps['useProjection']
    render(<CanvasView {...makeProps({ useProjection })} />)
    // The title (not the bare number) is the card's identity.
    expect(screen.getAllByText('设计数据模型').length).toBeGreaterThan(0)
    fireEvent.click(rootCard(1))
    expect(screen.getAllByText('设计数据模型').length).toBeGreaterThan(0)
  })

  it('auto-names a node from its turn prompt (the task) the moment it renders', () => {
    const promptNode = { ...node(1), prompt: '设计画布节点的数据模型' }
    const useProjection = (() => projection([promptNode])) as unknown as CanvasViewProps['useProjection']
    render(<CanvasView {...makeProps({ useProjection })} />)
    // The card shows the task prompt — specific and user-recognizable.
    expect(screen.getAllByText('设计画布节点的数据模型').length).toBeGreaterThan(0)
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

  it('places a fork branch card under the node it forked from', async () => {
    // The branch hangs under trunk node(1) (seedLength 15 = node(1).endSeq 14
    // + 1): its card must sit below that node, not scatter to the first root.
    const useProjection = (() => projection([node(1), node(2)])) as unknown as CanvasViewProps['useProjection']
    const tree: CanvasTreeView = {
      root: {
        sessionId: 'session-1',
        nodes: [node(1), node(2)],
        children: [{
          sessionId: 'child-session',
          parentSessionId: 'session-1',
          seedLength: 15,
          nodes: [node(1)],
          children: [],
        }],
      },
      sessionCount: 2,
      nodeCount: 3,
    }
    const actions = makeActions({
      loadTree: vi.fn<CanvasViewRemoteActions['loadTree']>(async () => ({ ok: true, value: tree })),
    })
    render(<CanvasView {...makeProps({ useProjection, actions })} />)
    await screen.findAllByText(/⎇ #1/)
    const parent = rootCard(1).closest('g')?.querySelector('rect')
    const branch = screen.getAllByText(/⎇ #1/).at(-1)!.closest('g')?.querySelector('rect')
    expect(parent).toBeTruthy()
    expect(branch).toBeTruthy()
    // The branch card is below its fork parent (y grows by card + gap) and
    // offset to the right — under the node it forked from.
    expect(Number(branch?.getAttribute('y'))).toBeGreaterThan(Number(parent?.getAttribute('y')))
    expect(Number(branch?.getAttribute('x'))).toBeGreaterThan(Number(parent?.getAttribute('x')))
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

  it('embeds pending suggestions as a card in the conversation flow', () => {
    const useProjection = (() => projection([node(1)], [
      { batchSeq: 7, index: 0, title: '设计数据模型', detail: '表结构与索引' },
      { batchSeq: 7, index: 1, title: '实现 API 路由' },
    ])) as unknown as CanvasViewProps['useProjection']
    render(<CanvasView {...makeProps({ useProjection })} />)
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

  it('confirming a workflow calls adoptWorkflow and the projected plan renders placeholder cards', async () => {    // Full user flow: the proposal shows, confirm calls adoptWorkflow; the
    // host folds the adopt into a plan, and the canvas then renders the
    // placeholder cards (not hidden behind the empty hint).
    let proj = projection([], [], {
      batchSeq: 7,
      nodes: [
        { id: 'a', title: '任务甲' },
        { id: 'b', title: '任务乙' },
      ],
      edges: [],
    })
    const useProjection = (() => proj) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    const view = render(<CanvasView {...makeProps({ useProjection, actions })} />)
    expect(screen.getByText(/工作流（2 步）/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /确认工作流/ }))
    await vi.waitFor(() => {
      expect(actions.adoptWorkflow).toHaveBeenCalledWith('session-1', 7)
    })
    // The host folds the adopt: the proposal clears and the plan appears.
    proj = projection([], [], undefined, {
      batchSeq: 7,
      nodes: [
        { id: 'a', title: '任务甲' },
        { id: 'b', title: '任务乙' },
      ],
      edges: [],
    })
    view.rerender(<CanvasView {...makeProps({ useProjection, actions })} />)
    await vi.waitFor(() => {
      expect(screen.getAllByText(/任务甲/).length).toBeGreaterThan(0)
      expect(screen.getAllByText(/任务乙/).length).toBeGreaterThan(0)
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

  it('the card action bar removes, pins, and renames a node on the card', async () => {
    const useProjection = (() => projection([{ ...node(1), state: 'pending' }])) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    render(<CanvasView {...makeProps({ useProjection, actions })} />)
    // Selecting the card (or hovering it) shows the action bar. Trunk outputs
    // are auto-settled, so no confirm button — only pin/remove/rename.
    fireEvent.click(rootCard(1))
    expect(screen.queryByRole('button', { name: '确认' })).toBeNull()
    expect(screen.getByRole('button', { name: '固定' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '删除' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '命名' })).toBeTruthy()
    // Pin toggles the referenceable mark.
    fireEvent.click(screen.getByRole('button', { name: '固定' }))
    await vi.waitFor(() => {
      expect(actions.pinNode).toHaveBeenCalledWith('session-1', 1, 13)
    })
    // Rename opens the inline input and commits on Enter.
    fireEvent.click(screen.getByRole('button', { name: '命名' }))
    const input = screen.getByPlaceholderText(/节点名称/)
    fireEvent.change(input, { target: { value: '设计数据模型' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await vi.waitFor(() => {
      expect(actions.setNodeTitle).toHaveBeenCalledWith('session-1', 1, 13, '设计数据模型')
    })
    // Remove drops the node from the canvas.
    fireEvent.click(screen.getByRole('button', { name: '删除' }))
    await vi.waitFor(() => {
      expect(actions.removeNode).toHaveBeenCalledWith('session-1', 1)
    })
  })

  it('the card action bar offers confirm for a pending deeper node', async () => {
    const useProjection = (() => projection([])) as unknown as CanvasViewProps['useProjection']
    const tree: CanvasTreeView = {
      root: {
        sessionId: 'session-1',
        nodes: [],
        children: [{
          sessionId: 'child-session',
          parentSessionId: 'session-1',
          seedLength: 15,
          nodes: [],
          children: [{
            sessionId: 'grandchild-session',
            parentSessionId: 'child-session',
            seedLength: 15,
            nodes: [{ ...node(1), state: 'pending' }],
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
    const { container } = render(<CanvasView {...makeProps({ useProjection, actions })} />)
    await vi.waitFor(() => {
      expect(container.querySelector('[data-node="grandchild-session:1"]')).toBeTruthy()
    })
    const card = container.querySelector('[data-node="grandchild-session:1"]') as Element
    fireEvent.click(card)
    // A pending deeper node carries the confirm decision on its card.
    expect(screen.getByRole('button', { name: '确认' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认' }))
    await vi.waitFor(() => {
      expect(actions.confirmNode).toHaveBeenCalledWith('grandchild-session', 1, 13)
    })
  })

  it('dragging a card persists its position through moveNode', async () => {
    const useProjection = (() => projection([node(1)])) as unknown as CanvasViewProps['useProjection']
    const actions = makeActions()
    const { container } = render(<CanvasView {...makeProps({ useProjection, actions })} />)
    const viewport = container.querySelector('[data-canvas-viewport]') as HTMLElement
    // Pointer-down inside the card (canvas coords ~60,60), drag, release.
    fireEvent.pointerDown(rootCard(1), { clientX: 60, clientY: 60 })
    fireEvent.pointerMove(viewport, { clientX: 160, clientY: 100 })
    fireEvent.pointerUp(viewport)
    // The settled snapped position (40+100 → 140, 40+40 → 80) is persisted.
    await vi.waitFor(() => {
      expect(actions.moveNode).toHaveBeenCalledWith('session-1', 1, 140, 80)
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

  it('embeds the workflow proposal as a card and adopting sends every node as a root task', async () => {
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

  it('embeds realized workflow outputs as a card and opens a result for modification', async () => {
    // The plan step is already realized: a real root carries its prompt.
    const madeNode = { ...node(1), prompt: '生成日报', produced: ['out/daily.md'] }
    const useProjection = (() => projection([madeNode], [], undefined, {
      batchSeq: 7,
      nodes: [{ id: 'make', title: '生成日报' }],
      edges: [],
    })) as unknown as CanvasViewProps['useProjection']
    const setComposerTarget = vi.fn<CanvasViewProps['setComposerTarget']>()
    const { container } = render(<CanvasView {...makeProps({ useProjection, setComposerTarget })} />)
    expect(screen.getByText(/工作流产物/)).toBeTruthy()
    expect(screen.getAllByText(/生成日报/).length).toBeGreaterThan(0)
    // Opening a result: the realized node is the last root — the overall
    // conversation (the composer targets the session).
    const resultItem = container.querySelector('[data-workflow-result]') as HTMLElement
    expect(resultItem).toBeTruthy()
    fireEvent.click(resultItem)
    expect(setComposerTarget).toHaveBeenLastCalledWith({ kind: 'session', sessionId: 'session-1' })
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
