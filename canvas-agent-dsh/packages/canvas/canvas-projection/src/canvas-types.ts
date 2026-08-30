/**
 * Zero-dependency canvas node model: pure JSON types with no imports, so any
 * consumer (host fold, client render, product shell) can reference the canvas
 * vocabulary without pulling session or projection modules. The host
 * `types.ts` re-exports these alongside its `declare module` merges.
 *
 * A canvas node is ONE agent output (one turn's assembled `assistant/message`)
 * inside ONE session. The tree across sessions (fork branches) is derived from
 * session lineage by the caller; this model carries the per-session node list
 * and the user's canvas decisions.
 *
 * @module @deepseek-ai/dsh-canvas-projection/canvas-types
 */

/** JSON-safe value (lossless-JSON constraint for the Typert wire boundary). */
export type CanvasJsonValue =
  | null
  | boolean
  | number
  | string
  | CanvasJsonValue[]
  | { [key: string]: CanvasJsonValue }

/** The output text of an agent turn, extracted from its assembled message. */
export interface CanvasNodeText {
  /** Plain-text projection of the output, for card summaries and indexing. */
  text: string
  /** Content blocks verbatim (JSON-safe), for detail rendering. */
  blocks: CanvasJsonValue[]
}

/**
 * One canvas node inside a session: one agent output (a closed turn that
 * assembled an assistant message) plus its user decisions.
 */
export interface CanvasNode {
  /** Turn number this node represents. */
  turn: number
  /** Seq of the turn's first event (the `turn/start`), for boundary references. */
  startSeq: number
  /** Seq of the turn's closing event (the `turn/end`), inclusive fork boundary. */
  endSeq: number
  /** Seq of the assembled `assistant/message` event. */
  outputSeq: number
  /** The output text/blocks. */
  output: CanvasNodeText
  /** Node lifecycle state. */
  state: 'settled' | 'pending' | 'removed'
  /** Epoch ms of the output. */
  time: number
  /** Whether the user pinned (fixed) this node's output as referenceable. */
  pinned: boolean
  /** User-named canvas title (the node's identity on the canvas); absent
   *  until the user names the node. */
  title?: string | undefined
  /** The user prompt this turn executed (its task); the auto-title source. */
  prompt?: string | undefined
  /**
   * Files this turn's tool calls produced, in first-seen order (from the
   * mutation tools' follow-along locations in `tool/result` meta). Absent
   * when the turn produced no files. This is the node's deliverables.
   */
  produced?: string[] | undefined
  /**
   * The user-dragged canvas position of this node's card (canvas coordinates).
   * Absent until the user moves the card; automatic layout fills the gap.
   */
  position?: { x: number; y: number } | undefined
}

/**
 * The `canvasTree` projection value for one session: the session's outputs as
 * nodes in turn order, plus the user's canvas decisions applied to them.
 */
export interface CanvasTreeProjection {
  /** Nodes in turn order; removed nodes are absent. */
  nodes: CanvasNode[]
  /**
   * Pending task-decomposition suggestions from the agent's
   * `canvas_suggest_tasks` tool call, in proposal order. The user adopts or
   * removes each one; adopted suggestions disappear (the user's confirm prompt
   * becomes the root task), removed ones are dropped from the list.
   */
  suggestions: CanvasTaskSuggestion[]
  /**
   * A pending structured workflow proposal from the agent's
   * `canvas_suggest_workflow` tool call: named nodes plus dependency edges,
   * awaiting the user's confirm/remove decision. Adopting it pins each node
   * as a root task (and records the edges for later dependency rendering);
   * removing it drops the proposal. Absent until a workflow is proposed.
   */
  workflow?: CanvasWorkflowSuggestion | undefined
  /**
   * The adopted execution plan: after the user confirms a workflow, its nodes
   * and edges become a durable plan the canvas renders as placeholder cards
   * (queued → running → done) and a runner advances in dependency order.
   * Each plan node is anchored to a real root node by its title (the adopted
   * prompt); absent until a workflow is adopted.
   */
  workflowPlan?: CanvasWorkflowPlan | undefined
}

/**
 * One node of an adopted workflow execution plan.
 */
export interface CanvasWorkflowPlanNode {
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
 * The adopted workflow execution plan: the confirmed proposal, durable so the
 * canvas can render every planned step (even before its root task exists) and
 * a runner can advance layers in dependency order.
 */
export interface CanvasWorkflowPlan {
  /** Seq of the `canvas/suggest-workflow` event that proposed it. */
  batchSeq: number
  /** Plan nodes, in declaration order. */
  nodes: CanvasWorkflowPlanNode[]
  /** Dependency edges (`to` waits for `from`). */
  edges: CanvasWorkflowEdge[]
}

/**
 * One node of a pending structured workflow proposal.
 */
export interface CanvasWorkflowNode {
  /** Stable id within the proposal (referenced by edges). */
  id: string
  /** The task title (becomes the root-task prompt when adopted). */
  title: string
  /** Optional one-line scope/constraint. */
  detail?: string | undefined
  /** Whether this step waits for user input before it runs (per-run variable,
   *  e.g. today's topic). Absent/false = fully automatic. */
  input?: boolean | undefined
}

/**
 * One dependency edge of a pending workflow proposal: `to` waits for `from`.
 */
export interface CanvasWorkflowEdge {
  /** Source node id. */
  from: string
  /** Target node id. */
  to: string
}

/**
 * A pending structured workflow: the agent's `canvas_suggest_workflow` output
 * as durable review data — the user confirms it (each node becomes a root
 * task, edges recorded for dependency rendering) or removes it. Never fed
 * back to the model; it is the user's plan to approve or edit.
 */
export interface CanvasWorkflowSuggestion {
  /** Seq of the proposing `canvas/suggest-workflow` event (batch id). */
  batchSeq: number
  /** Proposed nodes, in declaration order. */
  nodes: CanvasWorkflowNode[]
  /** Proposed dependency edges (`to` waits for `from`). */
  edges: CanvasWorkflowEdge[]
}

/**
 * One pending task-decomposition suggestion: a root-task proposal the agent
 * wrote via `canvas_suggest_tasks`, awaiting the user's adopt/remove decision.
 * The suggestion is durable UI state (reconstructable from the log) but is
 * never fed back to the model — it is the user's review list.
 */
export interface CanvasTaskSuggestion {
  /** Seq of the `canvas/suggest-tasks` event that proposed it (batch id). */
  batchSeq: number
  /** Index within that batch, in proposal order. */
  index: number
  /** The proposed root-task title. */
  title: string
  /** Optional clarifying detail (constraints, scope, acceptance notes). */
  detail?: string | undefined
}

/**
 * One node in the cross-session canvas tree: a session (trunk or fork branch)
 * carrying its per-session node list, plus its fork children recursively.
 */
export interface CanvasSessionNode {
  /** The session's id. */
  sessionId: string
  /** Fork parent's session id; undefined for the canvas root (trunk). */
  parentSessionId?: string
  /** Number of leading events inherited from the parent via fork (seed boundary). */
  seedLength?: number
  /** This session's canvas nodes (one per agent output turn), in turn order. */
  nodes: CanvasNode[]
  /** Direct fork children, each carrying its own subtree. */
  children: CanvasSessionNode[]
}

/**
 * The whole canvas tree: a trunk session plus every fork branch descended
 * from it, each session contributing its per-session node list. This is the
 * cross-session view the canvas renders.
 */
export interface CanvasTree {
  /** The trunk session (no fork parent). */
  root: CanvasSessionNode
  /** Total sessions in the tree. */
  sessionCount: number
  /** Total canvas nodes across all sessions. */
  nodeCount: number
}
