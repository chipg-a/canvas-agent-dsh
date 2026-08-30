/**
 * The `canvasTree` projection unit: a pure fold of one session's event log
 * into its canvas node list.
 *
 * A node is one agent output: a turn that assembled an `assistant/message`.
 * The fold tracks open turns, and when a turn closes having produced an
 * output, it emits a node. User canvas decisions (commit/pin/remove) mutate
 * node state. Every uninteresting event returns the same state reference, so
 * the projection registry's `Object.is` gate skips downstream work.
 *
 * Confirmation semantics: outputs become nodes in `pending` state; the user's
 * `canvas/node-commit` decision settles them. The projection keeps both —
 * pending nodes are visible (the user reviews them before deciding), settled
 * nodes are the confirmed canvas. `canvas/node-remove` drops the node from the
 * view; the underlying log events are untouched.
 *
 * @module @deepseek-ai/dsh-canvas-projection/projection
 */

import { z } from 'zod'
import type { ZodType } from 'zod'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { CanvasJsonValue, CanvasNode, CanvasTaskSuggestion, CanvasTreeProjection, CanvasWorkflowPlan, CanvasWorkflowSuggestion } from './types.ts'

/**
 * Fold state: nodes by turn plus the open-turn boundary being tracked, plus
 * pending task-decomposition suggestions. Plain JSON per the unit contract
 * (persisted-cache precondition).
 */
interface CanvasTreeState {
  /** Nodes by turn number, in insertion order. */
  nodes: Record<number, CanvasNode>
  /** Pending suggestions by `${batchSeq}:${index}`, in proposal order. */
  suggestions: Record<string, CanvasTaskSuggestion>
  /** Pending structured workflow proposal; null until proposed/adopted. */
  workflow: CanvasWorkflowSuggestion | null
  /** Adopted workflow execution plan; null until a workflow is confirmed. */
  workflowPlan: CanvasWorkflowPlan | null
  /** Open turn boundary; null between turns. */
  openTurn: {
    turn: number
    startSeq: number
    /** Seq of the turn's `assistant/message`, once assembled. */
    outputSeq?: number
    /** The assembled output's content blocks (JSON-safe). */
    outputBlocks?: CanvasJsonValue[]
    /** The user prompt this turn executed (its task); the auto title source. */
    prompt?: string
    /** Files this turn's tool calls produced so far, first-seen order. */
    produced: string[]
  } | null
  /** Turn of the last output-producing closed turn, for ordering. */
  lastClosedTurn: number | null
}

const canvasTreeSchema: ZodType<CanvasTreeProjection> = z.object({
  nodes: z.array(z.object({
    turn: z.number().int().nonnegative(),
    startSeq: z.number().int().nonnegative(),
    endSeq: z.number().int().nonnegative(),
    outputSeq: z.number().int().nonnegative(),
    output: z.object({
      text: z.string(),
      blocks: z.array(z.any()),
    }),
    state: z.enum(['settled', 'pending', 'removed']),
    time: z.number().nonnegative(),
    pinned: z.boolean(),
    prompt: z.string().optional(),
    produced: z.array(z.string()).optional(),
    position: z.object({ x: z.number(), y: z.number() }).optional(),
  })),
  suggestions: z.array(z.object({
    batchSeq: z.number().int().nonnegative(),
    index: z.number().int().nonnegative(),
    title: z.string(),
    detail: z.string().optional(),
  })),
  workflow: z.object({
    batchSeq: z.number().int().nonnegative(),
    nodes: z.array(z.object({
      id: z.string(),
      title: z.string(),
      detail: z.string().optional(),
      input: z.boolean().optional(),
    })),
    edges: z.array(z.object({
      from: z.string(),
      to: z.string(),
    })),
  }).optional(),
  workflowPlan: z.object({
    batchSeq: z.number().int().nonnegative(),
    nodes: z.array(z.object({
      id: z.string(),
      title: z.string(),
      detail: z.string().optional(),
      input: z.boolean().optional(),
    })),
    edges: z.array(z.object({
      from: z.string(),
      to: z.string(),
    })),
  }).optional(),
}).strict()

/** The user prompt text of a `user/message` event (text blocks only). */
function userPromptText(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined
  const message = (data as { message?: unknown }).message
  if (typeof message !== 'object' || message === null) return undefined
  const content = (message as { content?: unknown }).content
  if (!Array.isArray(content)) return undefined
  let text = ''
  for (const block of content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      const value = (block as { text?: unknown }).text
      if (typeof value === 'string') text += value
    }
  }
  return text
}

/**
 * Extract the plain-text projection of an assistant message's content blocks.
 * Only text blocks contribute; other block kinds (tool use, reasoning) are
 * skipped. The result is JSON-safe for the projection contract.
 * @param message - the assembled assistant message content blocks.
 * @returns plain-text concatenation of text blocks.
 */
function outputText(message: { content: unknown[] }): string {  let text = ''
  for (const block of message.content) {
    if (typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'text') {
      const value = (block as { text?: unknown }).text
      if (typeof value === 'string') text += value
    }
  }
  return text
}

/**
 * Whether a closed turn produced an output: an `assistant/message` event was
 * assembled within the turn. The fold tracks this via a flag recorded when the
 * message lands.
 */
function nodeFromTurn(
  turn: number,
  startSeq: number,
  endSeq: number,
  outputSeq: number,
  outputBlocks: CanvasJsonValue[],
  time: number,
  produced: readonly string[],
  prompt?: string,
): CanvasNode {
  return {
    turn,
    startSeq,
    endSeq,
    outputSeq,
    output: { text: outputText({ content: outputBlocks }), blocks: outputBlocks },
    state: 'pending',
    time,
    pinned: false,
    ...produced.length === 0 ? {} : { produced: [...produced] },
    ...prompt === undefined || prompt.length === 0 ? {} : { prompt },
  }
}

/**
 * Extract produced-file paths from a `tool/result` event's meta, mirroring the
 * client deliverables vocabulary: a mutation tool's follow-along `locations`
 * (an array of `{ path }` objects) — the write/edit tool shapes — are the
 * produced files. Reads, deletes, and failed calls contribute nothing.
 * @param meta - the tool/result event's optional meta payload.
 * @returns produced paths in first-seen order.
 */
function producedPathsFromMeta(meta: unknown): string[] {
  if (typeof meta !== 'object' || meta === null) return []
  const record = meta as { locations?: unknown; diffs?: unknown }
  const candidates: unknown = record.diffs ?? record.locations
  if (!Array.isArray(candidates)) return []
  const paths: string[] = []
  for (const item of candidates) {
    if (typeof item !== 'object' || item === null) continue
    const path = (item as { path?: unknown }).path
    if (typeof path === 'string' && !paths.includes(path)) paths.push(path)
  }
  return paths
}

/** The `canvasTree` unit registered on `ctx.sessionProjections`. */
export const canvasTreeProjectionDefinition: ProjectionDefinition<'canvasTree', CanvasTreeState> = {
  key: 'canvasTree',
  schema: canvasTreeSchema,
  init: () => ({ nodes: {}, suggestions: {}, workflow: null, workflowPlan: null, openTurn: null, lastClosedTurn: null }),
  apply: (state, event) => {
    switch (event.type) {
      case 'turn/start':
        return { ...state, openTurn: { turn: event.data.turn, startSeq: event.seq, produced: [] } }
      case 'user/message': {
        const open = state.openTurn
        if (open === null) return state
        const prompt = userPromptText(event.data)
        if (prompt === undefined || prompt.length === 0) return state
        if (open.prompt === prompt) return state
        return { ...state, openTurn: { ...open, prompt } }
      }
      case 'assistant/message': {
        const open = state.openTurn
        if (open === null || open.turn !== event.data.turn) return state
        // Record the output within the open turn; the node materializes at
        // turn/end so its boundary (endSeq) is known. Session event data is
        // lossless-JSON by contract (append enforces isJsonValue), so the
        // content blocks are CanvasJsonValue; the type system cannot see that.
        return { ...state, openTurn: { ...open, outputSeq: event.seq, outputBlocks: event.data.message.content as unknown as CanvasJsonValue[] } }
      }
      case 'tool/result': {
        const open = state.openTurn
        if (open === null || open.turn !== event.data.turn) return state
        const additions = producedPathsFromMeta(event.data.meta)
        if (additions.length === 0) return state
        // Dedupe against already-recorded paths (a file written then edited in
        // the same turn is one entry).
        const merged = [...open.produced]
        for (const path of additions) {
          if (!merged.includes(path)) merged.push(path)
        }
        return { ...state, openTurn: { ...open, produced: merged } }
      }
      case 'turn/end': {
        const open = state.openTurn
        if (open === null || open.turn !== event.data.turn) return state
        if (open.outputSeq !== undefined) {
          const created = nodeFromTurn(
            event.data.turn,
            open.startSeq,
            event.seq,
            open.outputSeq,
            open.outputBlocks ?? [],
            event.time,
            open.produced,
            open.prompt,
          )
          return { ...state, nodes: { ...state.nodes, [event.data.turn]: created }, openTurn: null, lastClosedTurn: event.data.turn }
        }
        // A turn with no assembled output produces no node.
        return { ...state, openTurn: null, lastClosedTurn: event.data.turn }
      }
      case 'canvas/node-commit': {
        const node = state.nodes[event.data.turn]
        if (node === undefined) return state
        if (node.outputSeq !== event.data.outputSeq) return state
        if (node.state === 'settled') return state
        return { ...state, nodes: { ...state.nodes, [event.data.turn]: { ...node, state: 'settled' } } }
      }
      case 'canvas/node-pin': {
        const node = state.nodes[event.data.turn]
        if (node === undefined || node.pinned) return state
        if (node.outputSeq !== event.data.outputSeq) return state
        return { ...state, nodes: { ...state.nodes, [event.data.turn]: { ...node, pinned: true } } }
      }
      case 'canvas/node-remove': {
        const node = state.nodes[event.data.turn]
        if (node === undefined || node.state === 'removed') return state
        return { ...state, nodes: { ...state.nodes, [event.data.turn]: { ...node, state: 'removed' } } }
      }
      case 'canvas/node-title': {
        const node = state.nodes[event.data.turn]
        if (node === undefined || node.state === 'removed') return state
        if (node.outputSeq !== event.data.outputSeq) return state
        if (typeof event.data.title !== 'string' || event.data.title.length === 0) return state
        if (node.title === event.data.title) return state
        return { ...state, nodes: { ...state.nodes, [event.data.turn]: { ...node, title: event.data.title } } }
      }
      case 'canvas/node-move': {
        const node = state.nodes[event.data.turn]
        if (node === undefined || node.state === 'removed') return state
        const position = event.data.position
        if (typeof position !== 'object' || position === null) return state
        const { x, y } = position as { x?: unknown; y?: unknown }
        if (typeof x !== 'number' || !Number.isFinite(x)) return state
        if (typeof y !== 'number' || !Number.isFinite(y)) return state
        if (node.position?.x === x && node.position?.y === y) return state
        return { ...state, nodes: { ...state.nodes, [event.data.turn]: { ...node, position: { x, y } } } }
      }
      case 'canvas/suggest-tasks': {
        const tasks = event.data.tasks
        if (!Array.isArray(tasks) || tasks.length === 0) return state
        const suggestions = { ...state.suggestions }
        let changed = false
        tasks.forEach((task, index) => {
          if (typeof task !== 'object' || task === null) return
          const title = (task as { title?: unknown }).title
          if (typeof title !== 'string' || title.trim().length === 0) return
          const detail = (task as { detail?: unknown }).detail
          const key = `${String(event.seq)}:${String(index)}`
          // A re-proposal replaces the previous suggestion of the same index
          // (the agent iterates on its decomposition in one batch).
          suggestions[key] = {
            batchSeq: event.seq,
            index,
            title: title.trim(),
            ...(typeof detail === 'string' && detail.trim().length > 0 ? { detail: detail.trim() } : {}),
          }
          changed = true
        })
        return changed ? { ...state, suggestions } : state
      }
      case 'canvas/suggest-adopt':
      case 'canvas/suggest-remove': {
        const key = `${String(event.data.batchSeq)}:${String(event.data.index)}`
        if (!(key in state.suggestions)) return state
        const suggestions = { ...state.suggestions }
        delete suggestions[key]
        return { ...state, suggestions }
      }
      case 'canvas/suggest-workflow': {
        const nodes = event.data.nodes
        const edges = event.data.edges
        if (!Array.isArray(nodes) || nodes.length === 0) return state
        const cleanNodes: CanvasWorkflowSuggestion['nodes'] = []
        for (const node of nodes) {
          if (typeof node !== 'object' || node === null) continue
          const id = (node as { id?: unknown }).id
          const title = (node as { title?: unknown }).title
          if (typeof id !== 'string' || id.trim().length === 0) continue
          if (typeof title !== 'string' || title.trim().length === 0) continue
          const detail = (node as { detail?: unknown }).detail
          const input = (node as { input?: unknown }).input
          cleanNodes.push({
            id: id.trim(),
            title: title.trim(),
            ...(typeof detail === 'string' && detail.trim().length > 0 ? { detail: detail.trim() } : {}),
            ...(input === true ? { input: true } : {}),
          })
        }
        if (cleanNodes.length === 0) return state
        const ids = new Set(cleanNodes.map(node => node.id))
        const cleanEdges: CanvasWorkflowSuggestion['edges'] = []
        if (Array.isArray(edges)) {
          for (const edge of edges) {
            if (typeof edge !== 'object' || edge === null) continue
            const from = (edge as { from?: unknown }).from
            const to = (edge as { to?: unknown }).to
            if (typeof from !== 'string' || typeof to !== 'string') continue
            if (!ids.has(from) || !ids.has(to) || from === to) continue
            cleanEdges.push({ from, to })
          }
        }
        return {
          ...state,
          workflow: { batchSeq: event.seq, nodes: cleanNodes, edges: cleanEdges },
        }
      }
      case 'canvas/workflow-adopt': {
        if (state.workflow === null || state.workflow.batchSeq !== event.data.batchSeq) return state
        // Adopting promotes the pending proposal to a durable execution plan:
        // nodes become placeholder cards until their root tasks exist, edges
        // drive dependency-ordered execution.
        return {
          ...state,
          workflow: null,
          workflowPlan: {
            batchSeq: state.workflow.batchSeq,
            nodes: state.workflow.nodes,
            edges: state.workflow.edges,
          },
        }
      }
      case 'canvas/workflow-remove': {
        if (state.workflow === null || state.workflow.batchSeq !== event.data.batchSeq) return state
        return { ...state, workflow: null }
      }
      default:
        return state
    }
  },
  view: state => {
    const nodes = Object.values(state.nodes)
      .filter((node): node is CanvasNode => node.state !== 'removed')
      .sort((a, b) => a.turn - b.turn)
    const suggestions = Object.values(state.suggestions).sort((a, b) =>
      a.batchSeq - b.batchSeq || a.index - b.index)
    return {
      nodes,
      suggestions,
      ...state.workflow === null ? {} : { workflow: state.workflow },
      ...state.workflowPlan === null ? {} : { workflowPlan: state.workflowPlan },
    }
  },
  stateVersion: 4,
}

/**
 * Pure entry point for tests and replay: fold an event list into the canvas
 * tree projection value without a live registry. Mirrors what the registry
 * does per committed event, one event at a time.
 * @param events - session events in seq order.
 * @returns the canvasTree projection value at the log end.
 */
export function projectCanvasTree(events: readonly SessionEvent[]): CanvasTreeProjection {
  let state = canvasTreeProjectionDefinition.init()
  for (const event of events) {
    state = canvasTreeProjectionDefinition.apply(state, event)
  }
  return canvasTreeProjectionDefinition.view(state)
}
