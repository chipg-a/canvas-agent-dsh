/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-client-ui-canvas`.
 * @module @deepseek-ai/dsh-client-ui-canvas/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-canvas'

/** Cordis companion plugin name. */
export const name = 'client-ui-canvas-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the package is pure presentation. It renders the
 * canvas node tree from the host projection and session services through the
 * conversation view slot's standard props; the underlying event relations are
 * owned by dsh-canvas-projection's fold and the session surface. A
 * projection key absence renders an empty canvas, so there is no
 * cross-service relationship for this package to assert.
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
