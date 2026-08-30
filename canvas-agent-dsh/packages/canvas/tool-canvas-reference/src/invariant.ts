/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-tool-canvas-reference`.
 * @module @deepseek-ai/dsh-tool-canvas-reference/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-canvas-reference'

/** Cordis companion plugin name. */
export const name = 'tool-canvas-reference-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package registers two model-facing tools whose
 * execution authority (exact live calling agent inside its active driver) is
 * checked per call in the tool body, and whose memory snapshots are prepared
 * and bounded by `ctx.sessionReferenceResolver` (owned and runtime-checked by
 * dsh-session-reference). The injection of a referenced snapshot as a
 * plugin-sourced `user/message` is observable through the session log, which
 * the session surface owns.
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
