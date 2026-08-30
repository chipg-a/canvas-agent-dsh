/**
 * Canvas memory tools: `canvas_reference_list` lists sessions the calling
 * agent may reference (other canvas sessions, ranked by working-directory
 * affinity), `canvas_reference` snapshots one referenced session's surface
 * and injects it as "Referenced sessions" context into the calling agent's
 * next request, and `canvas_suggest_tasks` writes a task-decomposition
 * proposal into the calling session's log for the user to review on the
 * canvas (each suggested root task is confirmed or removed before it runs).
 * This is the runtime form of the canvas design's "default isolation,
 * on-demand reference": nodes keep separate memories by default, and the
 * agent pulls a node's memory explicitly only when it needs it, through
 * `ctx.sessionReferenceResolver`.
 *
 * @module @deepseek-ai/dsh-tool-canvas-reference
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionReferenceResolver } from '@deepseek-ai/dsh-session-reference'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
// Type-only: pulls the canvas-projection SessionEventMap declarations
// (`canvas/suggest-tasks`) and canvas-types into this program.
import type {} from '@deepseek-ai/dsh-canvas-projection'

export type * from './types.ts'

/** Cordis plugin name. */
export const name = 'tool-canvas-reference'
/** Required services: the tool and agent registries. */
export const inject = ['agents', 'tools']

/** Resolve and authenticate the calling agent. */
function callingAgent(ctx: Context, exec: ToolRunContext): Agent {
  const agent = exec.agent
  if (agent === undefined) {
    throw new Error('canvas reference tools require a calling agent')
  }
  if (ctx.agents.get(agent.id) !== agent || ctx.agents.currentInitiator() !== agent) {
    throw new Error('canvas reference tools require the exact live calling agent inside its active driver')
  }
  return agent
}

/**
 * Register the canvas memory tools.
 * @param ctx - registrant context carrying the tool registry, agent registry,
 * and (when composed) the session-reference resolver.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'canvas_reference_list',
    description: 'List sessions the current agent may reference for canvas memory. '
      + 'Returns sessions other than the current one (fork branches, sibling canvases), '
      + 'each labeled by title or session id. Use canvas_reference to pull a session\'s memory into context.',
    parameters: {
      query: { type: 'string', description: 'Optional case-insensitive session-id/cwd/title substring filter.' },
      limit: { type: 'number', description: 'Optional result cap; defaults to 20.' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      const resolver = ctx.get('sessionReferenceResolver') as SessionReferenceResolver | undefined
      if (resolver === undefined) {
        return { ok: false, error: 'session-reference resolver unavailable (not composed in this deployment)' }
      }
      const agent = callingAgent(ctx, exec)
      const candidates = await resolver.listCandidates(
        agent,
        typeof args.query === 'string' ? args.query : '',
        typeof args.limit === 'number' ? args.limit : 20,
      )
      return {
        ok: true,
        candidates: candidates.map((candidate: { sessionId: SessionId; label: string }) => ({
          sessionId: candidate.sessionId,
          label: candidate.label,
        })),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'canvas_reference',
    description: 'Inject one referenced canvas session\'s memory (its current surface: user prompts, assistant '
      + 'answers, compaction checkpoints) into the current agent\'s next request as an untrusted "Referenced '
      + 'sessions" snapshot. Use it when the current task needs details another canvas node explored earlier. '
      + 'The snapshot is read-only and bounded; later changes to the source session do not affect this reference.',
    parameters: {
      session_id: { type: 'string', required: true, description: 'The session id to reference (from canvas_reference_list or the canvas tree).' },
      label: { type: 'string', description: 'Optional human-readable label for the mention.' },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      const resolver = ctx.get('sessionReferenceResolver') as SessionReferenceResolver | undefined
      if (resolver === undefined) {
        return { ok: false, error: 'session-reference resolver unavailable (not composed in this deployment)' }
      }
      const agent = callingAgent(ctx, exec)
      const sessionId = args.session_id as SessionId
      if (sessionId === agent.id) {
        throw new Error('canvas_reference cannot reference the calling session itself')
      }
      // Prepare the snapshot: reads the source surface once, detached.
      const prepared = await resolver.prepare(
        agent,
        [{ type: 'text', text: `using canvas reference @${args.label ?? sessionId}` }],
        [{ sessionId, ...(args.label === undefined ? {} : { label: args.label }) }],
      )
      if (prepared.additionalContext !== undefined) {
        agent.inject(createUserMessage({
          content: prepared.additionalContext.content,
          source: { kind: 'plugin', plugin: 'tool-canvas-reference' },
        }))
      }
      return { ok: true, referencedSessionId: sessionId, message: 'referenced session memory injected into the next request' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'canvas_suggest_tasks',
    description: 'Propose a task decomposition for the user to review: write a structured list of root tasks '
      + '(each with a short title and optional detail) into the session log. The canvas shows the list as pending '
      + 'suggestions — the user confirms or edits each one before it runs as a root task. Use this when the current '
      + 'request is best done as several independent parallel tasks, so the user can approve the split before '
      + 'execution. Titles must be concrete, user-recognizable task names; keep detail short and actionable.',
    parameters: {
      tasks: {
        type: 'array',
        required: true,
        description: 'Proposed root tasks, in suggested execution order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: 'Short concrete task name (the canvas node will use it).' },
            detail: { type: 'string', description: 'Optional one-line scope/constraint the user should know.' },
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      const agent = callingAgent(ctx, exec)
      const tasks = args.tasks
      if (!Array.isArray(tasks) || tasks.length === 0) {
        throw new Error('canvas_suggest_tasks requires a non-empty tasks list')
      }
      const proposed: { title: string; detail?: string }[] = tasks
        .map((task: { title?: unknown; detail?: unknown }) => ({
          title: typeof task?.title === 'string' ? task.title.trim() : '',
          ...(typeof task?.detail === 'string' && task.detail.trim().length > 0
            ? { detail: task.detail.trim() }
            : {}),
        }))
        .filter(task => task.title.length > 0)
      if (proposed.length === 0) {
        throw new Error('canvas_suggest_tasks requires at least one task with a title')
      }
      // The `canvas/suggest-tasks` event carries one entry per proposed task
      // (`title` + optional `detail`); the projection fold assigns each its
      // batchSeq/index. Importing the type keeps the SessionEventMap merge
      // in this compilation program.
      agent.session.append('canvas/suggest-tasks', { tasks: proposed })
      return { ok: true, count: proposed.length, message: 'task suggestions written for the user to review' }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'canvas_suggest_workflow',
    description: 'Propose a structured workflow for the user to review: write a graph of named nodes plus dependency '
      + 'edges (each `to` waits for its `from`) into the session log. The canvas shows it as a pending workflow — the '
      + 'user confirms it (each node becomes a root task, edges recorded for dependency rendering) or removes it. Use '
      + 'this when the request is best done as an ordered or partially parallel pipeline of distinct stages, so the '
      + 'user can approve the structure before execution. Node ids must be short unique slugs; titles concrete '
      + 'user-recognizable task names; keep detail one line.',
    parameters: {
      nodes: {
        type: 'array',
        required: true,
        description: 'Workflow nodes (stages), in declaration order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Short unique slug (referenced by edges).' },
            title: { type: 'string', required: true, description: 'Concrete task name (becomes a root task when adopted).' },
            detail: { type: 'string', description: 'Optional one-line scope/constraint.' },
            input: { type: 'boolean', description: 'Whether this step waits for user input before it runs (a per-run variable, e.g. today\'s topic). Default false = fully automatic.' },
          },
        },
      },
      edges: {
        type: 'array',
        description: 'Optional dependency edges (`to` waits for `from`).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string', required: true, description: 'Source node id.' },
            to: { type: 'string', required: true, description: 'Target node id (waits for source).' },
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) { return [{ type: 'text', text: JSON.stringify(value) }] },
    },
    async execute(args, exec) {
      const agent = callingAgent(ctx, exec)
      const nodes = args.nodes
      if (!Array.isArray(nodes) || nodes.length === 0) {
        throw new Error('canvas_suggest_workflow requires a non-empty nodes list')
      }
      const cleanNodes: { id: string; title: string; detail?: string; input?: boolean }[] = nodes
        .map((node: { id?: unknown; title?: unknown; detail?: unknown; input?: unknown }) => ({
          id: typeof node?.id === 'string' ? node.id.trim() : '',
          title: typeof node?.title === 'string' ? node.title.trim() : '',
          ...(typeof node?.detail === 'string' && node.detail.trim().length > 0
            ? { detail: node.detail.trim() }
            : {}),
          ...(node?.input === true ? { input: true } : {}),
        }))
        .filter(node => node.id.length > 0 && node.title.length > 0)
      if (cleanNodes.length === 0) {
        throw new Error('canvas_suggest_workflow requires at least one node with an id and a title')
      }
      const ids = new Set(cleanNodes.map(node => node.id))
      const edges = Array.isArray(args.edges) ? args.edges : []
      const cleanEdges: { from: string; to: string }[] = edges
        .map((edge: { from?: unknown; to?: unknown }) => ({
          from: typeof edge?.from === 'string' ? edge.from.trim() : '',
          to: typeof edge?.to === 'string' ? edge.to.trim() : '',
        }))
        .filter(edge => edge.from.length > 0 && edge.to.length > 0 && edge.from !== edge.to
          && ids.has(edge.from) && ids.has(edge.to))
      agent.session.append('canvas/suggest-workflow', { nodes: cleanNodes, edges: cleanEdges })
      return { ok: true, nodeCount: cleanNodes.length, edgeCount: cleanEdges.length, message: 'workflow proposal written for the user to review' }
    },
  }))
}
