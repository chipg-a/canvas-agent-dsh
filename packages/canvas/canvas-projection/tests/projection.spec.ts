/**
 * Unit spec for the `canvasTree` projection fold: one session's outputs
 * become canvas nodes, and the user's commit/pin/remove decisions mutate
 * node state. Covers the pure fold directly (`projectCanvasTree`) and the
 * registry-driven path.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { projectCanvasTree, canvasTreeProjectionDefinition } from '../src/projection.ts'

/** A completed turn carrying one assistant output; returns the events appended. */
function closedOutputTurn(session: import('@deepseek-ai/dsh-session').Session, turn: number, text: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `user ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test-model' } }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

async function harness(): Promise<{ ctx: Context; session: import('@deepseek-ai/dsh-session').Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  return { ctx, session: ctx.sessions.create() }
}

describe('projectCanvasTree pure fold', () => {
  it('produces one pending node per closed output turn, in turn order', () => {
    const ctx = new Context()
    const events: SessionEvent[] = []
    const append = (type: SessionEvent['type'], data: unknown, seq: number): void => {
      events.push({ type, seq, time: seq, data } as SessionEvent)
    }
    // turn 1 with output
    append('turn/start', { turn: 1 }, 1)
    append('user/message', { content: [{ type: 'text', text: 'u1' }], source: { kind: 'user' } }, 2)
    append('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'hello one' }] } }, 3)
    append('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4)
    // turn 2 with output
    append('turn/start', { turn: 2 }, 5)
    append('user/message', { content: [{ type: 'text', text: 'u2' }], source: { kind: 'user' } }, 6)
    append('assistant/message', { turn: 2, step: 1, message: { content: [{ type: 'text', text: 'hello two' }] } }, 7)
    append('turn/end', { turn: 2, reason: { kind: 'completed' } }, 8)

    const tree = projectCanvasTree(events)
    expect(tree.nodes).toHaveLength(2)
    expect(tree.nodes[0]).toMatchObject({ turn: 1, startSeq: 1, endSeq: 4, outputSeq: 3, state: 'pending', pinned: false })
    expect(tree.nodes[0]?.output.text).toBe('hello one')
    expect(tree.nodes[1]).toMatchObject({ turn: 2, state: 'pending' })
    expect(tree.nodes[1]?.output.text).toBe('hello two')
    void ctx
  })

  it('skips turns without an assembled assistant message', () => {
    const ctx = new Context()
    const events: SessionEvent[] = []
    const append = (type: SessionEvent['type'], data: unknown, seq: number): void => {
      events.push({ type, seq, time: seq, data } as SessionEvent)
    }
    append('turn/start', { turn: 1 }, 1)
    append('user/message', { content: [{ type: 'text', text: 'u1' }], source: { kind: 'user' } }, 2)
    // No assistant/message: rejected or empty turn.
    append('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'fail', code: 'UNKNOWN' } } }, 3)

    const tree = projectCanvasTree(events)
    expect(tree.nodes).toHaveLength(0)
    void ctx
  })

  it('applies node-commit to settle a pending node, keyed by outputSeq', () => {
    const ctx = new Context()
    const events: SessionEvent[] = []
    const append = (type: SessionEvent['type'], data: unknown, seq: number): void => {
      events.push({ type, seq, time: seq, data } as SessionEvent)
    }
    append('turn/start', { turn: 1 }, 1)
    append('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'x' }] } }, 2)
    append('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3)
    // Commit with the correct outputSeq settles; a wrong seq is ignored.
    append('canvas/node-commit', { turn: 1, outputSeq: 999 }, 4)
    let tree = projectCanvasTree(events)
    expect(tree.nodes[0]?.state).toBe('pending')
    append('canvas/node-commit', { turn: 1, outputSeq: 2 }, 5)
    tree = projectCanvasTree(events)
    expect(tree.nodes[0]?.state).toBe('settled')
    // Settling twice is a no-op.
    append('canvas/node-commit', { turn: 1, outputSeq: 2 }, 6)
    tree = projectCanvasTree(events)
    expect(tree.nodes[0]?.state).toBe('settled')
    void ctx
  })

  it('applies node-pin and node-remove', () => {
    const ctx = new Context()
    const events: SessionEvent[] = []
    const append = (type: SessionEvent['type'], data: unknown, seq: number): void => {
      events.push({ type, seq, time: seq, data } as SessionEvent)
    }
    append('turn/start', { turn: 1 }, 1)
    append('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'x' }] } }, 2)
    append('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3)
    append('canvas/node-pin', { turn: 1, outputSeq: 2 }, 4)
    append('canvas/node-commit', { turn: 1, outputSeq: 2 }, 5)
    let tree = projectCanvasTree(events)
    expect(tree.nodes[0]).toMatchObject({ pinned: true, state: 'settled' })
    // Remove drops the node from the view.
    append('canvas/node-remove', { turn: 1 }, 6)
    tree = projectCanvasTree(events)
    expect(tree.nodes).toHaveLength(0)
    void ctx
  })

  it('returns the same state reference for uninteresting events', () => {
    const state = canvasTreeProjectionDefinition.init()
    const unrelated = { type: 'todo/write', seq: 1, time: 1, data: { todos: [] } } as unknown as SessionEvent
    expect(canvasTreeProjectionDefinition.apply(state, unrelated)).toBe(state)
  })

  it('collects produced files from tool/result meta into the node', () => {
    const ctx = new Context()
    const events: SessionEvent[] = []
    const append = (type: SessionEvent['type'], data: unknown, seq: number): void => {
      events.push({ type, seq, time: seq, data } as SessionEvent)
    }
    append('turn/start', { turn: 1 }, 1)
    append('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'x' }] } }, 2)
    // Two mutation tool results: write (diffs) and edit (locations).
    append('tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', callId: 'c1', content: [{ type: 'text', text: 'ok' }] }] },
      meta: { diffs: [{ path: 'a.ts', oldText: null, newText: 'x' }] },
    }, 3)
    append('tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', callId: 'c2', content: [{ type: 'text', text: 'ok' }] }] },
      meta: { locations: [{ path: 'a.ts' }, { path: 'b.ts' }] },
    }, 4)
    // A read with no meta contributes nothing.
    append('tool/result', {
      turn: 1, step: 1,
      message: { content: [{ type: 'tool-result', callId: 'c3', content: [{ type: 'text', text: 'ok' }] }] },
    }, 5)
    append('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6)

    const tree = projectCanvasTree(events)
    expect(tree.nodes[0]?.produced).toEqual(['a.ts', 'b.ts'])
    void ctx
  })

  it('omits produced when the turn produced no files', () => {
    const ctx = new Context()
    const events: SessionEvent[] = []
    const append = (type: SessionEvent['type'], data: unknown, seq: number): void => {
      events.push({ type, seq, time: seq, data } as SessionEvent)
    }
    append('turn/start', { turn: 1 }, 1)
    append('assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'x' }] } }, 2)
    append('turn/end', { turn: 1, reason: { kind: 'completed' } }, 3)
    const tree = projectCanvasTree(events)
    expect(tree.nodes[0]?.produced).toBeUndefined()
    void ctx
  })

  it('folds suggest-tasks into pending suggestions and drops adopted/removed ones', () => {
    const ctx = new Context()
    const events: SessionEvent[] = []
    const append = (type: SessionEvent['type'], data: unknown, seq: number): void => {
      events.push({ type, seq, time: seq, data } as SessionEvent)
    }
    append('canvas/suggest-tasks', { tasks: [
      { title: '设计数据模型', detail: '表结构与索引' },
      { title: '实现 API 路由' },
    ] }, 1)
    let tree = projectCanvasTree(events)
    expect(tree.suggestions).toHaveLength(2)
    expect(tree.suggestions[0]).toEqual({ batchSeq: 1, index: 0, title: '设计数据模型', detail: '表结构与索引' })
    expect(tree.suggestions[1]).toEqual({ batchSeq: 1, index: 1, title: '实现 API 路由' })
    // Adopting the first and removing the second clears both.
    append('canvas/suggest-adopt', { batchSeq: 1, index: 0 }, 2)
    append('canvas/suggest-remove', { batchSeq: 1, index: 1 }, 3)
    tree = projectCanvasTree(events)
    expect(tree.suggestions).toHaveLength(0)
    // Unknown keys are no-ops.
    append('canvas/suggest-adopt', { batchSeq: 1, index: 7 }, 4)
    tree = projectCanvasTree(events)
    expect(tree.suggestions).toHaveLength(0)
    void ctx
  })

  it('ignores empty or blank-title suggestion batches', () => {
    const ctx = new Context()
    const events: SessionEvent[] = []
    const append = (type: SessionEvent['type'], data: unknown, seq: number): void => {
      events.push({ type, seq, time: seq, data } as SessionEvent)
    }
    append('canvas/suggest-tasks', { tasks: [] }, 1)
    append('canvas/suggest-tasks', { tasks: [{ title: '   ' }] }, 2)
    append('canvas/suggest-tasks', { tasks: [{ title: '有效任务' }, { title: ' ' }] }, 3)
    const tree = projectCanvasTree(events)
    expect(tree.suggestions).toHaveLength(1)
    expect(tree.suggestions[0]).toEqual({ batchSeq: 3, index: 0, title: '有效任务' })
    void ctx
  })

  it('folds suggest-workflow into a pending workflow and clears on adopt/remove', () => {
    const ctx = new Context()
    const events: SessionEvent[] = []
    const append = (type: SessionEvent['type'], data: unknown, seq: number): void => {
      events.push({ type, seq, time: seq, data } as SessionEvent)
    }
    append('canvas/suggest-workflow', {
      nodes: [
        { id: 'research', title: '调研需求', detail: '访谈与竞品' },
        { id: 'plan', title: '设计方案' },
        { id: 'build', title: '实现' },
      ],
      edges: [
        { from: 'research', to: 'plan' },
        { from: 'plan', to: 'build' },
        { from: 'unknown', to: 'build' },
        { from: 'plan', to: 'plan' },
      ],
    }, 1)
    let tree = projectCanvasTree(events)
    expect(tree.workflow).toEqual({
      batchSeq: 1,
      nodes: [
        { id: 'research', title: '调研需求', detail: '访谈与竞品' },
        { id: 'plan', title: '设计方案' },
        { id: 'build', title: '实现' },
      ],
      // Unknown references and self-edges are dropped.
      edges: [
        { from: 'research', to: 'plan' },
        { from: 'plan', to: 'build' },
      ],
    })
    append('canvas/workflow-adopt', { batchSeq: 1 }, 2)
    tree = projectCanvasTree(events)
    expect(tree.workflow).toBeUndefined()
    // A stale adopt (wrong batch) is a no-op.
    append('canvas/suggest-workflow', { nodes: [{ id: 'a', title: '甲' }], edges: [] }, 3)
    tree = projectCanvasTree(events)
    expect(tree.workflow?.batchSeq).toBe(3)
    append('canvas/workflow-adopt', { batchSeq: 9 }, 4)
    tree = projectCanvasTree(events)
    expect(tree.workflow?.batchSeq).toBe(3)
    void ctx
  })

  it('rejects workflow proposals with no valid nodes', () => {
    const ctx = new Context()
    const events: SessionEvent[] = []
    const append = (type: SessionEvent['type'], data: unknown, seq: number): void => {
      events.push({ type, seq, time: seq, data } as SessionEvent)
    }
    append('canvas/suggest-workflow', { nodes: [], edges: [] }, 1)
    append('canvas/suggest-workflow', { nodes: [{ id: ' ', title: ' ' }], edges: [] }, 2)
    const tree = projectCanvasTree(events)
    expect(tree.workflow).toBeUndefined()
    void ctx
  })
})

describe('canvasTree registry-driven path', () => {
  it('snapshots nodes and notifies on change', async () => {
    const { ctx, session } = await harness()
    ctx.sessionProjections.register(canvasTreeProjectionDefinition)
    closedOutputTurn(session, 1, 'first output')
    const snapshot = ctx.sessionProjections.snapshot(session)
    expect(snapshot.values.canvasTree).toBeDefined()
    const value = snapshot.values.canvasTree
    if (value === undefined) throw new Error('canvasTree projection missing')
    expect(value.nodes).toHaveLength(1)
    expect(value.nodes[0]?.output.text).toBe('first output')
    // Apply a user decision through the log and re-snapshot.
    const outputEvent = session.events.find(e => e.type === 'assistant/message')
    if (outputEvent === undefined) throw new Error('missing assistant/message')
    session.append('canvas/node-commit', { turn: 1, outputSeq: outputEvent.seq })
    const after = ctx.sessionProjections.snapshot(session)
    const value2 = after.values.canvasTree
    if (value2 === undefined) throw new Error('canvasTree projection missing')
    expect(value2.nodes[0]?.state).toBe('settled')
  })
})
