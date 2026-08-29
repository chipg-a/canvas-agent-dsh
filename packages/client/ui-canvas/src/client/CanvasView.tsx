/**
 * Canvas view: the session's canvas as a three-pane workspace.
 *
 * - LEFT OUTLINE (collapsible): the session's node tree (root → children),
 *   searchable and folded to a recent window — the structural navigation.
 * - CANVAS (center): fixed-size INDEX CARDS with state badges and structure
 *   lines only — draggable, zoomable, pannable. No full text, no inputs, no
 *   action buttons on the canvas itself.
 * - RIGHT INSPECTOR: the one home for content and input — selecting any node
 *   opens its detail (full output, artifacts, decisions) plus the node's
 *   input box (model/preset/permission), and the blank canvas opens the
 *   new-root composer.
 *
 * The canvas is a projection of the session log: nodes come from the
 * `canvasTree` projection (useProjection) plus the cross-session tree
 * (remote treeOf). Double-click empty canvas opens the new-root input;
 * clicking or double-clicking a node opens its detail + input. Typing in a
 * node's input forks it (DSH new-branch semantics) and sends the input as
 * the branch's first message, so the branch becomes the node's child on the
 * canvas.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ErrorInfo, type FunctionComponent, type ReactNode } from 'react'
import { Component } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ComposerSubmitTarget } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-client-runtime/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { IDENTITY_PANZOOM, hitTest, screenToCanvas, zoomAt, type PanZoom } from './canvas-interaction.ts'
import css from './CanvasView.module.css'

/** Card metrics (px), shared by layout and hit-testing. */
const CARD_W = 200
const CARD_H = 84
const CARD_GAP = 24

/** How many nodes stay visible on the canvas before older ones fold away. */
const RECENT_WINDOW = 30

/**
 * Canvas node JSON shape, as projected by the host canvasTree unit. The client
 * never imports the host projection package (its type declarations merge host
 * session modules and live in the host compile program); this local view type
 * mirrors the wire payload. Runtime data arrives through `useProjection`.
 */
export interface CanvasNodeView {
  /** Turn number this node represents. */
  turn: number
  /** Seq of the turn's first event. */
  startSeq: number
  /** Seq of the turn's closing event (inclusive fork boundary). */
  endSeq: number
  /** Seq of the assembled assistant/message. */
  outputSeq: number
  /** The output text/blocks. */
  output: { text: string; blocks: unknown[] }
  /** Node lifecycle state. */
  state: 'settled' | 'pending' | 'removed'
  /** Epoch ms of the output. */
  time: number
  /** Whether the user pinned this node's output. */
  pinned: boolean
  /** User-named canvas title; absent until the user names the node. */
  title?: string | undefined
  /** The user prompt this turn executed (the node's task). */
  prompt?: string | undefined
  /** Files this turn's tool calls produced, first-seen order. */
  produced?: string[] | undefined
}

/** One session's nodes plus its fork children, mirroring the host CanvasSessionNode. */
export interface CanvasSessionView {
  /** The session's id. */
  sessionId: string
  /** Fork parent's session id; undefined for the canvas root (trunk). */
  parentSessionId?: string | undefined
  /** Number of leading events inherited from the parent via fork. */
  seedLength?: number | undefined
  /** This session's canvas nodes, in turn order. */
  nodes: CanvasNodeView[]
  /** Direct fork children, each carrying its own subtree. */
  children: CanvasSessionView[]
}

/** The whole canvas tree as loaded from the host, mirroring the host CanvasTree. */
export interface CanvasTreeView {
  /** The trunk session (no fork parent). */
  root: CanvasSessionView
  /** Total sessions in the tree. */
  sessionCount: number
  /** Total canvas nodes across all sessions. */
  nodeCount: number
}

/** The per-session canvasTree projection as read through useProjection. */
export interface CanvasSessionProjection {
  /** Nodes in turn order; removed nodes are absent. */
  nodes: CanvasNodeView[]
  /** Pending task-decomposition suggestions, in proposal order. */
  suggestions: CanvasTaskSuggestionView[]
  /** Pending structured workflow proposal (nodes + dependency edges). */
  workflow?: CanvasWorkflowSuggestionView | undefined
  /** Adopted workflow execution plan (placeholder cards + dependency edges). */
  workflowPlan?: CanvasWorkflowPlanView | undefined
}

/**
 * One node of an adopted workflow execution plan.
 */
export interface CanvasWorkflowPlanNodeView {
  /** Stable id within the plan (referenced by edges). */
  id: string
  /** The task title — also the root-task prompt that realizes it. */
  title: string
  /** Optional one-line scope/constraint. */
  detail?: string | undefined
  /** Whether this step waits for user input before it runs. */
  input?: boolean | undefined
}

/**
 * The adopted workflow execution plan (mirrors the host CanvasWorkflowPlan):
 * durable plan nodes the canvas renders as placeholders (queued → running →
 * done) and a runner advances in dependency order.
 */
export interface CanvasWorkflowPlanView {
  /** Seq of the proposing `canvas/suggest-workflow` event. */
  batchSeq: number
  /** Plan nodes, in declaration order. */
  nodes: CanvasWorkflowPlanNodeView[]
  /** Dependency edges (`to` waits for `from`). */
  edges: CanvasWorkflowEdgeView[]
}

/**
 * One node of a pending structured workflow proposal.
 */
export interface CanvasWorkflowNodeView {
  /** Stable id within the proposal (referenced by edges). */
  id: string
  /** The task title (becomes the root-task prompt when adopted). */
  title: string
  /** Optional one-line scope/constraint. */
  detail?: string | undefined
  /** Whether this step waits for user input before it runs. */
  input?: boolean | undefined
}

/**
 * One dependency edge of a pending workflow proposal: `to` waits for `from`.
 */
export interface CanvasWorkflowEdgeView {
  /** Source node id. */
  from: string
  /** Target node id. */
  to: string
}

/**
 * A pending structured workflow (mirrors the host CanvasWorkflowSuggestion):
 * named nodes plus dependency edges, awaiting the user's confirm/remove
 * decision. Confirming pins each node as a root task.
 */
export interface CanvasWorkflowSuggestionView {
  /** Seq of the proposing `canvas/suggest-workflow` event (batch id). */
  batchSeq: number
  /** Proposed nodes, in declaration order. */
  nodes: CanvasWorkflowNodeView[]
  /** Proposed dependency edges (`to` waits for `from`). */
  edges: CanvasWorkflowEdgeView[]
}

/**
 * One pending task suggestion (mirrors the host CanvasTaskSuggestion): a root
 * task the agent proposed via `canvas_suggest_tasks`, awaiting the user's
 * adopt/remove decision. The user confirms it (it becomes a root task) or
 * removes it from the review list.
 */
export interface CanvasTaskSuggestionView {
  /** Seq of the proposing `canvas/suggest-tasks` event (batch id). */
  batchSeq: number
  /** Index within that batch, in proposal order. */
  index: number
  /** The proposed root-task title. */
  title: string
  /** Optional clarifying detail (constraints, scope, acceptance notes). */
  detail?: string | undefined
}

/** The canvasTree projection key, declared host-side; asserted for the client key union. */
const CANVAS_TREE_KEY = 'canvasTree' as Extract<keyof SessionProjectionMap, string>

/**
 * Remote canvas decision actions, wired at apply time so the component never
 * touches ctx.
 */
export interface CanvasViewRemoteActions {
  /** Load the whole canvas tree rooted at a session. */
  loadTree(trunkSessionId: SessionId): Promise<RemoteResult<CanvasTreeView>>
  /** Confirm a pending node's output onto the canvas. */
  confirmNode(sessionId: SessionId, turn: number, outputSeq: number): Promise<RemoteResult<void>>
  /** Pin a node's output as referenceable. */
  pinNode(sessionId: SessionId, turn: number, outputSeq: number): Promise<RemoteResult<void>>
  /** Remove a node from the canvas view. */
  removeNode(sessionId: SessionId, turn: number): Promise<RemoteResult<void>>
  /** Name a node (its canvas title). */
  setNodeTitle(sessionId: SessionId, turn: number, outputSeq: number, title: string): Promise<RemoteResult<void>>
  /** Adopt a pending task suggestion as a root task. */
  adoptSuggestion(sessionId: SessionId, batchSeq: number, index: number): Promise<RemoteResult<void>>
  /** Remove a pending task suggestion from the review list. */
  removeSuggestion(sessionId: SessionId, batchSeq: number, index: number): Promise<RemoteResult<void>>
  /** Adopt the pending structured workflow (each node becomes a root task). */
  adoptWorkflow(sessionId: SessionId, batchSeq: number): Promise<RemoteResult<void>>
  /** Remove the pending structured workflow proposal. */
  removeWorkflow(sessionId: SessionId, batchSeq: number): Promise<RemoteResult<void>>
  /**
   * Deepen into a node: fork a child session at its boundary, optionally on a
   * different executor route (model / agent preset / isolated cwd /
   * permission preset).
   */
  forkNode(sessionId: SessionId, turn: number, executor?: {
    model?: string
    agentPreset?: string
    cwd?: string
    permission?: string
  }): Promise<RemoteResult<SessionId>>
}

/** Injectable face: session id, remote actions, artifact opening, the prompt
 *  sender, and the composer submit-target router. */
export interface CanvasViewInjected {
  /** Session whose canvas tree this view shows. */
  sessionId: string
  /** Remote canvas decision actions (wired at apply time). */
  actions: CanvasViewRemoteActions
  /** Open a produced file through the host's workspace opener. */
  openFile: (path: string) => void
  /** Send a new prompt to the session (a new root node's task). */
  sendPrompt: (sessionId: string, text: string) => Promise<void>
  /**
   * Set the native composer's submit target: where the rail input goes when a
   * node is selected. `session` continues that session; `fork` forks the node
   * at its boundary and sends into the new branch; null clears back to the
   * session's own composer.
   */
  setComposerTarget: (target: ComposerSubmitTarget | null) => void
}

/** Composed view props: runtime standard props + inject face. */
export type CanvasViewProps = ConvViewProps & InjectFace<CanvasViewInjected>

/** One drawn node card with its (possibly user-moved) position. */
interface DrawnNode {
  key: string
  sessionId: string
  turn: number
  text: string
  state: 'settled' | 'pending' | 'removed'
  pinned: boolean
  produced: string[]
  outputSeq: number
  title: string | undefined
  prompt: string | undefined
  branch: boolean
  /** Whether the node's session is currently running a turn (live breathing dot). */
  running: boolean
  /** Workflow-plan node id; set for placeholder cards before their root exists. */
  planId?: string | undefined
  /** Fork depth: 0 = trunk (a root task), 1 = direct child, 2+ = grandchild. */
  depth: number
  /** Node index in the flat list (recent-window ordering). */
  order: number
  x: number
  y: number
}

/**
 * One outline entry: a node plus the fork sessions hanging under it. The
 * outline is the full cross-session tree (recursive), not the canvas' recent
 * window, so old nodes stay reachable and searchable.
 */
interface OutlineEntry {
  key: string
  sessionId: string
  turn: number
  title: string | undefined
  prompt: string | undefined
  text: string
  /** Fork depth: 0 = trunk, 1 = child, 2+ = grandchild. */
  depth: number
  /** Fork sessions' nodes attached under this node. */
  children: OutlineEntry[]
  /** This node matches the current search query. */
  matched: boolean
  /** Some descendant matches (search auto-expands these paths). */
  hasMatchedDescendant: boolean
}

/** The inspector pane state. */
type InspectorMode = 'closed' | 'detail' | 'suggest' | 'workflow' | 'results'

/** The display state of a node: trunk outputs and direct children are
 *  auto-confirmed; only grandchildren and deeper wait for confirmation. */
function displayStateOf(node: DrawnNode): 'settled' | 'pending' | 'removed' {
  return node.depth <= 1 ? 'settled' : node.state
}

/** Trailing path segment, the part that identifies a produced file at a glance. */
function basename(path: string): string {
  const at = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return at === -1 ? path : path.slice(at + 1)
}

/** State color for a node card border. */
function stateColor(state: DrawnNode['state'], running: boolean): string {
  if (running) return 'var(--dsw-static-blue-500, #3b82f6)'
  switch (state) {
    case 'settled': return 'var(--dsw-static-blue-400, #60a5fa)'
    case 'pending': return 'var(--dsw-static-amber-500, #f59e0b)'
    default: return 'var(--dsw-alias-text-tertiary, #94a3b8)'
  }
}

/**
 * Initial canvas placement: roots (depth 0) in rows, every deeper node
 * stacked under its root column.
 */
export function initialPlacement(nodes: readonly DrawnNode[], perRow = 5): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  const roots = nodes.filter(node => node.depth === 0)
  const rootX = (index: number): number => 40 + (index % perRow) * (CARD_W + CARD_GAP)
  const rootY = (index: number): number => 40 + Math.floor(index / perRow) * (CARD_H + CARD_GAP + 160)
  roots.forEach((root, index) => {
    positions.set(root.key, { x: rootX(index), y: rootY(index) })
  })
  // Children hang under their root column.
  for (const node of nodes) {
    if (node.depth === 0) continue
    const root = roots.find(candidate => node.key.startsWith(`${candidate.sessionId}:`)) ?? roots[0]
    if (root === undefined) continue
    const base = positions.get(root.key) ?? { x: 40, y: 40 }
    const siblingsBefore = nodes.filter(candidate =>
      candidate.sessionId === node.sessionId && candidate.depth === node.depth && candidate.order < node.order)
    const depthOffset = node.depth * 30
    positions.set(node.key, {
      x: base.x + depthOffset + 40,
      y: base.y + CARD_H + CARD_GAP + siblingsBefore.length * (CARD_H + CARD_GAP),
    })
  }
  return positions
}

/**
 * Render the session's canvas as a three-pane workspace.
 * @param props - slot runtime props plus the injected face.
 * @returns the canvas view element tree.
 */
export function CanvasView({
  useProjection,
  useSessions,
  sessionId: injectedSessionId,
  actions,
  openFile,
  sendPrompt,
  setComposerTarget,
  composerBar,
}: CanvasViewProps): React.JSX.Element {
  // Live running bits by session id (the sidebar source): a running session's
  // canvas nodes breathe on their cards until the turn closes.
  const runningBySession = useSessions(s => s.byId)
  const isRunning = (sessionId: string): boolean => runningBySession[sessionId as SessionId]?.running === true
  const [remoteTree, setRemoteTree] = useState<CanvasTreeView | undefined>(undefined)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const [inspector, setInspector] = useState<InspectorMode>('closed')
  const [outlineOpen, setOutlineOpen] = useState(true)
  /** Right rail (details + native composer) expanded/collapsed via the toolbar toggle. */
  const [railOpen, setRailOpen] = useState(true)
  const [search, setSearch] = useState('')
  /** Outline entries the user collapsed (hidden fork children). */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  /** Nodes the user revealed through the outline (kept on canvas). */
  const [revealed, setRevealed] = useState<Set<string>>(new Set())
  /** Edits to pending suggestion titles: `${batchSeq}:${index}` → new title. */
  const [suggestEdits, setSuggestEdits] = useState<Record<string, string>>({})
  /** Suggestions selected for merging: `${batchSeq}:${index}` keys. */
  const [suggestSelected, setSuggestSelected] = useState<Set<string>>(new Set())
  /** Node key whose card flashes after a locate (search/outline focus). */
  const [flashKey, setFlashKey] = useState<string | null>(null)
  /** Draft for the waiting-workflow-step input in the rail. */
  const [planInputDraft, setPlanInputDraft] = useState('')
  const viewportRef = useRef<HTMLDivElement | null>(null)
  /** Monotonic canvas bounds across renders (see svgBounds). */
  const svgBoundsRef = useRef<{ width: number; height: number } | undefined>(undefined)
  const sessionProjection = useProjection(CANVAS_TREE_KEY) as CanvasSessionProjection | undefined

  // Free-canvas state.
  const [panZoom, setPanZoom] = useState<PanZoom>(IDENTITY_PANZOOM)
  /** Latest panZoom, for tween reads (avoids stale-closure panning). */
  const panZoomRef = useRef<PanZoom>(IDENTITY_PANZOOM)
  panZoomRef.current = panZoom
  const [moved, setMoved] = useState<Map<string, { x: number; y: number }>>(new Map())
  /** Double-click spot for the NEXT new root (placed there when it appears). */
  const pendingRootPos = useRef<{ x: number; y: number } | null>(null)
  /** Nodes selected via box-select (Shift+drag); single selection lives in selectedKey. */
  const [multiSelected, setMultiSelected] = useState<Set<string>>(new Set())
  const [boxSelect, setBoxSelect] = useState<{ x: number; y: number; width: number; height: number } | null>(null)
  const dragRef = useRef<null
    | { kind: 'node'; key: string; startX: number; startY: number; originX: number; originY: number }
    | { kind: 'pan'; startX: number; startY: number; tx: number; ty: number }
    | { kind: 'select'; startX: number; startY: number; originX: number; originY: number }>(null)

  // Load the cross-session tree on mount and after a decision commits.
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let cancelled = false
    const sessionId = injectedSessionId as unknown as SessionId
    void actions.loadTree(sessionId).then(result => {
      if (cancelled) return
      setRemoteTree(loadedTree(result))
    }).catch(() => {
      if (!cancelled) setRemoteTree(undefined)
    })
    return () => { cancelled = true }
  }, [actions, injectedSessionId, reload])

  // Clear the composer submit target when the canvas unmounts, so a later
  // view (trajectory, another session) starts on the session's own composer.
  useEffect(() => () => { setComposerTarget(null) }, [setComposerTarget])

  // Reset per-session view state when the session changes (switching
  // workspaces opens a different session's canvas): node positions, viewport,
  // selection, the composer submit target, and the workflow sent-set must not
  // leak across sessions.
  useEffect(() => {
    setMoved(new Map())
    setPanZoom(IDENTITY_PANZOOM)
    setSelectedKey(null)
    setInspector('closed')
    setRevealed(new Set())
    setCollapsed(new Set())
    setMultiSelected(new Set())
    setSuggestSelected(new Set())
    setSuggestEdits({})
    setRerunTick(0)
    setFlashKey(null)
    setComposerTarget(null)
    setRailOpen(true)
    sentPlanRef.current = new Set()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectedSessionId])

  /** The adopted workflow execution plan (placeholder cards + edges). */
  const workflowPlan = sessionProjection?.workflowPlan

  // Flatten all drawn nodes: the trunk's projection nodes plus every branch
  // node from the loaded tree.
  const allNodes = useMemo<DrawnNode[]>(() => {
    const nodes: DrawnNode[] = []
    let order = 0
    for (const node of sessionProjection?.nodes ?? []) {
      nodes.push({
        key: `${injectedSessionId}:${String(node.turn)}`,
        sessionId: injectedSessionId,
        turn: node.turn,
        text: node.output.text,
        state: node.state,
        pinned: node.pinned,
        produced: node.produced ?? [],
        outputSeq: node.outputSeq,
        title: node.title,
        prompt: node.prompt,
        branch: false,
        running: isRunning(injectedSessionId),
        depth: 0,
        order,
        x: 0,
        y: 0,
      })
      order += 1
    }
    const walk = (session: CanvasSessionView, depth: number): void => {
      for (const node of session.nodes) {
        nodes.push({
          key: `${session.sessionId}:${String(node.turn)}`,
          sessionId: session.sessionId,
          turn: node.turn,
          text: node.output.text,
          state: node.state,
          pinned: node.pinned,
          produced: node.produced ?? [],
          outputSeq: node.outputSeq,
          title: node.title,
          prompt: node.prompt,
          branch: true,
          running: isRunning(session.sessionId),
          depth,
          order,
          x: 0,
          y: 0,
        })
        order += 1
      }
      for (const child of session.children) walk(child, depth + 1)
    }
    for (const child of remoteTree?.root.children ?? []) walk(child, 1)
    // Workflow plan placeholders: adopted plan nodes render as queued cards
    // until their real root task appears (matched by prompt in planStatus).
    // Placeholders carry no prompt, so the executor never mistakes them for
    // a realized step. A plan node whose root already exists (prompt match in
    // the projection) renders as the real card only — no placeholder.
    const realizedPrompts = new Set((sessionProjection?.nodes ?? []).map(node => node.prompt))
    for (const planNode of workflowPlan?.nodes ?? []) {
      if (planNode.title.trim().length > 0 && realizedPrompts.has(planNode.title.trim())) continue
      nodes.push({
        key: `plan:${String(workflowPlan?.batchSeq)}:${planNode.id}`,
        sessionId: injectedSessionId,
        turn: -1,
        text: planNode.detail ?? '',
        state: 'pending',
        pinned: false,
        produced: [],
        outputSeq: -1,
        title: planNode.title,
        prompt: undefined,
        branch: false,
        running: false,
        planId: planNode.id,
        depth: 0,
        order,
        x: 0,
        y: 0,
      })
      order += 1
    }
    return nodes
  }, [sessionProjection, remoteTree, injectedSessionId, isRunning, workflowPlan])

  // Recent window: keep the newest nodes visible, fold the rest away. Nodes
  // revealed through the outline stay visible too.
  const visibleNodes = useMemo(() => {
    const sorted = [...allNodes].sort((a, b) => b.order - a.order)
    const recent = new Set(sorted.slice(0, RECENT_WINDOW).map(node => node.key))
    const foldedCount = Math.max(0, allNodes.length - RECENT_WINDOW)
    return {
      nodes: allNodes.filter(node => recent.has(node.key) || node.depth === 0 || node.planId !== undefined || revealed.has(node.key)),
      foldedCount,
    }
  }, [allNodes, revealed])

  // Placed positions (user moves override the initial layout).
  const placed = useMemo(() => {
    const base = initialPlacement(visibleNodes.nodes)
    return visibleNodes.nodes.map(node => {
      const position = moved.get(node.key) ?? base.get(node.key)
      return { ...node, x: position?.x ?? 40, y: position?.y ?? 40 }
    })
  }, [visibleNodes, moved])

  // A double-clicked empty spot claims the NEXT new root: remember how many
  // roots existed, and when one more appears after the click, pin it there.
  const rootCountRef = useRef(-1)
  const currentRootCount = allNodes.filter(node => node.depth === 0).length
  useEffect(() => {
    const spot = pendingRootPos.current
    if (spot === null) return
    if (rootCountRef.current === -1) { rootCountRef.current = currentRootCount; return }
    if (currentRootCount > rootCountRef.current) {
      // A new root appeared since the last observation: the fresh one is the
      // max-turn root; pin it and consume the spot.
      const fresh = [...allNodes]
        .filter(node => node.depth === 0)
        .sort((a, b) => b.turn - a.turn)[0]
      rootCountRef.current = currentRootCount
      pendingRootPos.current = null
      if (fresh !== undefined && !moved.has(fresh.key)) {
        setMoved(current => {
          if (current.has(fresh.key)) return current
          const next = new Map(current)
          next.set(fresh.key, { x: spot.x, y: spot.y })
          return next
        })
      }
    }
  }, [currentRootCount, allNodes, moved])

  // The drawn bounds: the SVG grows to fit every card, monotonically — it
  // never shrinks, so revealing a far node (via outline search) changes the
  // viewBox only by growing once, never by snapping all cards smaller.
  const svgBounds = useMemo(() => {
    let maxX = 800
    let maxY = 600
    for (const node of placed) {
      maxX = Math.max(maxX, node.x + CARD_W + 80)
      maxY = Math.max(maxY, node.y + CARD_H + 80)
    }
    const grown = svgBoundsRef.current
    if (grown !== undefined && grown.width >= maxX && grown.height >= maxY) return grown
    const next = { width: maxX, height: maxY }
    svgBoundsRef.current = next
    return next
  }, [placed])

  const selectNodeAt = useCallback((canvasX: number, canvasY: number): string | null => {
    return hitTest(placed.map(node => ({ key: node.key, x: node.x, y: node.y, width: CARD_W, height: CARD_H })), canvasX, canvasY)
  }, [placed])

  // Fork edges for the structural connectors: every non-trunk session hangs
  // under the parent node whose endSeq equals the fork boundary
  // (`child.seedLength - 1`), so draw a connector from that parent node to
  // the child session's FIRST node. The parent may live in the projection
  // (trunk) or the tree (branch); both endpoints must be visible.
  const forkEdges = useMemo(() => {
    const edges: { from: string; to: string }[] = []
    const placedKeys = new Set(placed.map(node => node.key))
    // Union of projection and tree nodes by key, for endSeq lookup.
    const byKey = new Map<string, { sessionId: string; turn: number; endSeq: number }>()
    for (const node of sessionProjection?.nodes ?? []) {
      byKey.set(`${injectedSessionId}:${String(node.turn)}`, { sessionId: injectedSessionId, turn: node.turn, endSeq: node.endSeq })
    }
    const indexSession = (session: CanvasSessionView): void => {
      for (const node of session.nodes) {
        byKey.set(`${session.sessionId}:${String(node.turn)}`, { sessionId: session.sessionId, turn: node.turn, endSeq: node.endSeq })
      }
      for (const child of session.children) indexSession(child)
    }
    if (remoteTree !== undefined) indexSession(remoteTree.root)
    const walk = (session: CanvasSessionView): void => {
      for (const child of session.children) {
        const boundary = (child.seedLength ?? 0) - 1
        const parent = [...byKey.values()].find(node =>
          node.sessionId === session.sessionId && node.endSeq === boundary)
        const firstChildNode = child.nodes[0]
        if (parent !== undefined && firstChildNode !== undefined) {
          const from = `${parent.sessionId}:${String(parent.turn)}`
          const to = `${child.sessionId}:${String(firstChildNode.turn)}`
          if (placedKeys.has(from) && placedKeys.has(to)) edges.push({ from, to })
        }
        walk(child)
      }
    }
    if (remoteTree !== undefined) walk(remoteTree.root)
    return edges
  }, [remoteTree, placed, sessionProjection, injectedSessionId])

  // Route the rail composer's submission to the selected node: the LAST node
  // of a session continues that session (its next message is a sibling node),
  // any other node forks it (the message becomes a child branch). No node
  // selected → the session's own composer (new root / plain continuation).
  const applyComposerTarget = useCallback((node: DrawnNode | null): void => {
    if (node === null) {
      setComposerTarget(null)
      return
    }
    // A workflow plan placeholder is not a real forkable node: leave the
    // composer on the session's own target (no turn to fork).
    if (node.planId !== undefined) {
      setComposerTarget(null)
      return
    }
    const lastOfSession = !placed.some(candidate =>
      candidate.sessionId === node.sessionId && candidate.turn > node.turn)
    setComposerTarget(lastOfSession
      ? { kind: 'session', sessionId: node.sessionId as SessionId }
      : { kind: 'fork', sessionId: node.sessionId as SessionId, turn: node.turn })
  }, [placed, setComposerTarget])

  /** Fit every placed node into the viewport (F / toolbar). */
  const fitAll = useCallback((): void => {
    const viewport = viewportRef.current
    if (viewport === null || placed.length === 0) return
    const w = viewport.clientWidth
    const h = viewport.clientHeight
    if (w === 0 || h === 0) return
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (const node of placed) {
      minX = Math.min(minX, node.x)
      minY = Math.min(minY, node.y)
      maxX = Math.max(maxX, node.x + CARD_W)
      maxY = Math.max(maxY, node.y + CARD_H)
    }
    if (!Number.isFinite(minX)) return
    const contentW = maxX - minX
    const contentH = maxY - minY
    const scale = Math.min(1, Math.min((w - 48) / contentW, (h - 48) / contentH))
    const tx = w / 2 - (minX + contentW / 2) * scale
    const ty = h / 2 - (minY + contentH / 2) * scale
    setPanZoom({ scale, tx, ty })
  }, [placed])

  /** Zoom by a fixed factor about the viewport center (toolbar buttons). */
  const zoomBy = useCallback((factor: number): void => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const rect = viewport.getBoundingClientRect()
    setPanZoom(current => zoomAt(
      current,
      rect.width / 2,
      rect.height / 2,
      current.scale * factor,
    ))
  }, [])

  // Pointer handling: drag empty space pans, drag a card moves it, wheel zooms.
  const handlePointerDown = useCallback((event: React.PointerEvent): void => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const rect = viewport.getBoundingClientRect()
    const screenX = event.clientX - rect.left
    const screenY = event.clientY - rect.top
    const canvas = screenToCanvas(panZoom, screenX, screenY)
    const hit = selectNodeAt(canvas.x, canvas.y)
    if (hit !== null) {
      const node = placed.find(candidate => candidate.key === hit)
      if (node === undefined) return
      setSelectedKey(hit)
      setInspector('detail')
      applyComposerTarget(node)
      if (event.shiftKey) {
        // Shift-click toggles a node in the multi-selection.
        setMultiSelected(current => {
          const next = new Set(current)
          if (next.has(hit)) next.delete(hit)
          else next.add(hit)
          return next
        })
        dragRef.current = null
        return
      }
      dragRef.current = { kind: 'node', key: hit, startX: screenX, startY: screenY, originX: node.x, originY: node.y }
    } else {
      setSelectedKey(null)
      setInspector(mode => (mode === 'closed' ? mode : 'closed'))
      applyComposerTarget(null)
      setMultiSelected(new Set())
      if (event.shiftKey) {
        // Shift+drag empty space box-selects nodes.
        dragRef.current = { kind: 'select', startX: screenX, startY: screenY, originX: canvas.x, originY: canvas.y }
      } else {
        dragRef.current = { kind: 'pan', startX: screenX, startY: screenY, tx: panZoom.tx, ty: panZoom.ty }
      }
    }
  }, [panZoom, placed, selectNodeAt, applyComposerTarget])

  const handlePointerMove = useCallback((event: React.PointerEvent): void => {
    const drag = dragRef.current
    const viewport = viewportRef.current
    if (drag === null || viewport === null) return
    const rect = viewport.getBoundingClientRect()
    const screenX = event.clientX - rect.left
    const screenY = event.clientY - rect.top
    if (drag.kind === 'node') {
      const dx = (screenX - drag.startX) / panZoom.scale
      const dy = (screenY - drag.startY) / panZoom.scale
      let targetX = drag.originX + dx
      let targetY = drag.originY + dy
      // Snap to a 20px grid while dragging: keeps rows/columns tidy without
      // fighting the free-canvas feel (grid-snap, not card-collision).
      const SNAP = 20
      targetX = Math.round(targetX / SNAP) * SNAP
      targetY = Math.round(targetY / SNAP) * SNAP
      setMoved(current => {
        const next = new Map(current)
        next.set(drag.key, { x: targetX, y: targetY })
        return next
      })
    } else if (drag.kind === 'select') {
      const cur = screenToCanvas(panZoom, screenX, screenY)
      const x = Math.min(drag.originX, cur.x)
      const y = Math.min(drag.originY, cur.y)
      const width = Math.abs(cur.x - drag.originX)
      const height = Math.abs(cur.y - drag.originY)
      setBoxSelect({ x, y, width, height })
      const hits = placed.filter(node =>
        node.x + CARD_W >= x && node.x <= x + width
        && node.y + CARD_H >= y && node.y <= y + height)
      setMultiSelected(new Set(hits.map(node => node.key)))
    } else {
      setPanZoom(current => ({
        ...current,
        tx: drag.tx + (screenX - drag.startX),
        ty: drag.ty + (screenY - drag.startY),
      }))
    }
  }, [panZoom, placed])

  const handlePointerUp = useCallback((): void => {
    dragRef.current = null
    setBoxSelect(null)
  }, [])

  const handleWheel = useCallback((event: React.WheelEvent): void => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const rect = viewport.getBoundingClientRect()
    const factor = event.deltaY < 0 ? 1.1 : 1 / 1.1
    setPanZoom(current => zoomAt(current, event.clientX - rect.left, event.clientY - rect.top, current.scale * factor))
  }, [])

  const handleCanvasDoubleClick = useCallback((event: React.MouseEvent): void => {
    const viewport = viewportRef.current
    if (viewport === null) return
    const rect = viewport.getBoundingClientRect()
    const canvas = screenToCanvas(panZoom, event.clientX - rect.left, event.clientY - rect.top)
    const hit = selectNodeAt(canvas.x, canvas.y)
    if (hit === null) {
      // Empty canvas: create a new root task at the double-click spot — the
      // rail composer (now cleared to the session's own target) submits to
      // the trunk, and the next new root lands here.
      pendingRootPos.current = { x: canvas.x, y: canvas.y }
      setSelectedKey(null)
      setInspector('closed')
      applyComposerTarget(null)
    }
  }, [panZoom, selectNodeAt, applyComposerTarget])

  const runDecision = useCallback(async (op: 'confirm' | 'pin' | 'remove'): Promise<void> => {
    if (selectedKey === null) return
    const node = placed.find(candidate => candidate.key === selectedKey)
    if (node === undefined) return
    if (op === 'confirm') await actions.confirmNode(node.sessionId as SessionId, node.turn, node.outputSeq)
    else if (op === 'pin') await actions.pinNode(node.sessionId as SessionId, node.turn, node.outputSeq)
    else await actions.removeNode(node.sessionId as SessionId, node.turn)
    setReload(tick => tick + 1)
  }, [actions, selectedKey, placed])

  /** Apply a decision to every box-selected node (batch ops). */
  const runBatchDecision = useCallback(async (op: 'confirm' | 'pin' | 'remove'): Promise<void> => {
    if (multiSelected.size === 0) return
    const nodes = placed.filter(node => multiSelected.has(node.key))
    for (const node of nodes) {
      if (op === 'confirm') await actions.confirmNode(node.sessionId as SessionId, node.turn, node.outputSeq)
      else if (op === 'pin') await actions.pinNode(node.sessionId as SessionId, node.turn, node.outputSeq)
      else await actions.removeNode(node.sessionId as SessionId, node.turn)
    }
    setMultiSelected(new Set())
    setReload(tick => tick + 1)
  }, [actions, multiSelected, placed])

  /** Toggle a node's outline children. */
  const toggleCollapsed = useCallback((key: string): void => {
    setCollapsed(current => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  /**
   * Outline selection: reveal the node on the canvas (it may be folded out of
   * the recent window), select it, and pan the viewport so it sits centered.
   */
  const focusOutlineEntry = useCallback((key: string): void => {
    setSelectedKey(key)
    setInspector('detail')
    setRevealed(current => {
      if (current.has(key)) return current
      const next = new Set(current)
      next.add(key)
      return next
    })
    const viewport = viewportRef.current
    const node = placed.find(candidate => candidate.key === key)
    if (viewport === null || node === undefined) return
    applyComposerTarget(node)
    const w = viewport.clientWidth
    const h = viewport.clientHeight
    const target = { scale: 1, tx: w / 2 - (node.x + CARD_W / 2), ty: h / 2 - (node.y + CARD_H / 2) }
    // Smooth pan to the target over ~240ms (setTimeout ticks work in every
    // runtime, including jsdom tests without requestAnimationFrame).
    const from = panZoomRef.current
    const start = performance.now()
    const duration = 240
    const tick = (): void => {
      const t = Math.min(1, (performance.now() - start) / duration)
      const ease = 1 - Math.pow(1 - t, 3)
      setPanZoom({
        scale: from.scale + (target.scale - from.scale) * ease,
        tx: from.tx + (target.tx - from.tx) * ease,
        ty: from.ty + (target.ty - from.ty) * ease,
      })
      if (t < 1) window.setTimeout(tick, 16)
    }
    window.setTimeout(tick, 16)
    // Flash the located card.
    setFlashKey(key)
    window.setTimeout(() => {
      setFlashKey(current => current === key ? null : current)
    }, 900)
  }, [placed, applyComposerTarget])

  /** The session's pending suggestions from the projection. */
  const suggestions = sessionProjection?.suggestions ?? []

  /** Edit one suggestion's title in the review list. */
  const editSuggestion = useCallback((suggestion: CanvasTaskSuggestionView, title: string): void => {
    const key = `${String(suggestion.batchSeq)}:${String(suggestion.index)}`
    setSuggestEdits(current => ({ ...current, [key]: title }))
  }, [])

  /** Adopt one suggestion as a root task: send its prompt, then record the
   *  adoption so the review list drops it. */
  const adoptSuggestion = useCallback(async (suggestion: CanvasTaskSuggestionView): Promise<void> => {
    const key = `${String(suggestion.batchSeq)}:${String(suggestion.index)}`
    const title = (suggestEdits[key] ?? suggestion.title).trim()
    if (title.length === 0) return
    await sendPrompt(injectedSessionId, title)
    await actions.adoptSuggestion(injectedSessionId as SessionId, suggestion.batchSeq, suggestion.index)
    setReload(tick => tick + 1)
  }, [suggestEdits, sendPrompt, injectedSessionId, actions])

  /** Remove one suggestion from the review list without adopting it. */
  const removeSuggestion = useCallback(async (suggestion: CanvasTaskSuggestionView): Promise<void> => {
    await actions.removeSuggestion(injectedSessionId as SessionId, suggestion.batchSeq, suggestion.index)
    setReload(tick => tick + 1)
  }, [actions, injectedSessionId])

  /** Adopt every pending suggestion in order (each becomes a root task). */
  const adoptAllSuggestions = useCallback(async (): Promise<void> => {
    for (const suggestion of suggestions) await adoptSuggestion(suggestion)
  }, [suggestions, adoptSuggestion])

  /** Merge the selected suggestions into one root task: the first title wins,
   *  remaining details append. Sends one prompt, then removes the merged set. */
  const mergeSuggestions = useCallback(async (): Promise<void> => {
    const selected = suggestions.filter(suggestion =>
      suggestSelected.has(`${String(suggestion.batchSeq)}:${String(suggestion.index)}`))
    if (selected.length === 0) return
    const head = selected[0]!
    const headKey = `${String(head.batchSeq)}:${String(head.index)}`
    const title = (suggestEdits[headKey] ?? head.title).trim()
    if (title.length === 0) return
    const extra = selected.slice(1)
      .map(suggestion => suggestEdits[`${String(suggestion.batchSeq)}:${String(suggestion.index)}`] ?? suggestion.title)
      .filter(text => text.length > 0)
    const prompt = extra.length === 0 ? title : `${title}（另含：${extra.join('、')}）`
    await sendPrompt(injectedSessionId, prompt)
    for (const suggestion of selected) {
      await actions.removeSuggestion(injectedSessionId as SessionId, suggestion.batchSeq, suggestion.index)
    }
    setSuggestSelected(new Set())
    setReload(tick => tick + 1)
  }, [suggestions, suggestSelected, suggestEdits, sendPrompt, injectedSessionId, actions])

  /** The session's pending workflow proposal (one at a time). */
  const workflow = sessionProjection?.workflow

  /** Adopt the workflow: record the decision; the durable plan (projected
   *  after adopt) drives dependency-ordered execution. */
  const adoptWorkflow = useCallback(async (): Promise<void> => {
    if (workflow === undefined) return
    await actions.adoptWorkflow(injectedSessionId as SessionId, workflow.batchSeq)
    setInspector('closed')
    setReload(tick => tick + 1)
  }, [workflow, actions, injectedSessionId])

  /** Remove the workflow proposal without adopting it. */
  const dismissWorkflow = useCallback(async (): Promise<void> => {
    if (workflow === undefined) return
    await actions.removeWorkflow(injectedSessionId as SessionId, workflow.batchSeq)
    setInspector('closed')
    setReload(tick => tick + 1)
  }, [workflow, actions, injectedSessionId])

  /** Schedule the workflow: tell the agent to register a schedule with the
   *  native schedule_create tool; when it fires, the agent re-runs the plan.
   *  The instruction carries the node titles so the agent can re-propose. */
  const scheduleWorkflow = useCallback(async (scheduleText: string): Promise<void> => {
    if (workflow === undefined) return
    const titles = workflow.nodes.map(node => node.title).join(' → ')
    await sendPrompt(injectedSessionId,
      `将以下工作流设为定时执行（${scheduleText}）：用 schedule_create 注册，到点自动重新执行。工作流步骤：${titles}`)
    setInspector('closed')
    setReload(tick => tick + 1)
  }, [workflow, sendPrompt, injectedSessionId])

  // ---- workflow plan execution (dependency-ordered) ----
  /** Plan node ids already sent as root prompts (per plan batch). */
  const sentPlanRef = useRef<Set<string>>(new Set())
  // Reset the sent-set when the plan changes (new batch / re-adopt).
  useEffect(() => {
    sentPlanRef.current = new Set()
  }, [workflowPlan?.batchSeq])

  /** Re-run the adopted plan from scratch: reset the sent-set so every step
   *  is re-sent in dependency order (the plan stays durable, so this is the
   *  template's manual re-run). */
  const [rerunTick, setRerunTick] = useState(0)
  const rerunWorkflow = useCallback((): void => {
    sentPlanRef.current = new Set()
    setRerunTick(tick => tick + 1)
  }, [])

  // Status per plan node: done = a real root with this prompt exists and its
  // session is not running; running = it exists and is running; waiting = the
  // step is ready but declares user input (it waits for the rail); ready = all
  // dependencies done; queued = waiting on dependencies.
  const planStatus = useMemo(() => {
    const status = new Map<string, 'queued' | 'ready' | 'running' | 'done' | 'waiting'>()
    if (workflowPlan === undefined) return status
    const byId = new Map(workflowPlan.nodes.map(node => [node.id, node]))
    const dependsOn = new Map<string, string[]>()
    for (const edge of workflowPlan.edges) {
      const list = dependsOn.get(edge.to) ?? []
      list.push(edge.from)
      dependsOn.set(edge.to, list)
    }
    const doneIds = new Set<string>()
    for (const node of workflowPlan.nodes) {
      const real = placed.find(candidate =>
        candidate.depth === 0 && candidate.prompt === node.title)
      if (real !== undefined) {
        doneIds.add(node.id)
        status.set(node.id, real.running ? 'running' : 'done')
      } else if (node.input === true && sentPlanRef.current.has(node.id)) {
        // An input step the user already submitted: its prompt carries the
        // user value, so title-matching cannot find it — treat as done.
        doneIds.add(node.id)
        status.set(node.id, 'done')
      } else if (sentPlanRef.current.has(node.id)) {
        // Sent as a root prompt but its real root has not materialized yet
        // (the agent is still turning): keep it OUT of the done set so a
        // dependent step waits for the actual root, while displaying it as
        // in-flight rather than queued.
        status.set(node.id, 'running')
      } else {
        status.set(node.id, 'queued')
      }
    }
    // Ready = queued with every dependency done; a step declaring user input
    // stops at 'waiting' (the rail slides open for the user's per-run value).
    for (const node of workflowPlan.nodes) {
      if (status.get(node.id) !== 'queued') continue
      const deps = dependsOn.get(node.id) ?? []
      if (!deps.every(dep => doneIds.has(dep))) continue
      const planNode = byId.get(node.id)
      status.set(node.id, planNode?.input === true ? 'waiting' : 'ready')
    }
    return status
  }, [workflowPlan, placed, rerunTick])

  // Advance the plan: send every ready node as a root prompt, once. Waiting
  // nodes never send here — the user supplies their input in the rail.
  useEffect(() => {
    if (workflowPlan === undefined) return
    const ready = workflowPlan.nodes.filter(node =>
      planStatus.get(node.id) === 'ready' && !sentPlanRef.current.has(node.id))
    if (ready.length === 0) return
    for (const node of ready) sentPlanRef.current.add(node.id)
    void Promise.all(ready.map(node =>
      sendPrompt(injectedSessionId, node.title.trim())))
      .then(() => { setReload(tick => tick + 1) })
      .catch(() => {})
  }, [workflowPlan, planStatus, sendPrompt, injectedSessionId, rerunTick])

  // One waiting step: the first plan node at 'waiting'. When it exists, the
  // rail slides open to that node so the user supplies the per-run input.
  const waitingNode = useMemo(() => {
    if (workflowPlan === undefined) return undefined
    return workflowPlan.nodes.find(node => planStatus.get(node.id) === 'waiting')
  }, [workflowPlan, planStatus])

  // Slide the rail open to a waiting step (the "user didn't notice" backstop:
  // the input box appears without the user hunting for it). Reopens a
  // collapsed rail: a step waiting for input must never stay hidden.
  useEffect(() => {
    if (waitingNode === undefined) return
    const placeholder = placed.find(node => node.planId === waitingNode.id)
    if (placeholder === undefined) return
    setRailOpen(true)
    setSelectedKey(placeholder.key)
    setInspector('detail')
    applyComposerTarget(placeholder)
  }, [waitingNode, placed, applyComposerTarget])

  // Stale-wait backstop: a waiting step that stays unanswered for
  // WAIT_STALE_MS is marked "搁置" (not blocking; the user re-opens it).
  const WAIT_STALE_MS = 10 * 60 * 1000
  const [staleWaiting, setStaleWaiting] = useState(false)
  const waitingSinceRef = useRef<number | null>(null)
  useEffect(() => {
    if (waitingNode === undefined) {
      waitingSinceRef.current = null
      setStaleWaiting(false)
      return
    }
    waitingSinceRef.current = Date.now()
    setStaleWaiting(false)
    const timer = window.setInterval(() => {
      const since = waitingSinceRef.current
      if (since !== null && Date.now() - since >= WAIT_STALE_MS) {
        setStaleWaiting(true)
      }
    }, 30 * 1000)
    return () => { window.clearInterval(timer) }
  }, [waitingNode?.id])

  // Cross-tab backstop: while a step waits for input, mark the document title
  // so the user notices even on another tab.
  useEffect(() => {
    const original = document.title
    if (waitingNode !== undefined) document.title = `⏳ 等待输入：${waitingNode.title}`
    return () => { document.title = original }
  }, [waitingNode])

  /** Send a waiting step with the user's input appended to its task. */
  const submitPlanInput = useCallback(async (text: string): Promise<void> => {
    if (waitingNode === undefined || text.trim().length === 0) return
    const prompt = `${waitingNode.title.trim()}（用户输入：${text.trim()}）`
    await sendPrompt(injectedSessionId, prompt)
    sentPlanRef.current.add(waitingNode.id)
    setInspector('closed')
    setRerunTick(tick => tick + 1)
    setReload(tick => tick + 1)
  }, [waitingNode, sendPrompt, injectedSessionId])

  // Results of the adopted plan: every realized step's real node with its
  // produced files and conclusion — the "只看最终结果" summary.
  const workflowResults = useMemo(() => {
    if (workflowPlan === undefined) return []
    return workflowPlan.nodes
      .map(node => {
        const real = placed.find(candidate =>
          candidate.depth === 0 && candidate.prompt === node.title)
        if (real === undefined) return null
        return { id: node.id, title: node.title, produced: real.produced, text: real.text, key: real.key }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
  }, [workflowPlan, placed])

  /** Open a realized step's node for inspection/modification (right rail). */
  const openWorkflowResult = useCallback((key: string): void => {
    const node = placed.find(candidate => candidate.key === key)
    if (node === undefined) return
    setSelectedKey(key)
    setInspector('detail')
    applyComposerTarget(node)
  }, [placed, applyComposerTarget])

  // Keyboard decisions on the selected node: c confirm / p pin / d remove;
  // f fits the whole canvas. c/p/d need a selection, f does not.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'f' || event.key === 'F') {
        fitAll()
        return
      }
      if (inspector !== 'closed') return
      if (selectedKey === null) return
      if (event.key === 'c' || event.key === 'C') void runDecision('confirm')
      else if (event.key === 'p' || event.key === 'P') void runDecision('pin')
      else if (event.key === 'd' || event.key === 'D') void runDecision('remove')
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [runDecision, selectedKey, inspector, fitAll])

  const selectedNode = selectedKey === null ? undefined : placed.find(node => node.key === selectedKey)

  // Outline tree: the full cross-session tree, recursive — a fork session's
  // nodes hang under the trunk/branch node whose endSeq equals the fork's
  // seed boundary (`child.seedLength - 1 === parentNode.endSeq`).
  const outlineTree = useMemo(() => {
    const query = search.trim().toLowerCase()
    const root = remoteTree?.root
    // Trunk nodes come live from the projection when mounted, else the tree.
    const projectionNodes = sessionProjection?.nodes
    const trunkNodes = (projectionNodes !== undefined && projectionNodes.length > 0) ? projectionNodes : (root?.nodes ?? [])
    const buildSession = (session: CanvasSessionView, nodes: CanvasNodeView[], depth: number): OutlineEntry[] => {
      const entries: OutlineEntry[] = nodes.map(node => {
        const key = `${session.sessionId}:${String(node.turn)}`
        const haystack = [node.title ?? '', node.prompt ?? '', node.output.text, key].join('\n').toLowerCase()
        return {
          key,
          sessionId: session.sessionId,
          turn: node.turn,
          title: node.title,
          prompt: node.prompt,
          text: node.output.text,
          depth,
          children: [],
          matched: query.length > 0 && haystack.includes(query),
          hasMatchedDescendant: false,
        }
      })
      // Attach each fork child under the node it forked from; sessions with no
      // matching node (defensive) hang under the session's last node, or at
      // the session level when it has no nodes at all.
      for (const child of session.children) {
        const boundary = (child.seedLength ?? 0) - 1
        const at = nodes.findIndex(node => node.endSeq === boundary)
        const target = at === -1 ? entries[entries.length - 1] : entries[at]
        const childEntries = buildSession(child, child.nodes, depth + 1)
        if (target !== undefined) target.children.push(...childEntries)
        else entries.push(...childEntries)
      }
      return entries
    }
    // While the tree loads, the outline shows the projection's trunk nodes
    // (no fork children yet); the loaded tree then supplies them.
    const session: CanvasSessionView = root ?? { sessionId: injectedSessionId, nodes: trunkNodes, children: [] }
    const roots = buildSession(session, trunkNodes, 0)
    // Post-order: mark entries that carry a matching descendant, so search can
    // auto-expand the paths that lead to hits.
    const mark = (entries: OutlineEntry[]): boolean => {
      let carries = false
      for (const entry of entries) {
        const descendant = mark(entry.children)
        entry.hasMatchedDescendant = descendant
        carries = carries || entry.matched || descendant
      }
      return carries
    }
    mark(roots)
    // Branch collection: every fork session's node tree, gathered from the
    // roots' direct children (the "分支" outline group). Each root's children
    // are depth-1 sessions; their subtrees recurse underneath.
    const branches = roots.flatMap(root => root.children)
    const firstMatch = (entries: OutlineEntry[]): string | null => {
      for (const entry of entries) {
        if (entry.matched) return entry.key
        const found = firstMatch(entry.children)
        if (found !== null) return found
      }
      return null
    }
    const collectMatched = (entries: OutlineEntry[], acc: Set<string>): void => {
      for (const entry of entries) {
        if (entry.matched) acc.add(entry.key)
        collectMatched(entry.children, acc)
      }
    }
    const matchedKeys = new Set<string>()
    if (query.length > 0) {
      collectMatched(roots, matchedKeys)
      collectMatched(branches, matchedKeys)
    }
    return {
      roots,
      branches,
      active: query.length > 0,
      firstMatch: firstMatch(roots),
      hasBranches: branches.length > 0,
      matchedKeys,
    }
  }, [remoteTree, sessionProjection, search])

  const trunkCount = sessionProjection?.nodes.length ?? remoteTree?.root.nodes.length ?? 0
  const empty = trunkCount === 0 && (remoteTree?.root.children.length ?? 0) === 0

  return (
    <div className={css.root} data-canvas-view>
      <div className={css.toolbar}>
        <button
          type="button"
          className={css.tool}
          onClick={() => { setOutlineOpen(open => !open) }}
          title="大纲侧栏"
        >
          {outlineOpen ? '◀ 大纲' : '▶ 大纲'}
        </button>
        <h2 className={css.title}>画布</h2>
        <span className={css.meta}>
          {injectedSessionId}
          {sessionProjection === undefined && remoteTree === undefined
            ? ' · 加载中'
            : ` · ${String(trunkCount)} 节点${(remoteTree?.sessionCount ?? 1) > 1 ? ` / ${String(remoteTree?.sessionCount)} 会话` : ''}`}
        </span>
        <span className={css.hint}>单击选节点 · 双击空白新建根任务 · 拖拽/缩放/平移 · Shift+拖拽框选</span>
        <button
          type="button"
          className={css.tool}
          onClick={() => { setRailOpen(open => !open) }}
          title="右栏侧栏"
        >
          {railOpen ? '▶ 右栏' : '◀ 右栏'}
        </button>
      </div>
      {multiSelected.size > 0 && (
        <div className={css.batchBar} data-canvas-batch>
          <span className={css.batchLabel}>已选 {String(multiSelected.size)} 个节点</span>
          <button type="button" className={css.action} onClick={() => { void runBatchDecision('pin') }}>批量固定</button>
          <button type="button" className={css.action} onClick={() => { void runBatchDecision('remove') }}>批量删除</button>
          <button type="button" className={css.action} onClick={() => { setMultiSelected(new Set()) }}>取消选择</button>
        </div>
      )}
      <div className={css.workspace}>
        {outlineOpen && (
          <aside className={css.outline} data-canvas-outline>
            <div className={css.outlineHead}>
              <span>节点大纲</span>
              {outlineTree.active && (
                <span className={css.outlineMatchCount}>
                  {outlineTree.firstMatch === null ? '无命中' : '命中，点击定位画布'}
                </span>
              )}
            </div>
            <input
              className={css.search}
              placeholder="搜索节点（标题/任务/内容）…"
              value={search}
              onChange={event => { setSearch(event.currentTarget.value) }}
            />
            <div className={css.outlineBody}>
              {visibleNodes.foldedCount > 0 && !outlineTree.active && (
                <div className={css.outlineFold}>更早 {visibleNodes.foldedCount} 个节点已折叠</div>
              )}
              {outlineTree.roots.length === 0 && !outlineTree.active && (
                <div className={css.outlineFold}>暂无节点——双击空白新建根任务</div>
              )}
              {outlineTree.roots.length > 0 && (
                <div className={css.outlineGroup} data-outline-group="roots">
                  <div className={css.outlineGroupHead}>根任务</div>
                  {outlineTree.roots.map(root => (
                    <OutlineBranch
                      key={root.key}
                      entry={root}
                      selectedKey={selectedKey}
                      collapsed={collapsed}
                      searchActive={outlineTree.active}
                      showChildren={false}
                      onToggle={toggleCollapsed}
                      onSelect={focusOutlineEntry}
                    />
                  ))}
                </div>
              )}
              {outlineTree.hasBranches && (
                <div className={css.outlineGroup} data-outline-group="branches">
                  <div className={css.outlineGroupHead}>分支</div>
                  {outlineTree.branches.map(branch => (
                    <OutlineBranch
                      key={branch.key}
                      entry={branch}
                      selectedKey={selectedKey}
                      collapsed={collapsed}
                      searchActive={outlineTree.active}
                      showChildren
                      onToggle={toggleCollapsed}
                      onSelect={focusOutlineEntry}
                    />
                  ))}
                </div>
              )}
            </div>
          </aside>
        )}
        <div className={css.canvasArea}>
          <div
            ref={viewportRef}
            className={css.viewport}
            data-canvas-viewport
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            onWheel={handleWheel}
            onDoubleClick={handleCanvasDoubleClick}
          >
            <div
              className={css.canvasLayer}
              data-canvas-layer
              style={{ transform: `translate(${panZoom.tx}px, ${panZoom.ty}px) scale(${panZoom.scale})`, transformOrigin: '0 0' }}
            >
              <svg
                className={css.canvas}
                width={svgBounds.width}
                height={svgBounds.height}
                viewBox={`0 0 ${svgBounds.width} ${svgBounds.height}`}
                role="img"
                aria-label="Agent 画布：根任务与分支节点"
              >
                {/* Root connectors between adjacent roots. */}
                {placed.filter(node => node.depth === 0).slice(0, -1).map((node, index) => {
                  const next = placed.filter(candidate => candidate.depth === 0)[index + 1]
                  if (next === undefined) return null
                  return (
                    <line
                      key={`root-line-${node.key}`}
                      x1={node.x + CARD_W}
                      y1={node.y + CARD_H / 2}
                      x2={next.x}
                      y2={next.y + CARD_H / 2}
                      stroke="var(--dsw-alias-border, #d1d5db)"
                      strokeWidth={1.5}
                    />
                  )
                })}
                {/* Fork connectors: parent node → child session's first node. */}
                {forkEdges.map(({ from, to }) => {
                  const parent = placed.find(node => node.key === from)
                  const child = placed.find(node => node.key === to)
                  if (parent === undefined || child === undefined) return null
                  const startX = parent.x + CARD_W / 2
                  const startY = parent.y + CARD_H
                  const endX = child.x + CARD_W / 2
                  const endY = child.y
                  const midY = (startY + endY) / 2
                  return (
                    <path
                      key={`fork-${from}-${to}`}
                      d={`M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`}
                      fill="none"
                      stroke="var(--dsw-static-blue-300, #93c5fd)"
                      strokeWidth={1.5}
                      strokeDasharray="4 3"
                    />
                  )
                })}
                {/* Workflow plan dependency edges: `to` waits for `from`. */}
                {(workflowPlan?.edges ?? []).map(edge => {
                  const fromKey = `plan:${String(workflowPlan?.batchSeq)}:${edge.from}`
                  const toKey = `plan:${String(workflowPlan?.batchSeq)}:${edge.to}`
                  const fromNode = placed.find(node => node.key === fromKey)
                  const toNode = placed.find(node => node.key === toKey)
                  if (fromNode === undefined || toNode === undefined) return null
                  const startX = fromNode.x + CARD_W / 2
                  const startY = fromNode.y + CARD_H
                  const endX = toNode.x + CARD_W / 2
                  const endY = toNode.y
                  const midY = (startY + endY) / 2
                  return (
                    <path
                      key={`plan-${edge.from}-${edge.to}`}
                      d={`M ${startX} ${startY} C ${startX} ${midY}, ${endX} ${midY}, ${endX} ${endY}`}
                      fill="none"
                      stroke="var(--dsw-static-blue-600, #2563eb)"
                      strokeWidth={2}
                      markerEnd="url(#canvasArrow)"
                    />
                  )
                })}
                <defs>
                  <marker id="canvasArrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
                    <path d="M0,0 L8,4 L0,8 Z" fill="var(--dsw-static-blue-600, #2563eb)" />
                  </marker>
                </defs>
                {empty ? null : placed.map(node => (
                  <CanvasIndexCard
                    key={node.key}
                    node={node}
                    selected={selectedKey === node.key || multiSelected.has(node.key)}
                    flashing={flashKey === node.key}
                    matched={outlineTree.matchedKeys.has(node.key)}
                    planStatus={node.planId === undefined ? undefined : planStatus.get(node.planId)}
                    staleWaiting={node.planId !== undefined && planStatus.get(node.planId) === 'waiting' && staleWaiting}
                    onSelect={() => { setSelectedKey(node.key); setInspector('detail'); applyComposerTarget(node) }}
                    onDoubleClick={() => { setSelectedKey(node.key); setInspector('detail'); applyComposerTarget(node) }}
                    onPointerDown={(_event) => { void _event }}
                  />
                ))}
                {boxSelect !== null && (
                  <rect
                    x={boxSelect.x}
                    y={boxSelect.y}
                    width={boxSelect.width}
                    height={boxSelect.height}
                    fill="var(--dsw-static-blue-100, #dbeafe)"
                    stroke="var(--dsw-static-blue-500, #3b82f6)"
                    strokeWidth={1}
                    strokeDasharray="4 3"
                    opacity={0.4}
                  />
                )}
              </svg>
            </div>
            {empty && (
              <p className={css.empty}>
                {sessionProjection === undefined && remoteTree === undefined
                  ? '画布加载中——请先启用 canvas-projection 插件并产生对话输出。'
                  : '暂无节点——双击空白新建根任务，或先对话产生输出。'}
              </p>
            )}
            {workflow !== undefined && (
              <button
                type="button"
                className={css.suggestBadge}
                data-canvas-workflow-badge
                onClick={() => { setInspector('workflow') }}
                title={`Agent 设计了 ${String(workflow.nodes.length)} 步工作流，点击确认`}
              >
                🛠 {String(workflow.nodes.length)} 步工作流
              </button>
            )}
            {suggestions.length > 0 && (
              <button
                type="button"
                className={css.suggestBadge}
                data-canvas-suggest-badge
                onClick={() => { setInspector('suggest') }}
                title={`Agent 拆解了 ${String(suggestions.length)} 个根任务建议，点击确认`}
              >
                📋 {String(suggestions.length)} 条任务建议
              </button>
            )}
            {workflowResults.length > 0 && (
              <button
                type="button"
                className={css.suggestBadge}
                data-canvas-workflow-results
                onClick={() => { setInspector('results') }}
                title="查看工作流产物"
              >
                📦 {String(workflowResults.length)} 项产物
              </button>
            )}
            {workflowPlan !== undefined && (
              <button
                type="button"
                className={css.suggestBadge}
                data-canvas-workflow-rerun
                onClick={() => { rerunWorkflow() }}
                title="重新执行当前工作流模板"
              >
                🔄 重新执行
              </button>
            )}
            <div className={css.canvasTools} data-canvas-tools>
              <button type="button" className={css.toolBtn} onClick={() => { fitAll() }} title="适应全部 (F)">⤢ 适应</button>
              <button type="button" className={css.toolBtn} onClick={() => { zoomBy(1.2) }} title="放大">＋</button>
              <button type="button" className={css.toolBtn} onClick={() => { zoomBy(1 / 1.2) }} title="缩小">－</button>
              <button type="button" className={css.toolBtn} onClick={() => { setPanZoom(IDENTITY_PANZOOM) }} title="100%">100%</button>
            </div>
          </div>
        </div>
        <aside
          className={railOpen ? css.inspector : `${css.inspector} ${css.inspectorCollapsed}`}
          data-canvas-inspector
          data-canvas-inspector-collapsed={railOpen ? undefined : ''}
          onPointerDown={(event) => { event.stopPropagation() }}
        >
          {waitingNode !== undefined && (
            <div className={css.railWaiting} data-canvas-waiting>
              <div className={css.railWaitingText}>
                {staleWaiting
                  ? <>工作流等待已搁置：<strong>{waitingNode.title}</strong>（随时可在此继续）</>
                  : <>工作流等待你的输入：<strong>{waitingNode.title}</strong></>}
              </div>
              <div className={css.workflowScheduleRow}>
                <input
                  className={css.inputCustom}
                  placeholder="输入今日主题或内容…"
                  value={planInputDraft}
                  onChange={event => { setPlanInputDraft(event.currentTarget.value) }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && planInputDraft.trim().length > 0) {
                      void submitPlanInput(planInputDraft.trim())
                      setPlanInputDraft('')
                    }
                  }}
                />
                <button
                  type="button"
                  className={css.actionPrimary}
                  disabled={planInputDraft.trim().length === 0}
                  onClick={() => {
                    void submitPlanInput(planInputDraft.trim())
                    setPlanInputDraft('')
                  }}
                >
                  提交并继续
                </button>
              </div>
            </div>
          )}
          {inspector === 'closed' && selectedKey === null && (
            <div className={css.railEmpty}>
              在下方输入，以当前会话继续对话或新建根任务；点选一个节点，输入将针对该节点（最后一个节点继续该会话，其他节点新建分支）。
            </div>
          )}
          {inspector === 'detail' && selectedNode !== undefined && (
              <InspectorDetail
                node={selectedNode}
                openFile={openFile}
                onConfirm={() => { void runDecision('confirm') }}
                onPin={() => { void runDecision('pin') }}
                onRemove={() => { void runDecision('remove') }}
                onRename={(title) => {
                  void actions.setNodeTitle(
                    selectedNode.sessionId as SessionId,
                    selectedNode.turn,
                    selectedNode.outputSeq,
                    title,
                  ).then(() => { setReload(tick => tick + 1) })
                }}
                onClose={() => { setInspector('closed') }}
              />
            )}
            {inspector === 'suggest' && (
              <InspectorSuggest
                suggestions={suggestions}
                edits={suggestEdits}
                selected={suggestSelected}
                onEdit={editSuggestion}
                onToggleSelected={(key) => {
                  setSuggestSelected(current => {
                    const next = new Set(current)
                    if (next.has(key)) next.delete(key)
                    else next.add(key)
                    return next
                  })
                }}
                onAdopt={(suggestion) => { void adoptSuggestion(suggestion) }}
                onRemove={(suggestion) => { void removeSuggestion(suggestion) }}
                onAdoptAll={() => { void adoptAllSuggestions() }}
                onMerge={() => { void mergeSuggestions() }}
                onClose={() => { setInspector('closed') }}
              />
            )}
            {inspector === 'workflow' && workflow !== undefined && (
              <InspectorWorkflow
                workflow={workflow}
                onAdopt={() => { void adoptWorkflow() }}
                onRemove={() => { void dismissWorkflow() }}
                onSchedule={(text) => { void scheduleWorkflow(text) }}
                onClose={() => { setInspector('closed') }}
              />
            )}
            {inspector === 'results' && (
              <InspectorResults
                results={workflowResults}
                onOpen={(key) => { openWorkflowResult(key) }}
                onClose={() => { setInspector('closed') }}
              />
            )}
            {composerBar !== undefined && (
              <div className={css.railComposer} data-canvas-composer>
                {composerBar}
              </div>
            )}
        </aside>
      </div>
    </div>
  )
}

/** One outline row: a node plus its recursive fork subtree. */
function OutlineBranch(props: {
  entry: OutlineEntry
  selectedKey: string | null
  collapsed: Set<string>
  searchActive: boolean
  /** Render the node's fork children too (true = full tree; false = the node alone). */
  showChildren: boolean
  onToggle: (key: string) => void
  onSelect: (key: string) => void
}): React.JSX.Element {
  const { entry, selectedKey, collapsed, searchActive, showChildren, onToggle, onSelect } = props
  const hasChildren = entry.children.length > 0
  // Search auto-expands every path that leads to a hit; otherwise the user's
  // collapse choice governs. When showChildren is false the row renders alone
  // (the "根任务" group lists roots without their branch subtrees).
  const expanded = searchActive
    ? entry.matched || entry.hasMatchedDescendant
    : !collapsed.has(entry.key)
  const renderChildren = showChildren && hasChildren && expanded
  const dimmed = searchActive && !entry.matched && !entry.hasMatchedDescendant
  return (
    <div className={css.outlineBranch} data-depth={entry.depth}>
      <div className={css.outlineRowWrap}>
        {hasChildren && showChildren && (
          <button
            type="button"
            className={css.outlineTwisty}
            onClick={(event) => {
              event.stopPropagation()
              onToggle(entry.key)
            }}
            aria-label={expanded ? '折叠' : '展开'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        )}
        <button
          type="button"
          className={css.outlineRow}
          data-selected={selectedKey === entry.key || undefined}
          data-matched={entry.matched || undefined}
          data-dimmed={dimmed || undefined}
          onClick={() => { onSelect(entry.key) }}
        >
          <span className={css.outlineGlyph}>{entry.depth === 0 ? '●' : '⎇'}</span>
          <span className={css.outlineText}>
            {nodeName(entry, 24)}
            <span className={css.outlineId}> · {entry.depth === 0 ? '根' : '⎇'}#{entry.turn}</span>
          </span>
        </button>
      </div>
      {renderChildren && entry.children.map(child => (
        <OutlineBranch
          key={child.key}
          entry={child}
          selectedKey={selectedKey}
          collapsed={collapsed}
          searchActive={searchActive}
          showChildren
          onToggle={onToggle}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

/** One canvas index card: fixed size, summary title + badges only. */
function CanvasIndexCard(props: {
  node: DrawnNode
  selected: boolean
  flashing: boolean
  matched: boolean
  planStatus: 'queued' | 'ready' | 'running' | 'done' | 'waiting' | undefined
  staleWaiting: boolean
  onSelect: () => void
  onDoubleClick: () => void
  onPointerDown: (event: React.PointerEvent) => void
}): React.JSX.Element {
  const { node, selected, flashing, matched, planStatus, staleWaiting, onSelect, onDoubleClick, onPointerDown } = props
  const isPlan = planStatus !== undefined
  const displayState = displayStateOf(node)
  const border = planStatus === 'waiting'
    ? 'var(--dsw-static-amber-500, #f59e0b)'
    : stateColor(displayState, node.running)
  // The card's identity is its NAME: the user-named title, or a summary.
  const name = nodeName(node, 18)
  const badges: string[] = []
  if (node.produced.length > 0) badges.push(`📎${node.produced.length}`)
  if (node.pinned) badges.push('📌')
  // Plan placeholder cards use a muted dashed frame and a status text instead
  // of the settled/pending dot (the step is queued/ready, not yet realized).
  const planText = planStatus === 'queued' ? '⏳ 排队中'
    : planStatus === 'ready' ? '🟢 就绪'
      : planStatus === 'waiting' ? (staleWaiting ? '⏸ 已搁置，点击继续' : '✋ 等待输入')
        : planStatus === 'running' ? '运行中' : '已完成'
  const statusDot = isPlan
    ? <circle cx={node.x + 12} cy={node.y + 16} r={3.5} fill="var(--dsw-alias-text-tertiary, #94a3b8)" />
    : node.running
      ? <circle className={css.cardDotRunning} cx={node.x + 12} cy={node.y + 16} r={4} />
      : displayState === 'settled'
        ? <circle cx={node.x + 12} cy={node.y + 16} r={3.5} fill="var(--dsw-static-green-500, #22c55e)" />
        : displayState === 'pending'
          ? <circle cx={node.x + 12} cy={node.y + 16} r={3.5} fill="var(--dsw-static-amber-500, #f59e0b)" />
          : <circle cx={node.x + 12} cy={node.y + 16} r={3.5} fill="var(--dsw-alias-text-tertiary, #94a3b8)" />
  return (
    <g
      data-node={node.key}
      data-state={isPlan ? 'plan' : displayState}
      data-running={node.running || undefined}
      className={selected ? css.cardSelected : undefined}
      onPointerDown={(event) => { onPointerDown(event) }}
      onClick={onSelect}
      onDoubleClick={onDoubleClick}
    >
      <rect
        x={node.x}
        y={node.y}
        width={CARD_W}
        height={CARD_H}
        rx={10}
        fill="var(--dsw-alias-surface, #fff)"
        stroke={selected ? 'var(--dsw-static-blue-500, #3b82f6)' : matched ? 'var(--dsw-static-amber-500, #f59e0b)' : border}
        strokeWidth={selected ? 2.5 : matched ? 2 : isPlan ? 1.2 : 1.2}
        strokeDasharray={isPlan ? '5 4' : undefined}
        className={flashing ? css.cardFlash
          : planStatus === 'waiting' ? css.cardWaiting
            : node.running ? css.cardRunning
              : matched ? css.cardMatched
                : isPlan ? css.cardPlan : undefined}
      />
      {statusDot}
      <text x={node.x + 22} y={node.y + 21} fontSize={12} fontWeight={600} fill="var(--dsw-alias-text-primary, #1f2933)">
        {name}
      </text>
      <text x={node.x + 10} y={node.y + 40} fontSize={9} fill="var(--dsw-alias-text-secondary, #4b5563)">
        {isPlan ? '工作流步骤' : node.depth === 0 ? '根' : '⎇'} {isPlan ? '' : `#${node.turn}`}
        {!isPlan && node.depth > 0 ? ` · ${node.sessionId.slice(-6)}` : ''}
      </text>
      <text x={node.x + 10} y={node.y + 58} fontSize={9} fill="var(--dsw-alias-text-tertiary, #94a3b8)">
        {isPlan ? planText : node.running ? '运行中' : displayState === 'settled' ? '已完成' : displayState === 'pending' ? '待确认' : '已移除'}
        {badges.length > 0 ? ` ${badges.join(' ')}` : ''}
      </text>
      <text x={node.x + CARD_W - 10} y={node.y + 21} fontSize={9} fill="var(--dsw-alias-text-tertiary, #94a3b8)" textAnchor="end">
        {isPlan ? '▤' : node.depth === 0 ? '●' : '⎇'}
      </text>
      {!isPlan && node.running && (
        <>
          <rect
            x={node.x + 8}
            y={node.y + CARD_H - 5}
            width={CARD_W - 16}
            height={2}
            rx={1}
            fill="var(--dsw-static-blue-100, #dbeafe)"
          />
          <rect
            x={node.x + 8}
            y={node.y + CARD_H - 5}
            width={CARD_W - 16}
            height={2}
            rx={1}
            fill="var(--dsw-static-blue-500, #3b82f6)"
            className={css.cardProgressFill}
          />
        </>
      )}
    </g>
  )
}

/** A short single-line summary of a node's output (fallback name). */
function summarize(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : (flat || '(空)')
}

function trimTitle(value: string, max: number): string {
  const clean = value.trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** The node's display name: the user-named title, else the turn's task
 *  prompt (the most specific, user-recognizable name), else a summary. */
function nodeName(node: { title?: string | undefined; prompt?: string | undefined; text: string }, max = 16): string {
  if (node.title !== undefined && node.title.length > 0) return node.title
  if (node.prompt !== undefined && node.prompt.length > 0) return trimTitle(node.prompt, max)
  return summarize(node.text, max)
}

/** The inspector's detail pane: node content and decisions. The native
 *  composer bar (rendered by the conversation skeleton) sits at the right
 *  rail's foot; its submission routes to the selected node through the
 *  composer submit target (continue the session's last node, fork any other). */
function InspectorDetail(props: {
  node: DrawnNode
  openFile: (path: string) => void
  onConfirm: () => void
  onPin: () => void
  onRemove: () => void
  onRename: (title: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { node, openFile, onConfirm, onPin, onRemove, onRename, onClose } = props
  const displayState = displayStateOf(node)
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState(node.title ?? '')
  return (
    <div className={css.inspectorBody}>
      <div className={css.inspectorHead}>
        <span className={css.inspectorTitle}>
          {nodeName(node, 24)}
        </span>
        <button type="button" className={css.inspectorClose} onClick={onClose}>×</button>
      </div>
      <div className={css.inspectorMeta}>
        <span className={css.inspectorBadge}>{displayState === 'settled' ? '已确认' : '待确认'}</span>
        <span>{node.depth === 0 ? '根' : '⎇'} #{node.turn} · {node.sessionId}</span>
        {node.pinned && <span>📌 已固定</span>}
        {!editingTitle ? (
          <button
            type="button"
            className={css.renameButton}
            onClick={() => { setTitleDraft(node.title ?? ''); setEditingTitle(true) }}
          >
            ✏️ 命名
          </button>
        ) : (
          <span className={css.renameRow}>
            <input
              className={css.renameInput}
              value={titleDraft}
              placeholder="节点标题"
              onChange={event => { setTitleDraft(event.currentTarget.value) }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && titleDraft.trim().length > 0) {
                  onRename(titleDraft.trim())
                  setEditingTitle(false)
                } else if (event.key === 'Escape') {
                  setEditingTitle(false)
                }
              }}
            />
            <button
              type="button"
              className={css.action}
              onClick={() => { if (titleDraft.trim().length > 0) { onRename(titleDraft.trim()); setEditingTitle(false) } }}
            >
              保存
            </button>
          </span>
        )}
      </div>
      <div className={css.inspectorText}>
        <MarkdownText text={node.text} />
      </div>
      {node.produced.length > 0 && (
        <div className={css.inspectorArtifacts}>
          <span className={css.inspectorLabel}>产出物</span>
          {node.produced.map(path => (
            <button key={path} type="button" className={css.artifactChip} onClick={() => { openFile(path) }}>
              📎 {basename(path)}
            </button>
          ))}
        </div>
      )}
      <div className={css.inspectorActions}>
        {displayState === 'pending' && (
          <button type="button" className={css.action} onClick={onConfirm}>确认</button>
        )}
        {!node.pinned && (
          <button type="button" className={css.action} onClick={onPin}>固定</button>
        )}
        <button type="button" className={css.actionDanger} onClick={onRemove}>删除</button>
      </div>
    </div>
  )
}

/** The inspector's task-suggestion pane: the agent's decomposition review
 *  list. Each suggested root task can be edited, adopted (becomes a root
 *  task), or removed; selected tasks merge into one. */
function InspectorSuggest(props: {
  suggestions: CanvasTaskSuggestionView[]
  edits: Record<string, string>
  selected: Set<string>
  onEdit: (suggestion: CanvasTaskSuggestionView, title: string) => void
  onToggleSelected: (key: string) => void
  onAdopt: (suggestion: CanvasTaskSuggestionView) => void
  onRemove: (suggestion: CanvasTaskSuggestionView) => void
  onAdoptAll: () => void
  onMerge: () => void
  onClose: () => void
}): React.JSX.Element {
  const { suggestions, edits, selected, onEdit, onToggleSelected, onAdopt, onRemove, onAdoptAll, onMerge, onClose } = props
  const selectedCount = [...selected].filter(key =>
    suggestions.some(suggestion => `${String(suggestion.batchSeq)}:${String(suggestion.index)}` === key)).length
  return (
    <div className={css.inspectorBody}>
      <div className={css.inspectorHead}>
        <span className={css.inspectorTitle}>任务建议（{String(suggestions.length)}）</span>
        <button type="button" className={css.inspectorClose} onClick={onClose}>×</button>
      </div>
      <div className={css.suggestNote}>
        Agent 拆解了以下根任务。确认后作为根节点并行执行；可编辑标题、删除、或合并选中项。
      </div>
      <div className={css.suggestList}>
        {suggestions.map(suggestion => {
          const key = `${String(suggestion.batchSeq)}:${String(suggestion.index)}`
          return (
            <div key={key} className={css.suggestItem} data-suggest-item>
              <label className={css.suggestCheck}>
                <input
                  type="checkbox"
                  checked={selected.has(key)}
                  onChange={() => { onToggleSelected(key) }}
                />
              </label>
              <div className={css.suggestBody}>
                <input
                  className={css.suggestTitleInput}
                  value={edits[key] ?? suggestion.title}
                  placeholder="任务标题"
                  onChange={event => { onEdit(suggestion, event.currentTarget.value) }}
                />
                {suggestion.detail !== undefined && (
                  <div className={css.suggestDetail}>{suggestion.detail}</div>
                )}
              </div>
              <div className={css.suggestActions}>
                <button type="button" className={css.action} onClick={() => { onAdopt(suggestion) }}>确认</button>
                <button type="button" className={css.actionDanger} onClick={() => { onRemove(suggestion) }}>删除</button>
              </div>
            </div>
          )
        })}
      </div>
      <div className={css.suggestFoot}>
        <button type="button" className={css.actionPrimary} onClick={onAdoptAll}>全部确认（并行）</button>
        <button
          type="button"
          className={css.action}
          disabled={selectedCount < 2}
          title={selectedCount < 2 ? '勾选至少两项以合并' : '合并选中为一条根任务'}
          onClick={onMerge}
        >
          合并选中{selectedCount >= 2 ? `（${String(selectedCount)}）` : ''}
        </button>
      </div>
    </div>
  )
}

/** The inspector's workflow pane: a structured pipeline the agent proposed.
 *  Each node becomes a root task when adopted; edges show the dependency
 *  plan (`to` waits for `from`) the user is approving. */
function InspectorWorkflow(props: {
  workflow: CanvasWorkflowSuggestionView
  onAdopt: () => void
  onRemove: () => void
  onSchedule: (scheduleText: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { workflow, onAdopt, onRemove, onSchedule, onClose } = props
  const [scheduleText, setScheduleText] = useState('')
  const byId = new Map(workflow.nodes.map(node => [node.id, node]))
  // Downstream count per node (how many stages wait on it).
  const dependents = new Map<string, string[]>()
  for (const edge of workflow.edges) {
    const list = dependents.get(edge.from) ?? []
    list.push(edge.to)
    dependents.set(edge.from, list)
  }
  return (
    <div className={css.inspectorBody}>
      <div className={css.inspectorHead}>
        <span className={css.inspectorTitle}>工作流（{String(workflow.nodes.length)} 步）</span>
        <button type="button" className={css.inspectorClose} onClick={onClose}>×</button>
      </div>
      <div className={css.suggestNote}>
        Agent 设计了以下工作流。确认后每一步作为根任务，按依赖顺序执行；带依赖的步骤等待前置完成。
      </div>
      <div className={css.workflowNodes}>
        {workflow.nodes.map((node, index) => {
          const next = dependents.get(node.id) ?? []
          const nextNames = next
            .map(id => byId.get(id)?.title ?? id)
            .filter(name => name.length > 0)
          return (
            <div key={node.id} className={css.workflowNode} data-workflow-node>
              <div className={css.workflowNodeIndex}>{String(index + 1)}</div>
              <div className={css.suggestBody}>
                <div className={css.workflowNodeTitle}>{node.title}</div>
                {node.detail !== undefined && <div className={css.suggestDetail}>{node.detail}</div>}
                {nextNames.length > 0 && (
                  <div className={css.workflowNodeDeps}>依赖它：{nextNames.join('、')}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className={css.workflowScheduleRow}>
        <input
          className={css.inputCustom}
          placeholder="定时执行描述，如：每天早上 9 点"
          value={scheduleText}
          onChange={event => { setScheduleText(event.currentTarget.value) }}
        />
        <button
          type="button"
          className={css.action}
          disabled={scheduleText.trim().length === 0}
          title="让 Agent 用 schedule_create 注册定时，到点自动重新执行本工作流"
          onClick={() => { onSchedule(scheduleText.trim()) }}
        >
          ⏰ 设置定时
        </button>
      </div>
      <div className={css.suggestFoot}>
        <button type="button" className={css.actionPrimary} onClick={onAdopt}>确认工作流（并行执行）</button>
        <button type="button" className={css.actionDanger} onClick={onRemove}>放弃</button>
      </div>
    </div>
  )
}

/** The inspector's results pane: every realized plan step's outputs — the
 *  "只看最终结果" summary. Opening a result jumps to its node so the user
 *  can modify it (right-rail conversation re-runs that step's branch). */
function InspectorResults(props: {
  results: { id: string; title: string; produced: string[]; text: string; key: string }[]
  onOpen: (key: string) => void
  onClose: () => void
}): React.JSX.Element {
  const { results, onOpen, onClose } = props
  return (
    <div className={css.inspectorBody}>
      <div className={css.inspectorHead}>
        <span className={css.inspectorTitle}>工作流产物（{String(results.length)}）</span>
        <button type="button" className={css.inspectorClose} onClick={onClose}>×</button>
      </div>
      <div className={css.suggestNote}>
        以下是本工作流各步骤的产出。点击一项查看详情，或在右栏输入继续修改该步骤。
      </div>
      <div className={css.workflowNodes}>
        {results.map(result => (
          <button
            key={result.id}
            type="button"
            className={css.resultItem}
            data-workflow-result
            onClick={() => { onOpen(result.key) }}
          >
            <div className={css.workflowNodeTitle}>{result.title}</div>
            <div className={css.suggestDetail}>
              {result.produced.length > 0
                ? result.produced.map(path => `📎 ${basename(path)}`).join(' · ')
                : summarize(result.text, 60)}
            </div>
            {result.produced.length === 0 && (
              <div className={css.resultModifyHint}>在右栏输入即可修改此步骤</div>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Extract the tree from a successful loadTree RemoteResult.
 * @param result - the RemoteResult whose value is the canvas tree.
 * @returns the tree, or undefined when the result is not an ok tree.
 */
function loadedTree(result: RemoteResult<CanvasTreeView>): CanvasTreeView | undefined {
  if (result.ok !== true) return undefined
  const tree = result.value
  if (typeof tree !== 'object' || tree === null || tree.root === undefined) return undefined
  return tree
}

/**
 * Render error fallback for the canvas view: a crashed render shows the
 * failure instead of a blank tab.
 */
export class CanvasErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  override state: { error: string | null } = { error: null }

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) }
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[canvas] render failed:', error, info.componentStack)
  }

  override render(): ReactNode {
    if (this.state.error !== null) {
      return <p className={css.error}>画布渲染失败：{this.state.error}</p>
    }
    return this.props.children
  }
}

/**
 * Wrap a canvas view component in the render error boundary.
 */
export function withCanvasErrorBoundary<P extends object>(View: ComponentType<P>): FunctionComponent<P> {
  return function CanvasGuarded(props: P): React.JSX.Element {
    return (
      <CanvasErrorBoundary>
        <View {...props} />
      </CanvasErrorBoundary>
    )
  }
}
