/**
 * Canvas plugin, node half. The browser half ships via exports["./client"],
 * discovered through the package.json dsh.client declaration. The node half
 * registers nothing today; the canvas view reads the host's projection and
 * session services through the runtime's standard props and the connection's
 * host RPC, so no host-side contribution is needed from this package.
 */

import type { Context } from '@deepseek-ai/cordis'

/**
 * Node half of the canvas plugin: a no-op today.
 * @param _ctx - host context (unused; kept for plugin shape symmetry).
 */
export function apply(_ctx: Context): void {}
