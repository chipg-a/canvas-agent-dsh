/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-canvas-projection`.
 * @module @deepseek-ai/dsh-canvas-projection/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-canvas-projection'

/** Cordis companion plugin name. */
export const name = 'canvas-projection-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package owns a single pure projection fold whose
 * wire payload is schema-validated by the projection registry at every
 * snapshot and change-feed emission. The event relations the fold relies on
 * (monotonic host-assigned turn numbers, one `assistant/message` per entered
 * step, `turn/start`→`turn/end` bracketing, `canvas/node-*` decisions
 * referencing an existing node's turn and output seq) are owned by the
 * projection unit's own fold logic and covered by the unit spec in tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
