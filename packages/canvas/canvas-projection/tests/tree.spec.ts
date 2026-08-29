/**
 * Unit spec for the cross-session canvas tree fold: session lineage plus
 * per-session node lists produce the whole canvas tree.
 */

import { describe, expect, it } from 'vitest'
import { foldCanvasTree, type CanvasSessionInput } from '../src/tree.ts'
import type { CanvasNode } from '../src/canvas-types.ts'

function node(turn: number): CanvasNode {
  return {
    turn,
    startSeq: turn * 10,
    endSeq: turn * 10 + 4,
    outputSeq: turn * 10 + 3,
    output: { text: `output ${turn}`, blocks: [{ type: 'text', text: `output ${turn}` }] },
    state: 'settled',
    time: turn * 1000,
    pinned: false,
  }
}

function session(id: string, nodes: CanvasNode[], parentSessionId?: string, seedLength?: number): CanvasSessionInput {
  return {
    sessionId: id,
    nodes,
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(seedLength === undefined ? {} : { seedLength }),
  }
}

describe('foldCanvasTree', () => {
  it('builds a trunk with fork children, carrying per-session nodes', () => {
    const trunk = session('trunk', [node(1), node(2)])
    const branchA = session('branch-a', [node(1)], 'trunk', 40)
    const branchB = session('branch-b', [node(1), node(2)], 'trunk', 40)
    const deep = session('branch-a-1', [node(1)], 'branch-a', 50)

    const tree = foldCanvasTree([trunk, branchA, branchB, deep])

    expect(tree.root.sessionId).toBe('trunk')
    expect(tree.root.nodes).toHaveLength(2)
    expect(tree.root.children).toHaveLength(2)
    const a = tree.root.children.find(c => c.sessionId === 'branch-a')
    expect(a).toBeDefined()
    expect(a?.parentSessionId).toBe('trunk')
    expect(a?.seedLength).toBe(40)
    expect(a?.nodes).toHaveLength(1)
    expect(a?.children).toHaveLength(1)
    expect(a?.children[0]?.sessionId).toBe('branch-a-1')
    expect(tree.sessionCount).toBe(4)
    expect(tree.nodeCount).toBe(2 + 1 + 2 + 1)
  })

  it('returns an empty-root tree when the trunk has no nodes and no children', () => {
    const trunk = session('trunk', [])
    const tree = foldCanvasTree([trunk])
    expect(tree.root.nodes).toHaveLength(0)
    expect(tree.root.children).toHaveLength(0)
    expect(tree.sessionCount).toBe(1)
    expect(tree.nodeCount).toBe(0)
  })

  it('rejects zero trunks (all sessions have a parent)', () => {
    const a = session('a', [], 'b')
    const b = session('b', [], 'a')
    expect(() => foldCanvasTree([a, b])).toThrow(/no trunk/)
  })

  it('rejects multiple trunks', () => {
    const a = session('a', [])
    const b = session('b', [])
    expect(() => foldCanvasTree([a, b])).toThrow(/exactly one/)
  })

  it('rejects a lineage cycle (one session reached twice via different parents)', () => {
    // trunk → a → b → a' where a' reuses id 'a': build reaches 'a' a second
    // time through b, which the `seen` guard rejects as a cycle.
    const trunk = session('trunk', [])
    const a1 = session('a', [], 'trunk')
    const b = session('b', [], 'a')
    const a2 = session('a', [], 'b')
    expect(() => foldCanvasTree([trunk, a1, b, a2])).toThrow(/cycle/)
  })

  it('drops sessions whose parent is outside the inputs', () => {
    const trunk = session('trunk', [node(1)])
    const orphan = session('orphan', [node(1)], 'outside')
    const tree = foldCanvasTree([trunk, orphan])
    expect(tree.root.children).toHaveLength(0)
    expect(tree.sessionCount).toBe(1)
    expect(tree.nodeCount).toBe(1)
  })
})
