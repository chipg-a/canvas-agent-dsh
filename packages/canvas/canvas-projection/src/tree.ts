/**
 * Cross-session canvas tree fold: session lineage (`SessionHeader.parentSession`
 * / `seedLength`) plus each session's per-session node list produce the whole
 * canvas tree the canvas renders.
 *
 * This module is pure — no Cordis, no registry, no I/O. It consumes detached
 * facts (headers and node lists) and returns plain JSON, so it is the
 * cross-session counterpart of `projection.ts` and is directly testable and
 * replayable. Callers (a host service or a projection unit) supply the data.
 *
 * @module @deepseek-ai/dsh-canvas-projection/tree
 */

import type { CanvasNode, CanvasSessionNode, CanvasTree } from './types.ts'

/** Detached per-session input fact: the header's lineage fields plus its nodes. */
export interface CanvasSessionInput {
  /** The session's id. */
  sessionId: string
  /** Fork parent's session id; undefined for the canvas root (trunk). */
  parentSessionId?: string
  /** Number of leading events inherited from the parent via fork. */
  seedLength?: number
  /** This session's canvas nodes (one per agent output turn), in turn order. */
  nodes: CanvasNode[]
}

/**
 * Build the whole canvas tree from detached session inputs.
 *
 * The trunk is the session with no `parentSessionId`. A forest with zero or
 * several trunks is an error for a single canvas: a canvas owns exactly one
 * trunk and every other session descends from it through fork lineage. Cycles
 * are rejected. Sessions with a parent that is not among the inputs are
 * dropped from the tree (they belong to another canvas or corpus) — the trunk
 * and its descendants are the canvas.
 * @param sessions - detached session facts; at least one must be the trunk.
 * @returns the canvas tree rooted at the trunk.
 * @throws when the inputs contain no trunk, several trunks, or a lineage cycle.
 */
export function foldCanvasTree(sessions: readonly CanvasSessionInput[]): CanvasTree {
  const trunks = sessions.filter(session => session.parentSessionId === undefined)
  if (trunks.length === 0) {
    throw new Error('foldCanvasTree: no trunk session (a session without parentSessionId) in inputs')
  }
  if (trunks.length > 1) {
    throw new Error(`foldCanvasTree: ${trunks.length} trunk sessions; a canvas owns exactly one`)
  }
  const root = trunks[0] as CanvasSessionInput

  // Children per parent, in input order (callers sort by createdAt for stability).
  const childrenByParent = new Map<string, CanvasSessionInput[]>()
  for (const session of sessions) {
    const parent = session.parentSessionId
    if (parent === undefined) continue
    const children = childrenByParent.get(parent) ?? []
    children.push(session)
    childrenByParent.set(parent, children)
  }

  const seen = new Set<string>()
  const build = (input: CanvasSessionInput): CanvasSessionNode => {
    if (seen.has(input.sessionId)) {
      throw new Error(`foldCanvasTree: lineage cycle at "${input.sessionId}"`)
    }
    seen.add(input.sessionId)
    const children = (childrenByParent.get(input.sessionId) ?? []).map(build)
    return {
      sessionId: input.sessionId,
      ...(input.parentSessionId === undefined ? {} : { parentSessionId: input.parentSessionId }),
      ...(input.seedLength === undefined ? {} : { seedLength: input.seedLength }),
      nodes: input.nodes,
      children,
    }
  }

  const tree = build(root)
  // Count nodes without re-walking every level with allocations.
  let nodeCount = tree.nodes.length
  const count = (node: CanvasSessionNode): void => {
    for (const child of node.children) {
      nodeCount += child.nodes.length
      count(child)
    }
  }
  count(tree)
  return { root: tree, sessionCount: seen.size, nodeCount }
}
