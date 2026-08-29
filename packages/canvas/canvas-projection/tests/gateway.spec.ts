/**
 * Gateway integration spec for the canvasTrees Remote service: the @Remote
 * methods must be resolvable and invocable through the Typert Gateway, which
 * is the host side of what the browser's ctx.remote calls.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { CanvasTreeService } from '../src/service.ts'

function outputTurn(session: import('@deepseek-ai/dsh-session').Session, turn: number, text: string): void {
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

async function setup(): Promise<{ ctx: Context; trunkSessionId: string }> {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(CanvasTreeService)
  const trunk = ctx.sessions.create(SessionId('trunk'), { meta: { cwd: '/ws' } })
  outputTurn(trunk, 1, 'trunk output')
  return { ctx, trunkSessionId: String(trunk.id) }
}

describe('canvasTrees Typert Gateway integration', () => {
  it('invokes treeOf through the gateway', async () => {
    const { ctx, trunkSessionId } = await setup()
    const result = await ctx.typertGateway.invoke({
      namespace: 'canvasTrees',
      method: 'treeOf',
      args: { trunkSessionId },
    })
    const tree = result as { root: { sessionId: string; nodes: unknown[] }; sessionCount: number; nodeCount: number }
    expect(tree.root.sessionId).toBe(trunkSessionId)
    expect(tree.root.nodes).toHaveLength(1)
    expect(tree.sessionCount).toBe(1)
    expect(tree.nodeCount).toBe(1)
  })

  it('invokes confirmNode through the gateway and the tree reflects it', async () => {
    const { ctx, trunkSessionId } = await setup()
    const before = await ctx.typertGateway.invoke({
      namespace: 'canvasTrees',
      method: 'treeOf',
      args: { trunkSessionId },
    }) as { root: { nodes: { turn: number; outputSeq: number; state: string }[] } }
    const node = before.root.nodes[0]
    if (node === undefined) throw new Error('missing node')
    await ctx.typertGateway.invoke({
      namespace: 'canvasTrees',
      method: 'confirmNode',
      args: { sessionId: trunkSessionId, turn: node.turn, outputSeq: node.outputSeq },
    })
    const after = await ctx.typertGateway.invoke({
      namespace: 'canvasTrees',
      method: 'treeOf',
      args: { trunkSessionId },
    }) as { root: { nodes: { state: string }[] } }
    expect(after.root.nodes[0]?.state).toBe('settled')
  })
})
