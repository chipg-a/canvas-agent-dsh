/**
 * Canvas-agent host vocabulary: re-exports the zero-dependency node model and
 * declares the `canvas/*` session events plus the `canvasTree` projection key.
 * The node types themselves live in `canvas-types.ts` (no imports) so client
 * and product-shell consumers can reference them without host session modules.
 *
 * @module @deepseek-ai/dsh-canvas-projection/types
 */

import type { CanvasTreeProjection } from './canvas-types.ts'

export type {
  CanvasJsonValue,
  CanvasNode,
  CanvasNodeText,
  CanvasSessionNode,
  CanvasTaskSuggestion,
  CanvasTree,
  CanvasTreeProjection,
  CanvasWorkflowEdge,
  CanvasWorkflowNode,
  CanvasWorkflowPlan,
  CanvasWorkflowPlanNode,
  CanvasWorkflowSuggestion,
} from './canvas-types.ts'

/**
 * The `canvas/node-*` events record user canvas decisions in the session log
 * so that "model-visible ⟺ logged" holds: any canvas structure the model sees
 * must be reconstructable from the log.
 */
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * User confirmed a pending output as a canvas node. Log-only (not a
     * surface event): the output itself is already on the surface as its
     * `assistant/message`; this event only records the display decision.
     */
    'canvas/node-commit': {
      /** Turn whose output is confirmed. */
      turn: number
      /** Seq of the confirmed `assistant/message` (the exact output). */
      outputSeq: number
    }
    /**
     * User pinned a node's output as referenceable "final" content. Log-only.
     */
    'canvas/node-pin': {
      /** Turn whose output is pinned. */
      turn: number
      /** Seq of the pinned `assistant/message`. */
      outputSeq: number
    }
    /**
     * User removed a node from the canvas view. Log-only; the underlying
     * output events remain in the log (removal is a view decision).
     */
    'canvas/node-remove': {
      /** Turn whose node is removed. */
      turn: number
    }
    /**
     * User named a node (its canvas title). Log-only user decision; the title
     * is the node's identity on the canvas and in search, so it must be
     * reconstructable from the log.
     */
    'canvas/node-title': {
      /** Turn whose node is named. */
      turn: number
      /** Seq of the named `assistant/message` (guards stale renames). */
      outputSeq: number
      /** The node's display title. */
      title: string
    }
    /**
     * The agent proposed a task decomposition: `canvas_suggest_tasks` wrote
     * this log-only event listing root-task candidates. The projection folds
     * it into pending canvas suggestions the user reviews; the model never
     * sees the suggestions again (they are the user's review list).
     */
    'canvas/suggest-tasks': {
      /** Proposed root tasks, in execution order. */
      tasks: { title: string; detail?: string }[]
    }
    /**
     * User adopted one pending suggestion: it becomes a root task (the user's
     * follow-up prompt is the actual task; this event only records which
     * suggestion it came from). Log-only user decision.
     */
    'canvas/suggest-adopt': {
      /** Seq of the proposing `canvas/suggest-tasks` event. */
      batchSeq: number
      /** Index of the adopted task within that batch. */
      index: number
    }
    /**
     * User removed one pending suggestion from the review list without
     * adopting it. Log-only user decision.
     */
    'canvas/suggest-remove': {
      /** Seq of the proposing `canvas/suggest-tasks` event. */
      batchSeq: number
      /** Index of the removed task within that batch. */
      index: number
    }
    /**
     * The agent proposed a structured workflow: `canvas_suggest_workflow`
     * wrote this log-only event listing named nodes plus dependency edges.
     * The projection folds it into a pending workflow the user confirms or
     * removes; the model never sees it again (it is the user's plan).
     */
    'canvas/suggest-workflow': {
      /** Proposed nodes, in declaration order. */
      nodes: { id: string; title: string; detail?: string }[]
      /** Proposed dependency edges (`to` waits for `from`). */
      edges: { from: string; to: string }[]
    }
    /**
     * User adopted the pending workflow: every node becomes a root task (the
     * user's follow-up prompts are the actual tasks; this event only records
     * the proposal it came from and its edges). Log-only user decision.
     */
    'canvas/workflow-adopt': {
      /** Seq of the proposing `canvas/suggest-workflow` event. */
      batchSeq: number
    }
    /**
     * User removed the pending workflow without adopting it. Log-only.
     */
    'canvas/workflow-remove': {
      /** Seq of the proposing `canvas/suggest-workflow` event. */
      batchSeq: number
    }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Per-session canvas node tree; see {@link CanvasTreeProjection}. */
    canvasTree: CanvasTreeProjection
  }
}
