/**
 * Canvas-agent projection plugin: registers the `canvasTree` per-session
 * projection unit and provides the `canvasTrees` host service that assembles
 * the cross-session canvas tree from live session lineage and per-session
 * folds.
 *
 * @module @deepseek-ai/dsh-canvas-projection
 */

import { Context } from '@deepseek-ai/cordis'
import { canvasTreeProjectionDefinition } from './projection.ts'
import { CanvasTreeService, type CanvasTrees } from './service.ts'

export type * from './types.ts'
export type * from './canvas-types.ts'
export { canvasTreeProjectionDefinition } from './projection.ts'
export { projectCanvasTree } from './projection.ts'
export { foldCanvasTree } from './tree.ts'
export type { CanvasSessionInput } from './tree.ts'
export { CanvasTreeService } from './service.ts'
export type { CanvasTrees } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Cross-session canvas tree query service. */
    canvasTrees: CanvasTrees
  }
}

/** Cordis plugin name. */
export const name = 'canvas-projection'
/** The projection registry and session store are hard dependencies. */
export const inject = ['sessionProjections', 'sessions']

/**
 * Register the `canvasTree` unit and provide the `canvasTrees` service; both
 * are effects on this plugin's fiber, so unloading removes them.
 * @param ctx - registrant context carrying the projection registry.
 */
export function apply(ctx: Context): void {
  ctx.sessionProjections.register(canvasTreeProjectionDefinition)
  ctx.plugin(CanvasTreeService)
}
