/**
 * Canvas-tree host service: combines session lineage (`SessionHeader`
 * parentSession fields over the live session store) with each session's
 * per-session canvas nodes (folded from the live session log) into the whole
 * cross-session canvas tree. The service is the host-side composition layer
 * over the pure folds in `projection.ts` and `tree.ts`; it owns no state and
 * only reads.
 *
 * The trunk session id is the canvas's explicit root (recorded when the
 * canvas is created — a workspace may hold several independent sessions, so
 * "no parent" alone is not the trunk; see the design document).
 *
 * @module @deepseek-ai/dsh-canvas-projection/service
 */

import { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CanvasNode, CanvasSessionNode, CanvasTree } from './canvas-types.ts'
import { projectCanvasTree } from './projection.ts'

/** Required services: the in-memory session store. */
export const inject = ['sessions'] as const

/**
 * The canvas-tree service: query the whole canvas tree rooted at a trunk
 * session, and apply user canvas decisions (confirm/pin/remove) as session
 * events.
 */
export interface CanvasTrees {
  /**
   * Build the whole canvas tree rooted at `trunkSessionId`.
   *
   * The trunk is the canvas's explicit root; every other session descends
   * from it through fork lineage (`SessionHeader.parentSession`). Each
   * session's nodes are folded from its live event log via the `canvasTree`
   * projection logic. Sessions outside the trunk's lineage are not part of
   * this canvas. When the trunk itself is not a live session the result is an
   * empty tree (its nodes and children are empty) rather than an error, so
   * callers can render a blank canvas before the first turn.
   * @param trunkSessionId - the canvas trunk session id.
   * @returns the canvas tree rooted at the trunk.
   * @throws when the lineage contains a cycle.
   */
  treeOf(trunkSessionId: SessionId): CanvasTree

  /**
   * Confirm a pending node's output onto the canvas: append
   * `canvas/node-commit` to the node's session log. Log-only — the output
   * itself is already on the surface as its `assistant/message`; this records
   * the user's display decision.
   * @param sessionId - the session owning the node.
   * @param turn - the node's turn number.
   * @param outputSeq - the node's output event seq (guards against stale confirmations).
   * @throws when the session is not live or the event data is invalid.
   */
  confirmNode(sessionId: SessionId, turn: number, outputSeq: number): void

  /**
   * Pin a node's output as referenceable: append `canvas/node-pin`.
   * @param sessionId - the session owning the node.
   * @param turn - the node's turn number.
   * @param outputSeq - the node's output event seq.
   * @throws when the session is not live or the event data is invalid.
   */
  pinNode(sessionId: SessionId, turn: number, outputSeq: number): void

  /**
   * Remove a node from the canvas view: append `canvas/node-remove`. The
   * underlying log events stay (removal is a view decision).
   * @param sessionId - the session owning the node.
   * @param turn - the node's turn number.
   * @throws when the session is not live.
   */
  removeNode(sessionId: SessionId, turn: number): void

  /**
   * Name a node: append `canvas/node-title` — the title is the node's
   * identity on the canvas and in search, recorded as durable user intent.
   * @param sessionId - the session owning the node.
   * @param turn - the node's turn number.
   * @param outputSeq - the node's output event seq (guards stale renames).
   * @param title - the node's display title.
   * @throws when the session is not live or the title is empty.
   */
  setNodeTitle(sessionId: SessionId, turn: number, outputSeq: number, title: string): void

  /**
   * Fork a child session at a node's boundary: "deepen into this node" — the
   * canvas's core interaction. The child inherits the source session's log up
   * to the node's `endSeq` (inclusive), records `parentSession`/`seedLength`
   * lineage, and is ready for a fresh conversation rooted at that node. The
   * caller then drives the child (e.g. `followup`) to produce its own output.
   *
   * With no `executor` the fork is session-only (the host session mechanism
   * attaches an agent to the child later). With an `executor` override the
   * fork creates an agent right away on that route — model, optional agent
   * preset (mounted before publication), and optional isolated working
   * directory — mirroring the SDK `session/fork` semantics.
   * @param sessionId - the session owning the node.
   * @param turn - the node's turn number (its `endSeq` is the fork boundary).
   * @param executor - optional fork executor overrides (model/preset/cwd/permission).
   * @returns the child session's id.
   * @throws when the session is not live, the node is unknown (its turn has
   * no node in the projection), an executor override is given while the
   * agents service is unavailable, or a permission preset names an unknown
   * preset.
   */
  forkNode(
    sessionId: SessionId,
    turn: number,
    executor?: { model?: string; agentPreset?: string; cwd?: string; permission?: string },
  ): Promise<SessionId>

  /**
   * Adopt a pending task suggestion as a root task: append
   * `canvas/suggest-adopt`. The user's actual task text is the follow-up
   * prompt (sent separately); this event only records which suggestion it
   * came from, so the review list stays reconstructable.
   * @param sessionId - the session owning the suggestion batch.
   * @param batchSeq - seq of the proposing `canvas/suggest-tasks` event.
   * @param index - index of the adopted task within that batch.
   * @throws when the session is not live.
   */
  adoptSuggestion(sessionId: SessionId, batchSeq: number, index: number): void

  /**
   * Remove a pending task suggestion from the review list: append
   * `canvas/suggest-remove`. Log-only user decision; the underlying proposal
   * stays in the log.
   * @param sessionId - the session owning the suggestion batch.
   * @param batchSeq - seq of the proposing `canvas/suggest-tasks` event.
   * @param index - index of the removed task within that batch.
   * @throws when the session is not live.
   */
  removeSuggestion(sessionId: SessionId, batchSeq: number, index: number): void

  /**
   * Adopt the pending structured workflow: append `canvas/workflow-adopt`.
   * Each proposed node becomes a root task (sent separately by the caller);
   * this event records the proposal it came from so the plan is
   * reconstructable.
   * @param sessionId - the session owning the workflow proposal.
   * @param batchSeq - seq of the proposing `canvas/suggest-workflow` event.
   * @throws when the session is not live.
   */
  adoptWorkflow(sessionId: SessionId, batchSeq: number): void

  /**
   * Remove the pending structured workflow: append `canvas/workflow-remove`.
   * Log-only user decision; the underlying proposal stays in the log.
   * @param sessionId - the session owning the workflow proposal.
   * @param batchSeq - seq of the proposing `canvas/suggest-workflow` event.
   * @throws when the session is not live.
   */
  removeWorkflow(sessionId: SessionId, batchSeq: number): void

  /** Advertised permission presets a fork executor may pick. */
  permissionOptions(): { value: string; name: string }[]
}

/**
 * The `ctx.canvasTrees` service implementation, exposed through the Typert
 * Gateway so the browser can query the canvas tree and apply user decisions.
 * Remote methods take plain JSON parameters (session id, turn, output seq) —
 * no wire identity lookup — because a canvas decision may target any session
 * in the tree, not just the caller's own.
 */
export class CanvasTreeService extends TypertRemoteService implements CanvasTrees {
  /** Required services: the in-memory session store. */
  static inject = ['sessions'] as const

  /**
   * @param ctx - registrant context carrying the session store.
   */
  constructor(ctx: Context) {
    super(ctx, 'canvasTrees')
  }

  @Remote('treeOf')
  treeOf(trunkSessionId: SessionId): CanvasTree {
    const sessions = this.ctx.sessions.list()
    const byId = new Map(sessions.map(session => [String(session.id), session]))

    // Children per parent, in live-store order.
    const childrenByParent = new Map<string, typeof sessions[number][]>()
    for (const session of sessions) {
      const parent = session.header.parentSession
      if (parent === undefined) continue
      const key = String(parent)
      const children = childrenByParent.get(key) ?? []
      children.push(session)
      childrenByParent.set(key, children)
    }

    const nodesOf = (session: typeof sessions[number]): CanvasNode[] =>
      projectCanvasTree(session.events).nodes

    const seen = new Set<string>()
    const build = (session: typeof sessions[number]): CanvasSessionNode => {
      const id = String(session.id)
      if (seen.has(id)) {
        throw new Error(`canvas-projection: lineage cycle at "${id}"`)
      }
      seen.add(id)
      const header = session.header
      return {
        sessionId: id,
        ...(header.parentSession === undefined
          ? {}
          : { parentSessionId: String(header.parentSession) }),
        ...(header.seedLength === undefined ? {} : { seedLength: header.seedLength }),
        nodes: nodesOf(session),
        children: (childrenByParent.get(id) ?? []).map(build),
      }
    }

    const trunk = byId.get(String(trunkSessionId))
    if (trunk === undefined) {
      return { root: { sessionId: String(trunkSessionId), nodes: [], children: [] }, sessionCount: 0, nodeCount: 0 }
    }
    const root = build(trunk)
    const countNodes = (node: CanvasSessionNode): number =>
      node.nodes.length + node.children.reduce((sum, child) => sum + countNodes(child), 0)
    const countSessions = (node: CanvasSessionNode): number =>
      1 + node.children.reduce((sum, child) => sum + countSessions(child), 0)
    return { root, sessionCount: countSessions(root), nodeCount: countNodes(root) }
  }

  @Remote('confirmNode')
  confirmNode(sessionId: SessionId, turn: number, outputSeq: number): void {
    this.sessionOf(sessionId).append('canvas/node-commit', { turn, outputSeq })
  }

  @Remote('pinNode')
  pinNode(sessionId: SessionId, turn: number, outputSeq: number): void {
    this.sessionOf(sessionId).append('canvas/node-pin', { turn, outputSeq })
  }

  @Remote('removeNode')
  removeNode(sessionId: SessionId, turn: number): void {
    this.sessionOf(sessionId).append('canvas/node-remove', { turn })
  }

  @Remote('setNodeTitle')
  setNodeTitle(sessionId: SessionId, turn: number, outputSeq: number, title: string): void {
    if (title.trim().length === 0) {
      throw new Error('canvas-projection: node title must not be empty')
    }
    this.sessionOf(sessionId).append('canvas/node-title', { turn, outputSeq, title: title.trim() })
  }

  @Remote('forkNode')
  async forkNode(sessionId: SessionId, turn: number, executor?: {
    model?: string
    agentPreset?: string
    cwd?: string
    permission?: string
  }): Promise<SessionId> {
    const session = this.sessionOf(sessionId)
    // The node's endSeq is the inclusive fork boundary (the turn's closing
    // event). Find it from the per-session fold.
    const node = projectCanvasTree(session.events).nodes.find(candidate => candidate.turn === turn)
    if (node === undefined) {
      throw new Error(`canvas-projection: no node for turn ${turn} in session "${String(sessionId)}"`)
    }
    if (executor === undefined) {
      return this.ctx.sessions.fork(session, node.endSeq).id
    }
    // Executor override: create the child agent + session on the given route
    // (mirrors the SDK session/fork semantics).
    const agents = this.ctx.get('agents') as { create(options: unknown): Promise<unknown> } | undefined
    if (agents === undefined) {
      throw new Error('canvas-projection: forkNode executor override requires the agents service')
    }
    const boundary = node.endSeq
    const seed = session.events.slice(0, boundary + 1)
    const childId = SessionId(`canvas-fork-${randomUUID().replaceAll('-', '').slice(0, 8)}`)
    const childCwd = executor.cwd ?? session.header.cwd
    await agents.create({
      sessionId: childId,
      seed,
      meta: {
        ...childCwd === undefined ? {} : { cwd: childCwd },
        parentSession: session.id,
        seedLength: seed.length,
        ...executor.agentPreset === undefined ? {} : { agentPreset: executor.agentPreset },
      },
      ...(executor.agentPreset === undefined ? {} : {
        setup: async (agentCtx: Context): Promise<void> => {
          const presets = this.ctx.get('agentPresets') as { mount(ctx: Context, id: string): Promise<unknown> } | undefined
          if (presets === undefined) return
          await presets.mount(agentCtx, executor.agentPreset as string)
        },
      }),
      ...(executor.model === undefined ? {} : { agentOptions: { model: executor.model } }),
    })
    // An explicit permission preset switches the child session's sandbox and
    // approval knobs (recorded as durable log-only intent, like /permission).
    if (executor.permission !== undefined) {
      const permissionPresets = this.ctx.get('permissionPresets') as
        | { set(session: unknown, name: string): void; names: readonly string[] }
        | undefined
      if (permissionPresets === undefined) {
        throw new Error(`canvas-projection: forkNode permission "${executor.permission}" requires the permission-presets service`)
      }
      if (!permissionPresets.names.includes(executor.permission)) {
        throw new Error(`canvas-projection: unknown permission preset "${executor.permission}"`)
      }
      const child = this.ctx.sessions.get(childId)
      if (child !== undefined) permissionPresets.set(child, executor.permission)
    }
    return childId
  }

  /** Advertised permission presets for fork executors (value + display name). */
  @Remote('permissionOptions')
  permissionOptions(): { value: string; name: string }[] {
    const permissionPresets = this.ctx.get('permissionPresets') as
      | { names: readonly string[]; optionOf(name: string): { value: string; name: string } }
      | undefined
    if (permissionPresets === undefined) return []
    return permissionPresets.names.map(name => permissionPresets.optionOf(name))
  }

  @Remote('adoptSuggestion')
  adoptSuggestion(sessionId: SessionId, batchSeq: number, index: number): void {
    this.sessionOf(sessionId).append('canvas/suggest-adopt', { batchSeq, index })
  }

  @Remote('removeSuggestion')
  removeSuggestion(sessionId: SessionId, batchSeq: number, index: number): void {
    this.sessionOf(sessionId).append('canvas/suggest-remove', { batchSeq, index })
  }

  @Remote('adoptWorkflow')
  adoptWorkflow(sessionId: SessionId, batchSeq: number): void {
    this.sessionOf(sessionId).append('canvas/workflow-adopt', { batchSeq })
  }

  @Remote('removeWorkflow')
  removeWorkflow(sessionId: SessionId, batchSeq: number): void {
    this.sessionOf(sessionId).append('canvas/workflow-remove', { batchSeq })
  }

  /** Look up a live session by id, or throw a descriptive error. */
  private sessionOf(sessionId: SessionId): import('@deepseek-ai/dsh-session').Session {
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) {
      throw new Error(`canvas-projection: session "${String(sessionId)}" is not live`)
    }
    return session
  }
}
