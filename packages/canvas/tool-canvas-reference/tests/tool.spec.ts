/**
 * Unit spec for the canvas memory tools: registration, authority checks, and
 * the reference flow (list candidates, prepare a snapshot, inject it into the
 * calling agent's inbox).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SessionReferenceResolver from '@deepseek-ai/dsh-session-reference'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { createUserMessage, createAssistantMessage, CallId } from '@deepseek-ai/dsh-llm'
import * as toolCanvasReference from '../src/index.ts'

const testToolSignal = new AbortController().signal

/** SessionQuery engine with only the read surface path (no FTS). */
class TestSessionQueryEngine extends SessionQueryEngine {
  override searchSessions(): ReturnType<SessionQueryEngine['searchSessions']> {
    return Promise.resolve({ items: [] })
  }
  override searchEvents(...args: Parameters<SessionQueryEngine['searchEvents']>): ReturnType<SessionQueryEngine['searchEvents']> {
    return this.readSurface(args[0].sessionId).then(surface => ({ session: surface.session, items: [] }))
  }
}

function stubAgent(rawId: string, supplied?: Session): { agent: Agent; session: Session } {
  const session = supplied ?? Session.create(SessionId(rawId))
  let status: AgentStatus = 'running'
  const agent: Agent = {
    id: session.id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    get status() { return status },
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject(input) { this.inbox.append('next-step', input) },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle() { return Promise.resolve() },
  }
  return { agent, session }
}

function conversation(session: Session, turn: number, text: string): void {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `user ${turn}` }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text }], source: { provider: 'test', model: 'test' } }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

async function harness() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(TestSessionQueryEngine)
  await ctx.plugin(SessionReferenceResolver)
  await ctx.plugin(toolCanvasReference)
  return ctx
}

async function execute(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: Agent,
  initiator: Agent | undefined = agent,
): Promise<ToolExecutionResult> {
  const run = () => ctx.tools.execute({
    signal: testToolSignal,
    callId: CallId(`call-${Math.random()}`),
    name,
    arguments: args,
    ...agent === undefined ? {} : { agent },
  })
  return initiator === undefined ? run() : ctx.agents.withInitiator(initiator, run)
}

describe('canvas memory tools', () => {
  it('registers both tools and lists candidate sessions excluding self', async () => {
    const ctx = await harness()
    expect(ctx.tools.get('canvas_reference')?.name).toBe('canvas_reference')
    expect(ctx.tools.get('canvas_reference_list')?.name).toBe('canvas_reference_list')

    const root = stubAgent(`root-${Math.random()}`)
    ctx.agents.register(root.agent)
    ctx.sessions.create(SessionId('branch-a'), { meta: { cwd: '/ws' } })
    const result = await execute(ctx, 'canvas_reference_list', {}, root.agent, root.agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('expected text result')
    const parsed = JSON.parse(block.text) as { ok: boolean; candidates: { sessionId: string }[] }
    expect(parsed.ok).toBe(true)
    expect(parsed.candidates.some(c => c.sessionId === 'branch-a')).toBe(true)
    expect(parsed.candidates.some(c => c.sessionId === String(root.agent.id))).toBe(false)
  })

  it('injects a referenced session snapshot into the calling agent inbox', async () => {
    const ctx = await harness()
    const root = stubAgent(`root-${Math.random()}`)
    ctx.agents.register(root.agent)
    const branch = ctx.sessions.create(SessionId('branch-b'), { meta: { cwd: '/ws' } })
    conversation(branch, 1, 'branch memory content')

    const result = await execute(ctx, 'canvas_reference', { session_id: 'branch-b' }, root.agent, root.agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    // The injected context landed in the root agent's inbox (next-step input).
    const injected = root.agent.inbox.nextStep
    expect(injected.some(item => {
      const content = item.content[0]
      return content?.type === 'text' && content.text.includes('Referenced sessions')
    })).toBe(true)
  })

  it('rejects referencing the calling session itself', async () => {
    const ctx = await harness()
    const root = stubAgent(`root-${Math.random()}`)
    ctx.agents.register(root.agent)
    const result = await execute(ctx, 'canvas_reference', { session_id: String(root.agent.id) }, root.agent, root.agent)
    expect(result.isError).toBe(true)
  })

  it('canvas_suggest_tasks writes the proposed tasks as a log event', async () => {
    const ctx = await harness()
    const root = stubAgent(`root-${Math.random()}`)
    ctx.agents.register(root.agent)
    const result = await execute(ctx, 'canvas_suggest_tasks', {
      tasks: [
        { title: '设计数据模型', detail: '表结构与索引' },
        { title: '实现 API 路由' },
      ],
    }, root.agent, root.agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const block = result.content[0]
    if (block?.type !== 'text') throw new Error('expected text result')
    const parsed = JSON.parse(block.text) as { ok: boolean; count: number }
    expect(parsed.ok).toBe(true)
    expect(parsed.count).toBe(2)
    const event = root.session.events.find(e => e.type === 'canvas/suggest-tasks')
    expect(event).toBeDefined()
    if (event === undefined) throw new Error('missing suggest-tasks event')
    expect(event.data).toEqual({ tasks: [
      { title: '设计数据模型', detail: '表结构与索引' },
      { title: '实现 API 路由' },
    ] })
  })

  it('canvas_suggest_tasks rejects an empty list and trims blank titles', async () => {
    const ctx = await harness()
    const root = stubAgent(`root-${Math.random()}`)
    ctx.agents.register(root.agent)
    const empty = await execute(ctx, 'canvas_suggest_tasks', { tasks: [] }, root.agent, root.agent)
    expect(empty.isError).toBe(true)
    const blank = await execute(ctx, 'canvas_suggest_tasks', { tasks: [{ title: '  ' }] }, root.agent, root.agent)
    expect(blank.isError).toBe(true)
    expect(root.session.events.filter(e => e.type === 'canvas/suggest-tasks')).toHaveLength(0)
  })

  it('canvas_suggest_workflow writes nodes and cleaned edges as a log event', async () => {
    const ctx = await harness()
    const root = stubAgent(`root-${Math.random()}`)
    ctx.agents.register(root.agent)
    const result = await execute(ctx, 'canvas_suggest_workflow', {
      nodes: [
        { id: 'research', title: '调研需求', detail: '访谈与竞品' },
        { id: 'build', title: '实现' },
      ],
      edges: [
        { from: 'research', to: 'build' },
        { from: 'missing', to: 'build' },
        { from: 'build', to: 'build' },
      ],
    }, root.agent, root.agent)
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected success')
    const event = root.session.events.find(e => e.type === 'canvas/suggest-workflow')
    expect(event).toBeDefined()
    if (event === undefined) throw new Error('missing suggest-workflow event')
    // Unknown and self edges are dropped; nodes trimmed.
    expect(event.data).toEqual({
      nodes: [
        { id: 'research', title: '调研需求', detail: '访谈与竞品' },
        { id: 'build', title: '实现' },
      ],
      edges: [{ from: 'research', to: 'build' }],
    })
  })

  it('canvas_suggest_workflow rejects empty node lists', async () => {
    const ctx = await harness()
    const root = stubAgent(`root-${Math.random()}`)
    ctx.agents.register(root.agent)
    const empty = await execute(ctx, 'canvas_suggest_workflow', { nodes: [] }, root.agent, root.agent)
    expect(empty.isError).toBe(true)
    expect(root.session.events.filter(e => e.type === 'canvas/suggest-workflow')).toHaveLength(0)
  })
})
