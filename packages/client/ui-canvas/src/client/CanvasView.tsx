/**
 * Canvas view: the session's canvas as a three-pane workspace.
 *
 * - LEFT OUTLINE (collapsible): the session's node tree (root → children),
 *   searchable and folded to a recent window — the structural navigation.
 * - CANVAS (center): fixed-size INDEX CARDS with state badges and structure
 *   lines only — draggable, zoomable, pannable. No full text, no inputs, no
 *   action buttons on the canvas itself.
 * - RIGHT RAIL: the native DSH conversation flow (ConversationFlow) plus the
 *   rail composer — the one home for content and input.
 *
 * The canvas is a projection of the session log: nodes come from the
 * `canvasTree` projection (useProjection) plus the cross-session tree
 * (remote treeOf). A node IS the native "在新对话中分支" button: clicking it
 * opens its fork conversation in the right rail — the canvas and the
 * workspace selection stay put — and continuing that conversation grows
 * child nodes under the node. Double-click empty canvas opens the new-root
 * input.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type ErrorInfo, type FunctionComponent, type ReactNode } from 'react'
import { Component } from 'react'
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ComposerSubmitTarget } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { PendingWait, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-client-runtime/client'
import type { QuestionResponsePayload } from '@deepseek-ai/dsh-api-remotes/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { IDENTITY_PANZOOM, hitTest, screenToCanvas, zoomAt, type PanZoom } from './canvas-interaction.ts'
import {
  IconCheckOutline16,
  IconEditOutline16,
  IconGoalOutline16,
  IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
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
  /** User-dragged card position (canvas coordinates); absent until moved. */
  position?: { x: number; y: number } | undefined
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
  /** Persist a node's user-dragged card position (canvas coordinates). */
  moveNode(sessionId: SessionId, turn: number, x: number, y: number): Promise<RemoteResult<void>>
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

/** Injectable face: session id, remote actions, the prompt sender, and the
 *  composer submit-target router. */
export interface CanvasViewInjected {
  /** Session whose canvas tree this view shows. */
  sessionId: string
  /** Remote canvas decision actions (wired at apply time). */
  actions: CanvasViewRemoteActions
  /** Send a new prompt to the session (a new root node's task). */
  sendPrompt: (sessionId: string, text: string) => Promise<void>
  /**
   * Set the native composer's submit target: where the rail input goes when a
   * node is selected. `session` continues that session; `fork` forks the node
   * at its boundary and sends into the new branch; null clears back to the
   * session's own composer.
   */
  setComposerTarget: (target: ComposerSubmitTarget | null) => void
  /**
   * Point the right rail's native conversation flow at a session — the
   * selected node's conversation — without switching the workspace selection
   * (the canvas and the sidebar stay put). null returns the rail to the
   * current session's own conversation.
   */
  setRailTarget: (sessionId: string | null) => void
  /**
   * Fork a node into a new branch session (native "在新对话中分支"): the
   * branch opens in the right rail — the canvas and the workspace selection
   * stay put — and the rail composer continues it, so further messages grow
   * child nodes under the clicked node.
   * @returns the branch session id once the fork settled, or undefined when
   *   the fork failed (callers remember the branch and reload the tree).
   */
  forkToRail: (sessionId: string, turn: number) => Promise<string | undefined>
}

/** Composed view props: runtime standard props + inject face. */
export type CanvasViewProps = ConvViewProps & InjectFace<CanvasViewInjected>

/** One drawn node card with its (possibly user-moved) position. */
interface DrawnNode {
  key: string
  sessionId: string
  turn: number
  /** First log seq of the node's turn — maps to the flow message anchorSeq. */
  startSeq: number
  /** Seq of the turn's closing event (inclusive fork boundary). */
  endSeq: number
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
  /** The drawn node this node's fork session hangs under (its parent card key). */
  forkParentKey?: string | undefined
  /** Persisted user-dragged card position (canvas coordinates); absent until moved. */
  position?: { x: number; y: number } | undefined
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
 * stacked under the node it forked from (its forkParentKey), falling back to
 * the first root column when the parent card is absent.
 */
export function initialPlacement(nodes: readonly DrawnNode[], perRow = 5): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  const roots = nodes.filter(node => node.depth === 0)
  const rootX = (index: number): number => 40 + (index % perRow) * (CARD_W + CARD_GAP)
  const rootY = (index: number): number => 40 + Math.floor(index / perRow) * (CARD_H + CARD_GAP + 160)
  roots.forEach((root, index) => {
    positions.set(root.key, { x: rootX(index), y: rootY(index) })
  })
  // Children hang under the card they forked from, so a branch appears under
  // its parent node (not scattered at the first root column).
  for (const node of nodes) {
    if (node.depth === 0) continue
    const parent = node.forkParentKey === undefined ? undefined : positions.get(node.forkParentKey)
    const firstRoot = roots[0]
    const base = parent ?? (firstRoot === undefined ? undefined : positions.get(firstRoot.key))
    if (base === undefined) continue
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
  useSession,
  sessionId: injectedSessionId,
  actions,
  sendPrompt,
  setComposerTarget,
  setRailTarget,
  forkToRail,
  composerBar,
  conversationFlow,
}: CanvasViewProps): React.JSX.Element {
  // Live running bits by session id (the sidebar source): a running session's
  // canvas nodes breathe on their cards until the turn closes.
  const runningBySession = useSessions(s => s.byId)
  const isRunning = (sessionId: string): boolean => runningBySession[sessionId as SessionId]?.running === true
  // Pending question takeovers: the bottom composer seat (where ui-user-
  // questions renders) is hidden while the canvas tab is active, so the
  // canvas surfaces the question itself and answers through the shared wire
  // protocol (QuestionResponsePayload — the public api-remotes type).
  const pending = useSession(s => s.pending) ?? []
  const questionWait = pending.find((interaction): interaction is PendingWait<'question'> =>
    interaction.kind === 'question')
  // Pending approval: the native composer-seat approval is hidden while the
  // canvas tab is active, so the canvas surfaces it here and answers through
  // the same wire protocol (the approval response value shape).
  const approvalWait = pending.find((interaction): interaction is PendingWait<'approval'> =>
    interaction.kind === 'approval')
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, { selected: string[]; custom: string }>>({})
  const [remoteTree, setRemoteTree] = useState<CanvasTreeView | undefined>(undefined)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  /** Card under the pointer (shows the card action bar alongside selection). */
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  /** Inline node-rename input target; null when not renaming. */
  const [renameTarget, setRenameTarget] = useState<{
    key: string
    sessionId: string
    turn: number
    outputSeq: number
    draft: string
    initial: string
  } | null>(null)
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
  /**
   * Local fork ledger: `${sessionId}:${endSeq}` → the fork child session id.
   * Mirrors what the reloaded cross-session tree will report, so a second
   * click on the same node opens the EXISTING branch instead of forking again
   * (no race with the tree reload).
   */
  const forkCacheRef = useRef<Map<string, string>>(new Map())
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
  /** Settled position of the drag in progress (persisted on pointer-up). */
  const dragPosRef = useRef<{ x: number; y: number } | null>(null)

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

  // A turn finishing anywhere on this canvas (the trunk or a fork child)
  // may have grown new nodes: reload the cross-session tree on the running
  // true→false edge, so a fork child continued from the rail shows its new
  // nodes under its parent node without a manual refresh. First observation
  // only records the running bits (no reload on mount).
  const prevRunningRef = useRef<Readonly<Record<string, boolean>>>({})
  useEffect(() => {
    let finished = false
    for (const [id, row] of Object.entries(runningBySession)) {
      if (prevRunningRef.current[id] === true && row?.running !== true) finished = true
    }
    prevRunningRef.current = Object.fromEntries(
      Object.entries(runningBySession).map(([id, row]) => [id, row?.running === true]))
    if (finished) setReload(tick => tick + 1)
  }, [runningBySession])

  // Clear the composer submit target and the rail flow target when the canvas
  // unmounts, so a later view (trajectory, another session) starts on the
  // session's own composer and conversation.
  useEffect(() => () => {
    setComposerTarget(null)
    setRailTarget(null)
  }, [setComposerTarget, setRailTarget])

  // Reset per-session view state when the session changes (switching
  // workspaces opens a different session's canvas): node positions, viewport,
  // selection, the composer submit target, the rail flow target, and the
  // workflow sent-set must not leak across sessions.
  useEffect(() => {
    setMoved(new Map())
    setPanZoom(IDENTITY_PANZOOM)
    setSelectedKey(null)
    setRevealed(new Set())
    setCollapsed(new Set())
    setMultiSelected(new Set())
    setSuggestSelected(new Set())
    setSuggestEdits({})
    setRerunTick(0)
    setFlashKey(null)
    setComposerTarget(null)
    setRailTarget(null)
    setRailOpen(true)
    sentPlanRef.current = new Set()
    forkCacheRef.current = new Map()
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
        startSeq: node.startSeq,
        endSeq: node.endSeq,
        text: node.output.text,
        state: node.state,
        pinned: node.pinned,
        produced: node.produced ?? [],
        outputSeq: node.outputSeq,
        title: node.title,
        prompt: node.prompt,
        position: node.position,
        branch: false,
        running: isRunning(injectedSessionId),
        depth: 0,
        order,
        x: 0,
        y: 0,
      })
      order += 1
    }
    // A fork session's nodes (already filtered host-side to its own turns
    // after the seed) hang under the parent node whose endSeq equals the fork
    // boundary (`child.seedLength - 1`); that key drives initial placement.
    const walk = (session: CanvasSessionView, depth: number, forkParentKey: string | undefined): void => {
      for (const node of session.nodes) {
        nodes.push({
          key: `${session.sessionId}:${String(node.turn)}`,
          sessionId: session.sessionId,
          turn: node.turn,
          startSeq: node.startSeq,
          endSeq: node.endSeq,
          text: node.output.text,
          state: node.state,
          pinned: node.pinned,
          produced: node.produced ?? [],
          outputSeq: node.outputSeq,
          title: node.title,
          prompt: node.prompt,
          position: node.position,
          branch: true,
          running: isRunning(session.sessionId),
          depth,
          forkParentKey,
          order,
          x: 0,
          y: 0,
        })
        order += 1
      }
      for (const child of session.children) {
        const boundary = (child.seedLength ?? 0) - 1
        const parent = session.nodes.find(candidate => candidate.endSeq === boundary)
        const childParentKey = parent === undefined
          ? undefined
          : `${session.sessionId}:${String(parent.turn)}`
        walk(child, depth + 1, childParentKey)
      }
    }
    if (remoteTree !== undefined) {
      for (const child of remoteTree.root.children) {
        const boundary = (child.seedLength ?? 0) - 1
        const parent = remoteTree.root.nodes.find(candidate => candidate.endSeq === boundary)
        const parentKey = parent === undefined
          ? undefined
          : `${remoteTree.root.sessionId}:${String(parent.turn)}`
        walk(child, 1, parentKey)
      }
    }
    // Workflow plan placeholders: adopted plan nodes render as queued cards
    // until their real root task appears (matched by prompt in planStatus).
    // Placeholders carry no prompt, so the executor never mistakes them for
    // a realized step. A plan node whose root already exists (the root's
    // prompt equals the step title, or starts with `<title>：` — a step
    // refinement the user typed at the rail) renders as the real card only.
    const realizedPrompts = (sessionProjection?.nodes ?? []).map(node => node.prompt)
    const stepRealized = (title: string): boolean =>
      realizedPrompts.some(prompt => prompt !== undefined
        && (prompt === title || prompt.startsWith(`${title}：`)))
    for (const planNode of workflowPlan?.nodes ?? []) {
      const title = planNode.title.trim()
      if (title.length > 0 && stepRealized(title)) continue
      nodes.push({
        key: `plan:${String(workflowPlan?.batchSeq)}:${planNode.id}`,
        sessionId: injectedSessionId,
        turn: -1,
        startSeq: -1,
        endSeq: -1,
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

  // Placed positions: the user's drag this session wins, then the persisted
  // card position, then the automatic layout.
  const placed = useMemo(() => {
    const base = initialPlacement(visibleNodes.nodes)
    return visibleNodes.nodes.map(node => {
      const position = moved.get(node.key) ?? node.position ?? base.get(node.key)
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
  // The rail conversation follows the selection too: a selected node's
  // conversation is that node's session (a non-last node forks into the rail
  // when the user sends).
  const applyComposerTarget = useCallback((node: DrawnNode | null): void => {
    if (node === null) {
      setComposerTarget(null)
      setRailTarget(null)
      return
    }
    // A workflow plan placeholder: target the composer at the step so the
    // user's message becomes that step's refinement (sent as
    // `<step title>：<message>`; the produced root replaces the placeholder).
    if (node.planId !== undefined) {
      setComposerTarget({
        kind: 'plan-step',
        sessionId: node.sessionId as SessionId,
        title: node.title ?? '',
      })
      return
    }
    setRailTarget(node.sessionId)
    const lastOfSession = !placed.some(candidate =>
      candidate.sessionId === node.sessionId && candidate.turn > node.turn)
    setComposerTarget(lastOfSession
      ? { kind: 'session', sessionId: node.sessionId as SessionId }
      : { kind: 'fork', sessionId: node.sessionId as SessionId, turn: node.turn })
  }, [placed, setComposerTarget, setRailTarget])

  /**
   * Resolve the fork branch hanging under a node (the fork boundary equals
   * the node's endSeq; the branch inherits that many source events, so
   * `seedLength - 1` is the boundary). Checks the local fork ledger first
   * (no race with the tree reload), then the loaded cross-session tree.
   * @param sessionId - the node's session.
   * @param endSeq - the node's inclusive fork boundary.
   * @returns the branch session id, or undefined when the node has no branch yet.
   */
  const forkChildOf = useCallback((sessionId: string, endSeq: number): string | undefined => {
    const cached = forkCacheRef.current.get(`${sessionId}:${endSeq}`)
    if (cached !== undefined) return cached
    if (remoteTree === undefined) return undefined
    const walk = (session: CanvasSessionView): string | undefined => {
      for (const child of session.children) {
        if (child.parentSessionId === sessionId && (child.seedLength ?? 0) - 1 === endSeq) return child.sessionId
        const deeper = walk(child)
        if (deeper !== undefined) return deeper
      }
      return undefined
    }
    return walk(remoteTree.root)
  }, [remoteTree])

  /** Select a canvas node. The node IS the "在新对话中分支" button:
   *  - the session's LAST node is that conversation's latest turn (the rail
   *    shows the session's conversation, the composer continues it);
   *  - any other node forks into its own branch conversation — the branch
   *    opens in the right rail and continuing it grows child nodes under the
   *    node — while the canvas and the workspace selection stay put (the
   *    sidebar never switches). A node whose branch ALREADY exists (a fork
   *    hangs under it in the tree) only opens that branch — the first click
   *    creates it, later clicks just open it.
   *  A workflow plan step targets the composer only (no message yet).
   */
  const selectNode = useCallback((node: DrawnNode): void => {
    setSelectedKey(node.key)
    if (node.planId !== undefined) {
      setComposerTarget({
        kind: 'plan-step',
        sessionId: node.sessionId as SessionId,
        title: node.title ?? '',
      })
      return
    }
    const lastOfSession = !placed.some(candidate =>
      candidate.sessionId === node.sessionId && candidate.turn > node.turn)
    if (lastOfSession) {
      // The rail shows the node's own conversation; the composer continues it.
      setRailTarget(node.sessionId)
      setComposerTarget({ kind: 'session', sessionId: node.sessionId as SessionId })
      return
    }
    // The node's branch may already exist (this node was forked before): open
    // that branch instead of creating a second one.
    const existingBranch = forkChildOf(node.sessionId, node.endSeq)
    if (existingBranch !== undefined) {
      setRailTarget(existingBranch)
      setComposerTarget({ kind: 'session', sessionId: existingBranch as SessionId })
      return
    }
    // Every other node is a branch point: fork its own conversation into the
    // rail without switching the workspace, remember the branch, then reload
    // the tree so the branch subtree appears under the node.
    void forkToRail(node.sessionId, node.turn).then(childId => {
      if (childId !== undefined) forkCacheRef.current.set(`${node.sessionId}:${node.endSeq}`, childId)
      setReload(tick => tick + 1)
    })
  }, [placed, setComposerTarget, setRailTarget, forkToRail, forkChildOf])

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
      selectNode(node)
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
      // Remember the settled drag position so pointer-up can persist it.
      dragPosRef.current = { x: targetX, y: targetY }
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
    const drag = dragRef.current
    // A node card was actually dragged (pointer-move recorded a position):
    // persist the settled spot so the layout survives reloads.
    if (drag?.kind === 'node' && dragPosRef.current !== null) {
      const node = placed.find(candidate => candidate.key === drag.key)
      if (node !== undefined) {
        void actions.moveNode(node.sessionId as SessionId, node.turn, dragPosRef.current.x, dragPosRef.current.y)
      }
    }
    dragRef.current = null
    dragPosRef.current = null
    setBoxSelect(null)
  }, [placed, actions])

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

  /** Apply one decision to a specific card (the card action bar). */
  const commitNodeAction = useCallback((node: DrawnNode, op: 'confirm' | 'pin' | 'remove'): void => {
    if (op === 'confirm') void actions.confirmNode(node.sessionId as SessionId, node.turn, node.outputSeq)
    else if (op === 'pin') void actions.pinNode(node.sessionId as SessionId, node.turn, node.outputSeq)
    else void actions.removeNode(node.sessionId as SessionId, node.turn)
    setReload(tick => tick + 1)
  }, [actions])

  /** Open the inline rename input for one card (prefilled with its title). */
  const beginRename = useCallback((node: DrawnNode): void => {
    setRenameTarget({
      key: node.key,
      sessionId: node.sessionId,
      turn: node.turn,
      outputSeq: node.outputSeq,
      draft: node.title ?? '',
      initial: node.title ?? '',
    })
  }, [])

  /** Commit the inline rename (no-op on an empty or unchanged title). */
  const commitRename = useCallback((): void => {
    const target = renameTarget
    setRenameTarget(null)
    if (target === null) return
    const title = target.draft.trim()
    if (title.length === 0 || title === target.initial) return
    void actions.setNodeTitle(target.sessionId as SessionId, target.turn, target.outputSeq, title)
    setReload(tick => tick + 1)
  }, [renameTarget, actions])

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
    setReload(tick => tick + 1)
  }, [workflow, actions, injectedSessionId])

  /** Remove the workflow proposal without adopting it. */
  const dismissWorkflow = useCallback(async (): Promise<void> => {
    if (workflow === undefined) return
    await actions.removeWorkflow(injectedSessionId as SessionId, workflow.batchSeq)
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
    setReload(tick => tick + 1)
  }, [workflow, sendPrompt, injectedSessionId])

  // ---- pending question surfacing (canvas answers what the agent asks) ----
  /** Toggle one offered option on a question's draft. */
  const toggleQuestionOption = useCallback((questionId: string, label: string): void => {
    setQuestionDrafts(current => {
      const draft = current[questionId] ?? { selected: [], custom: '' }
      const selected = draft.selected.includes(label)
        ? draft.selected.filter(item => item !== label)
        : [...draft.selected, label]
      return { ...current, [questionId]: { selected, custom: '' } }
    })
  }, [])

  /** Set the free-text answer of one question's draft. */
  const setQuestionCustom = useCallback((questionId: string, custom: string): void => {
    setQuestionDrafts(current => {
      const draft = current[questionId] ?? { selected: [], custom: '' }
      return { ...current, [questionId]: { selected: draft.selected, custom } }
    })
  }, [])

  /** Deliver the answer batch through the shared question protocol. */
  const submitQuestion = useCallback(async (): Promise<void> => {
    if (questionWait === undefined) return
    const answer: QuestionResponsePayload['answer'] = {
      answers: questionWait.payload.questions.map(question => {
        const draft = questionDrafts[question.id] ?? { selected: [], custom: '' }
        const custom = draft.custom.trim()
        return {
          id: question.id,
          // A free-text answer replaces the selection on a single-select
          // question and accompanies it on multi-select (same encoding the
          // question composer uses).
          selected: custom === '' || question.multiSelect === true ? draft.selected : [],
          ...(custom === '' ? {} : { custom }),
        }
      }),
    }
    await questionWait.respond({
      ok: true,
      value: { sessionId: questionWait.sessionId, answer },
    })
    setQuestionDrafts({})
  }, [questionWait, questionDrafts])

  /** Reject the whole request (the host resolves the tool call as cancelled). */
  const skipQuestion = useCallback(async (): Promise<void> => {
    if (questionWait === undefined) return
    await questionWait.respond({
      ok: false,
      error: { code: 'cancelled', message: 'the user closed this question request on the canvas', details: {} },
    })
    setQuestionDrafts({})
  }, [questionWait])

  /** Deliver the user's approval decision (the two client-answerable outcomes). */
  const answerApproval = useCallback(async (outcome: 'allowed-once' | 'rejected'): Promise<void> => {
    if (approvalWait === undefined) return
    await approvalWait.respond({
      ok: true,
      value: {
        sessionId: approvalWait.sessionId,
        approvalId: approvalWait.payload.approvalId,
        outcome,
      },
    })
  }, [approvalWait])

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
      // Realized = a depth-0 root whose prompt equals the step title, or
      // starts with `<title>：` (a step refinement typed at the rail).
      const real = placed.find(candidate =>
        candidate.depth === 0 && candidate.prompt !== undefined
        && (candidate.prompt === node.title || candidate.prompt.startsWith(`${node.title}：`)))
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
  // collapsed rail: a step waiting for input must never stay hidden. Keyed on
  // the WAITING STEP's identity only — once the rail is open on that step,
  // the user may select any other card without this effect stealing the
  // selection back on every placed/planStatus change.
  useEffect(() => {
    if (waitingNode === undefined) return
    const placeholder = placed.find(node => node.planId === waitingNode.id)
    if (placeholder === undefined) return
    setRailOpen(true)
    setSelectedKey(placeholder.key)
    applyComposerTarget(placeholder)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingNode?.id])

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
    selectNode(node)
  }, [placed, selectNode])

  // Keyboard decisions on the selected node: c confirm / p pin / d remove;
  // f fits the whole canvas. c/p/d need a selection, f does not.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'f' || event.key === 'F') {
        fitAll()
        return
      }
      if (selectedKey === null) return
      if (event.key === 'c' || event.key === 'C') void runDecision('confirm')
      else if (event.key === 'p' || event.key === 'P') void runDecision('pin')
      else if (event.key === 'd' || event.key === 'D') void runDecision('remove')
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey) }
  }, [runDecision, selectedKey, fitAll])

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
  // Empty = no real nodes AND no adopted workflow plan: an adopted plan's
  // placeholder cards must render on a canvas that has no realized output
  // yet (a fresh session adopting a 3-step workflow shows 3 queued cards).
  const empty = trunkCount === 0
    && (remoteTree?.root.children.length ?? 0) === 0
    && (workflowPlan?.nodes.length ?? 0) === 0

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
                    hovered={hoverKey === node.key}
                    flashing={flashKey === node.key}
                    matched={outlineTree.matchedKeys.has(node.key)}
                    planStatus={node.planId === undefined ? undefined : planStatus.get(node.planId)}
                    staleWaiting={node.planId !== undefined && planStatus.get(node.planId) === 'waiting' && staleWaiting}
                    onSelect={() => { selectNode(node) }}
                    onDoubleClick={() => { selectNode(node) }}
                    onPointerDown={(_event) => { void _event }}
                    onHover={(hovered) => {
                      setHoverKey(current => hovered ? node.key : current === node.key ? null : current)
                    }}
                    onConfirm={() => { commitNodeAction(node, 'confirm') }}
                    onPin={() => { commitNodeAction(node, 'pin') }}
                    onRemove={() => { commitNodeAction(node, 'remove') }}
                    onRename={() => { beginRename(node) }}
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
            {renameTarget !== null && (() => {
              const target = placed.find(candidate => candidate.key === renameTarget.key)
              if (target === undefined) return null
              return (
                <div
                  className={css.renamePop}
                  data-canvas-rename
                  style={{
                    left: panZoom.tx + target.x * panZoom.scale,
                    top: panZoom.ty + (target.y + CARD_H + 4) * panZoom.scale,
                    width: CARD_W * panZoom.scale,
                  }}
                >
                  <input
                    autoFocus
                    value={renameTarget.draft}
                    placeholder="节点名称，回车保存"
                    onChange={(event) => {
                      const value = event.currentTarget.value
                      setRenameTarget(current => current === null
                        ? current
                        : { ...current, draft: value })
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') commitRename()
                      else if (event.key === 'Escape') setRenameTarget(null)
                    }}
                    onBlur={commitRename}
                  />
                </div>
              )
            })()}
            {empty && (
              <p className={css.empty} data-canvas-empty>
                {sessionProjection === undefined && remoteTree === undefined
                  ? '画布加载中——请先启用 canvas-projection 插件并产生对话输出。'
                  : '暂无节点——双击空白新建根任务，或先对话产生输出。'}
              </p>
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
          {/* The native conversation flow: the right rail IS the conversation
              (rendered by the session body; the canvas hosts it in the rail). */}
          {conversationFlow !== undefined && (
            <div className={css.railFlowHost} data-canvas-flow>
              {conversationFlow}
            </div>
          )}
          {/* Canvas decision cards live IN the conversation flow area: the
              workflow proposal, task suggestions, and plan results embed as
              cards right after the messages, before the composer. */}
          {workflow !== undefined && (
            <InspectorWorkflow
              workflow={workflow}
              onAdopt={() => { void adoptWorkflow() }}
              onRemove={() => { void dismissWorkflow() }}
              onSchedule={(text) => { void scheduleWorkflow(text) }}
            />
          )}
          {suggestions.length > 0 && (
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
            />
          )}
          {workflowResults.length > 0 && (
            <InspectorResults
              results={workflowResults}
              onOpen={(key) => { openWorkflowResult(key) }}
            />
          )}
          {/* Pending approval: the native composer-seat approval takeover is
              hidden while the canvas tab is active, so it renders here. */}
          {approvalWait !== undefined && (
            <div className={css.questionCard} data-canvas-approval>
              <div className={css.questionHead}>⏳ 等待审批</div>
              <div className={css.approvalBody}>
                {approvalWait.payload.reason !== undefined && (
                  <div className={css.approvalReason}>{approvalWait.payload.reason}</div>
                )}
                <div className={css.approvalMeta}>
                  工具 {approvalWait.payload.toolName} 请求执行，需你的确认
                </div>
              </div>
              <div className={css.questionActions}>
                <button type="button" className={css.action} onClick={() => { void answerApproval('rejected') }}>
                  拒绝
                </button>
                <button type="button" className={css.actionPrimary} onClick={() => { void answerApproval('allowed-once') }}>
                  允许一次
                </button>
              </div>
            </div>
          )}
            {questionWait !== undefined && (
              <div className={css.questionCard} data-canvas-question>
                <div className={css.questionHead}>🤔 Agent 需要确认</div>
                {questionWait.payload.questions.map(question => {
                  const draft = questionDrafts[question.id] ?? { selected: [], custom: '' }
                  return (
                    <div key={question.id} className={css.questionItem}>
                      <div className={css.questionText}>{question.question}</div>
                      {(question.options ?? []).length > 0 && (
                        <div className={css.questionOptions}>
                          {question.options?.map(option => (
                            <button
                              key={option.label}
                              type="button"
                              className={`${css.questionOption} ${draft.selected.includes(option.label) ? css.questionOptionSelected : ''}`}
                              onClick={() => { toggleQuestionOption(question.id, option.label) }}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      )}
                      <input
                        className={css.questionInput}
                        placeholder="或输入你的回答…"
                        value={draft.custom}
                        onChange={event => { setQuestionCustom(question.id, event.currentTarget.value) }}
                      />
                    </div>
                  )
                })}
                <div className={css.questionActions}>
                  <button type="button" className={css.action} onClick={() => { void skipQuestion() }}>跳过</button>
                  <button type="button" className={css.actionPrimary} onClick={() => { void submitQuestion() }}>提交回答</button>
                </div>
              </div>
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

/** One small action button drawn inside a card's action bar (SVG icon). */
function CardActionButton(props: {
  x: number
  y: number
  w: number
  label: string
  icon: React.ReactNode
  danger?: boolean
  onAct: () => void
}): React.JSX.Element {
  const { x, y, w, label, icon, danger, onAct } = props
  const h = 18
  return (
    <g
      className={danger ? css.cardActionDanger : css.cardActionBtn}
      role="button"
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation()
        onAct()
      }}
      onPointerDown={(event) => { event.stopPropagation() }}
    >
      <rect x={x} y={y} width={w} height={h} />
      <g transform={`translate(${x + w / 2 - 7}, ${y + (h - 14) / 2})`}>
        {icon}
      </g>
    </g>
  )
}

/** One canvas index card: fixed size, summary title + badges only. */
function CanvasIndexCard(props: {
  node: DrawnNode
  selected: boolean
  hovered: boolean
  flashing: boolean
  matched: boolean
  planStatus: 'queued' | 'ready' | 'running' | 'done' | 'waiting' | undefined
  staleWaiting: boolean
  onSelect: () => void
  onDoubleClick: () => void
  onPointerDown: (event: React.PointerEvent) => void
  onHover: (hovered: boolean) => void
  onConfirm: () => void
  onPin: () => void
  onRemove: () => void
  onRename: () => void
}): React.JSX.Element {
  const {
    node, selected, hovered, flashing, matched, planStatus, staleWaiting,
    onSelect, onDoubleClick, onPointerDown, onHover,
    onConfirm, onPin, onRemove, onRename,
  } = props
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
  // The card action bar (confirm/pin/remove/rename) shows on selection or
  // hover — the node's operation entry point, on the card itself.
  const showActions = !isPlan && (selected || hovered)
  const actionY = node.y + CARD_H - 22
  const actionW = 44
  const actionGap = 3
  const actionButtons: React.JSX.Element[] = []
  let actionX = node.x + 4
  const pushAction = (label: string, icon: React.ReactNode, danger: boolean, onAct: () => void): void => {
    actionButtons.push((
      <CardActionButton key={label} x={actionX} y={actionY} w={actionW} label={label} icon={icon} danger={danger} onAct={onAct} />
    ))
    actionX += actionW + actionGap
  }
  if (displayState === 'pending' && !node.running) pushAction('确认', <IconCheckOutline16 size={14} />, false, onConfirm)
  pushAction(node.pinned ? '取消固定' : '固定', <IconGoalOutline16 size={14} />, false, onPin)
  pushAction('删除', <IconTrashOutline16 size={14} />, true, onRemove)
  pushAction('命名', <IconEditOutline16 size={14} />, false, onRename)
  return (
    <g
      data-node={node.key}
      data-state={isPlan ? 'plan' : displayState}
      data-running={node.running || undefined}
      className={selected ? css.cardSelected : undefined}
      onPointerDown={(event) => { onPointerDown(event) }}
      onPointerEnter={() => { onHover(true) }}
      onPointerLeave={() => { onHover(false) }}
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
      {showActions && <g className={css.cardActionBar}>{actionButtons}</g>}
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

/** The task-suggestion card embedded in the conversation flow: the agent's
 *  decomposition review list. Each suggested root task can be edited, adopted
 *  (becomes a root task), or removed; selected tasks merge into one. */
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
}): React.JSX.Element {
  const { suggestions, edits, selected, onEdit, onToggleSelected, onAdopt, onRemove, onAdoptAll, onMerge } = props
  const selectedCount = [...selected].filter(key =>
    suggestions.some(suggestion => `${String(suggestion.batchSeq)}:${String(suggestion.index)}` === key)).length
  return (
    <div className={css.flowCard} data-canvas-suggest-card>
      <div className={css.inspectorHead}>
        <span className={css.inspectorTitle}>任务建议（{String(suggestions.length)}）</span>
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

/** The workflow proposal card embedded in the conversation flow: a structured
 *  pipeline the agent proposed. Each node becomes a root task when adopted;
 *  edges show the dependency plan (`to` waits for `from`) the user is
 *  approving. */
function InspectorWorkflow(props: {
  workflow: CanvasWorkflowSuggestionView
  onAdopt: () => void
  onRemove: () => void
  onSchedule: (scheduleText: string) => void
}): React.JSX.Element {
  const { workflow, onAdopt, onRemove, onSchedule } = props
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
    <div className={css.flowCard} data-canvas-workflow-card>
      <div className={css.inspectorHead}>
        <span className={css.inspectorTitle}>工作流（{String(workflow.nodes.length)} 步）</span>
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

/** The plan results card embedded in the conversation flow: every realized
 *  plan step's outputs — the "只看最终结果" summary. Opening a result jumps to
 *  its node so the user can modify it (right-rail conversation re-runs that
 *  step's branch). */
function InspectorResults(props: {
  results: { id: string; title: string; produced: string[]; text: string; key: string }[]
  onOpen: (key: string) => void
}): React.JSX.Element {
  const { results, onOpen } = props
  return (
    <div className={css.flowCard} data-canvas-results-card>
      <div className={css.inspectorHead}>
        <span className={css.inspectorTitle}>工作流产物（{String(results.length)}）</span>
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
