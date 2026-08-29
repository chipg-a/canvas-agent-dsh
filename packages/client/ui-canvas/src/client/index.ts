/**
 * Canvas view tab: contributes one entry to the conversation view ring that
 * renders the session's canvas node tree as a mind-map-style node list, and
 * applies user canvas decisions (confirm/pin/remove) through the canvasTrees
 * Remote service. The component stays presentation-only: the apply body wraps
 * the remote calls into injected callbacks.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId, UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveWorkspacePath } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the 'conversation.view' SlotMap row and the ConvViewProps
// standard props, plus the assembled Remote namespaces (canvasTrees included
// through the api-remotes client assembly) into the program.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ComposerSubmitTarget } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import {
  CanvasView,
  withCanvasErrorBoundary,
  type CanvasViewInjected,
  type CanvasViewRemoteActions,
} from './CanvasView.tsx'

/**
 * Remote actions the canvas view can trigger, wrapped at apply time so the
 * component never touches ctx. Re-exported from the component module.
 */
export type { CanvasViewRemoteActions }

/** Required services: the conversation slot, the client Remote registry and
 *  its canvasTrees namespace (the assembled canvas service), the connection
 *  (for the preset roster), and the session list (for the session cwd used by
 *  artifact opening). */
export const inject = ['slots', 'remote', 'remote.canvasTrees', 'connection', 'sessions']

/**
 * Client plugin body: register the canvas view tab with remote actions. The
 * registration rides the slot service's effect wrapper, so plugin unload
 * removes the tab.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  const remote = ctx.remote
  const sessions = ctx.sessions
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'canvas',
    // The canvas is the default conversation surface: it must be the ring's
    // first tab (chat-first deployments order chat below, canvas-first ones
    // disable chat entirely and this entry leads).
    order: -10,
    label: () => '画布',
    // Canvas is a double-click-to-prompt surface: no resident composer. The
    // native composer bar renders in the canvas right rail instead.
    hideComposer: true,
    hostsComposer: true,
    inject: (sessionId: SessionId): CanvasViewInjected => ({
      sessionId,
      actions: {
        loadTree: (trunkSessionId: SessionId) => remote.canvasTrees.treeOf(trunkSessionId),
        confirmNode: (sessionId: SessionId, turn: number, outputSeq: number) =>
          remote.canvasTrees.confirmNode(sessionId, turn, outputSeq),
        pinNode: (sessionId: SessionId, turn: number, outputSeq: number) =>
          remote.canvasTrees.pinNode(sessionId, turn, outputSeq),
        removeNode: (sessionId: SessionId, turn: number) =>
          remote.canvasTrees.removeNode(sessionId, turn),
        setNodeTitle: (sessionId: SessionId, turn: number, outputSeq: number, title: string) =>
          remote.canvasTrees.setNodeTitle(sessionId, turn, outputSeq, title),
        adoptSuggestion: (sessionId: SessionId, batchSeq: number, index: number) =>
          remote.canvasTrees.adoptSuggestion(sessionId, batchSeq, index),
        removeSuggestion: (sessionId: SessionId, batchSeq: number, index: number) =>
          remote.canvasTrees.removeSuggestion(sessionId, batchSeq, index),
        adoptWorkflow: (sessionId: SessionId, batchSeq: number) =>
          remote.canvasTrees.adoptWorkflow(sessionId, batchSeq),
        removeWorkflow: (sessionId: SessionId, batchSeq: number) =>
          remote.canvasTrees.removeWorkflow(sessionId, batchSeq),
        forkNode: (
          sessionId: SessionId,
          turn: number,
          executor?: { model?: string; agentPreset?: string; cwd?: string },
        ) => remote.canvasTrees.forkNode(sessionId, turn, executor),
      },
      openFile: (path: string) => {
        const cwd = sessions.list.getSnapshot().byId[sessionId]?.cwd
        const workspaces = ctx.get('workspaces') as { openPath(path: string): Promise<unknown> } | undefined
        if (workspaces === undefined || cwd === undefined) return
        void workspaces.openPath(resolveWorkspacePath(cwd, path)).catch(() => {
          // Host/OS open failures stay silent in the canvas card, mirroring
          // the chat row's file-opening behavior.
        })
      },
      sendPrompt: async (targetSessionId: string, text: string): Promise<void> => {
        const connection = ctx.get('connection') as
          | { api: { sessions: { prompt(request: object): Promise<unknown> } } }
          | undefined
        if (connection === undefined) return
        await connection.api.sessions.prompt({
          sessionId: targetSessionId,
          mode: 'queue',
          content: [{ type: 'text', text }],
        })
      },
      setComposerTarget: (target) => {
        const conversation = ctx.get('conversation') as
          | { setComposerTarget(target: ComposerSubmitTarget | null): void }
          | undefined
        conversation?.setComposerTarget(target)
      },
    }),
  }, withCanvasErrorBoundary(CanvasView)))
}

/** Re-export the projection hook type used by the view for consumers' tests. */
export type { UseProjection }
