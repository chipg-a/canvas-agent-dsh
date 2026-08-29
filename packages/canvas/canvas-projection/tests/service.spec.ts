/**
 * Unit spec for the canvas-tree host service: combines live session lineage
 * with per-session canvas folds into the whole canvas tree.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { CanvasTreeService } from '../src/service.ts'

function outputTurn(session: Session, turn: number, text: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `u${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test-model' } }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

async function setup(): Promise<{ ctx: Context; trunk: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  const trunk = ctx.sessions.create(SessionId('trunk'), { meta: { cwd: '/ws' } })
  outputTurn(trunk, 1, 'trunk output')
  // Fork a branch (lineage: parentSession + seedLength recorded).
  const branch = ctx.sessions.fork(trunk, undefined, SessionId('branch'))
  outputTurn(branch, 1, 'branch output')
  return { ctx, trunk }
}

describe('CanvasTreeService.treeOf', () => {
  it('builds the tree from the trunk with fork branches and per-session nodes', async () => {
    const { ctx, trunk } = await setup()
    const service = new CanvasTreeService(ctx)
    const tree = service.treeOf(trunk.id)

    expect(tree.root.sessionId).toBe(String(trunk.id))
    expect(tree.root.parentSessionId).toBeUndefined()
    expect(tree.root.nodes).toHaveLength(1)
    expect(tree.root.nodes[0]?.output.text).toBe('trunk output')
    expect(tree.root.children).toHaveLength(1)
    const branch = tree.root.children[0]
    if (branch === undefined) throw new Error('missing branch child')
    expect(branch.parentSessionId).toBe(String(trunk.id))
    expect(branch.seedLength).toBeGreaterThan(0)
    expect(branch.nodes).toHaveLength(1)
    expect(branch.nodes[0]?.output.text).toBe('branch output')
    expect(tree.sessionCount).toBe(2)
    expect(tree.nodeCount).toBe(2)
  })

  it('returns an empty tree for an unknown trunk', async () => {
    const { ctx } = await setup()
    const service = new CanvasTreeService(ctx)
    const tree = service.treeOf(SessionId('missing'))
    expect(tree.root.sessionId).toBe('missing')
    expect(tree.root.nodes).toHaveLength(0)
    expect(tree.root.children).toHaveLength(0)
    expect(tree.sessionCount).toBe(0)
    expect(tree.nodeCount).toBe(0)
  })

  it('ignores sessions outside the trunk lineage', async () => {
    const { ctx, trunk } = await setup()
    // An unrelated independent session: not a child of the trunk.
    ctx.sessions.create(SessionId('other'), { meta: { cwd: '/ws' } })
    const service = new CanvasTreeService(ctx)
    const tree = service.treeOf(trunk.id)
    expect(tree.root.children).toHaveLength(1)
    expect(tree.sessionCount).toBe(2)
  })

  it('confirmNode settles the node in the tree via the session log', async () => {
    const { ctx, trunk } = await setup()
    const service = new CanvasTreeService(ctx)
    const trunkNode = service.treeOf(trunk.id).root.nodes[0]
    if (trunkNode === undefined) throw new Error('missing trunk node')
    expect(trunkNode.state).toBe('pending')
    service.confirmNode(trunk.id, trunkNode.turn, trunkNode.outputSeq)
    const after = service.treeOf(trunk.id).root.nodes[0]
    if (after === undefined) throw new Error('missing node after confirm')
    expect(after.state).toBe('settled')
    // The decision is a log event: replay the fold from the log.
    expect(trunk.events.some(e => e.type === 'canvas/node-commit')).toBe(true)
  })

  it('pinNode marks the node pinned; removeNode drops it from the tree', async () => {
    const { ctx, trunk } = await setup()
    const service = new CanvasTreeService(ctx)
    const node = service.treeOf(trunk.id).root.nodes[0]
    if (node === undefined) throw new Error('missing node')
    service.pinNode(trunk.id, node.turn, node.outputSeq)
    let after = service.treeOf(trunk.id).root.nodes[0]
    if (after === undefined) throw new Error('missing node after pin')
    expect(after.pinned).toBe(true)
    service.removeNode(trunk.id, node.turn)
    after = service.treeOf(trunk.id).root.nodes[0]
    expect(after).toBeUndefined()
    expect(service.treeOf(trunk.id).root.nodes).toHaveLength(0)
    // The underlying output events stay in the log.
    expect(trunk.events.some(e => e.type === 'assistant/message')).toBe(true)
  })

  it('throws when confirming a node on a non-live session', async () => {
    const { ctx } = await setup()
    const service = new CanvasTreeService(ctx)
    expect(() => service.confirmNode(SessionId('missing'), 1, 1)).toThrow(/not live/)
  })

  it('forkNode deepens into a node: child inherits lineage and the node boundary', async () => {
    const { ctx, trunk } = await setup()
    const service = new CanvasTreeService(ctx)
    const trunkNode = service.treeOf(trunk.id).root.nodes[0]
    if (trunkNode === undefined) throw new Error('missing trunk node')
    const childId = await service.forkNode(trunk.id, trunkNode.turn)
    const child = ctx.sessions.get(childId)
    if (child === undefined) throw new Error('child session missing')
    expect(child.header.parentSession).toBe(trunk.id)
    expect(child.header.seedLength).toBe(trunkNode.endSeq + 1)
    // The child inherited the trunk's log up to the node boundary; its own
    // next turn continues from there.
    const tree = service.treeOf(trunk.id)
    expect(tree.root.children.some(child => child.sessionId === String(childId))).toBe(true)
  })

  it('forkNode rejects an unknown turn', async () => {
    const { ctx, trunk } = await setup()
    const service = new CanvasTreeService(ctx)
    await expect(service.forkNode(trunk.id, 999)).rejects.toThrow(/no node for turn 999/)
  })

  it('forkNode with an executor creates the child agent on the given route', async () => {
    const { ctx, trunk } = await setup()
    const creates: Record<string, unknown>[] = []
    ctx.provide('agents', {
      create: async (options: Record<string, unknown>): Promise<unknown> => {
        creates.push(options)
        return { agent: { id: options.sessionId }, dispose: async () => {} }
      },
    })
    const service = new CanvasTreeService(ctx)
    const trunkNode = service.treeOf(trunk.id).root.nodes[0]
    if (trunkNode === undefined) throw new Error('missing trunk node')
    const childId = await service.forkNode(trunk.id, trunkNode.turn, {
      model: 'deepseek-reasoner',
      agentPreset: 'reviewer',
      cwd: '/ws/branch-work',
    })
    expect(String(childId)).toMatch(/^canvas-fork-/)
    // The child agent+session creation carried the node boundary as seed and
    // the executor overrides (model/preset/cwd) plus durable lineage.
    expect(creates).toHaveLength(1)
    const options = creates[0] as {
      seed: unknown[]
      meta: { parentSession: unknown; seedLength: number; cwd: string; agentPreset: string }
      agentOptions: { model: string }
      setup: unknown
    }
    expect(options.seed).toHaveLength(trunkNode.endSeq + 1)
    expect(options.meta.parentSession).toBe(trunk.id)
    expect(options.meta.seedLength).toBe(trunkNode.endSeq + 1)
    expect(options.meta.cwd).toBe('/ws/branch-work')
    expect(options.meta.agentPreset).toBe('reviewer')
    expect(options.agentOptions).toEqual({ model: 'deepseek-reasoner' })
    // The preset mount setup is wired for the child composition.
    expect(typeof options.setup).toBe('function')
  })

  it('forkNode executor without the agents service fails loud', async () => {
    const { ctx, trunk } = await setup()
    const service = new CanvasTreeService(ctx)
    await expect(service.forkNode(trunk.id, 1, { model: 'deepseek-r1' }))
      .rejects.toThrow(/executor override requires the agents service/)
  })

  it('forkNode applies an executor permission preset to the child session', async () => {
    const { ctx, trunk } = await setup()
    const applied: { session: unknown; name: string }[] = []
    ctx.provide('agents', {
      create: async (options: { sessionId: SessionId; seed?: unknown[]; meta?: Record<string, unknown> }): Promise<unknown> => {
        // The real agent factory creates the session too; mirror that so the
        // permission switch finds the live child.
        ctx.sessions.create(options.sessionId, {
          ...options.seed === undefined ? {} : { seed: options.seed as never },
          ...options.meta === undefined ? {} : { meta: options.meta as never },
        })
        return { agent: { id: options.sessionId }, dispose: async () => {} }
      },
    })
    ctx.provide('permissionPresets', {
      names: ['workspace-write', 'readonly'],
      set: (session: unknown, name: string) => { applied.push({ session, name }) },
    })
    const service = new CanvasTreeService(ctx)
    const trunkNode = service.treeOf(trunk.id).root.nodes[0]
    if (trunkNode === undefined) throw new Error('missing trunk node')
    const childId = await service.forkNode(trunk.id, trunkNode.turn, { permission: 'readonly' })
    expect(String(childId)).toMatch(/^canvas-fork-/)
    expect(applied).toHaveLength(1)
    expect(applied[0]?.name).toBe('readonly')
  })

  it('forkNode rejects an unknown permission preset', async () => {
    const { ctx, trunk } = await setup()
    ctx.provide('agents', {
      create: async (options: Record<string, unknown>): Promise<unknown> => {
        return { agent: { id: options.sessionId }, dispose: async () => {} }
      },
    })
    ctx.provide('permissionPresets', {
      names: ['workspace-write'],
      set: () => {},
    })
    const service = new CanvasTreeService(ctx)
    await expect(service.forkNode(trunk.id, 1, { permission: 'nope' }))
      .rejects.toThrow(/unknown permission preset "nope"/)
  })

  it('permissionOptions advertises the permission preset table', async () => {
    const { ctx } = await setup()
    ctx.provide('permissionPresets', {
      names: ['workspace-write', 'readonly'],
      optionOf: (name: string) => ({ value: name, name: name === 'readonly' ? '只读' : name }),
    })
    const service = new CanvasTreeService(ctx)
    expect(service.permissionOptions()).toEqual([
      { value: 'workspace-write', name: 'workspace-write' },
      { value: 'readonly', name: '只读' },
    ])
  })

  it('setNodeTitle names a node and the projection carries the title', async () => {
    const { ctx, trunk } = await setup()
    const service = new CanvasTreeService(ctx)
    const trunkNode = service.treeOf(trunk.id).root.nodes[0]
    if (trunkNode === undefined) throw new Error('missing trunk node')
    service.setNodeTitle(trunk.id, trunkNode.turn, trunkNode.outputSeq, '设计数据模型')
    const named = service.treeOf(trunk.id).root.nodes[0]
    expect(named?.title).toBe('设计数据模型')
    // The title event is durable in the log (model-visible ⟺ logged).
    expect(trunk.events.some(e => e.type === 'canvas/node-title' && e.data.title === '设计数据模型')).toBe(true)
  })

  it('setNodeTitle rejects an empty title', async () => {
    const { ctx, trunk } = await setup()
    const service = new CanvasTreeService(ctx)
    expect(() => service.setNodeTitle(trunk.id, 1, 1, '  ')).toThrow(/title must not be empty/)
  })
})
