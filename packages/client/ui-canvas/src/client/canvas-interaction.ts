/**
 * Canvas free-canvas interaction model: pan/zoom transform and node
 * hit-testing. Pure TS — the React canvas view applies these to the SVG.
 */

/** A 2D pan/zoom transform over the canvas. */
export interface PanZoom {
  /** Scale factor (1 = 100%). */
  scale: number
  /** Translation in screen px at scale 1. */
  tx: number
  /** Translation in screen px. */
  ty: number
}

/** Default transform: no pan, 100% zoom. */
export const IDENTITY_PANZOOM: PanZoom = { scale: 1, tx: 0, ty: 0 }

/** Zoom toward a screen point: keep that canvas point fixed under the cursor. */
export function zoomAt(transform: PanZoom, screenX: number, screenY: number, nextScale: number): PanZoom {
  const clamped = Math.min(2, Math.max(0.2, nextScale))
  const canvasX = (screenX - transform.tx) / transform.scale
  const canvasY = (screenY - transform.ty) / transform.scale
  return {
    scale: clamped,
    tx: screenX - canvasX * clamped,
    ty: screenY - canvasY * clamped,
  }
}

/** Pan by a screen delta. */
export function panBy(transform: PanZoom, dx: number, dy: number): PanZoom {
  return { ...transform, tx: transform.tx + dx, ty: transform.ty + dy }
}

/** Map a screen point to canvas coordinates under a transform. */
export function screenToCanvas(transform: PanZoom, screenX: number, screenY: number): { x: number; y: number } {
  return {
    x: (screenX - transform.tx) / transform.scale,
    y: (screenY - transform.ty) / transform.scale,
  }
}

/** A positioned node card (for hit-testing). */
export interface HitTestNode {
  key: string
  x: number
  y: number
  width: number
  height: number
}

/** Find the node under a canvas point, topmost last (render order). */
export function hitTest(nodes: readonly HitTestNode[], canvasX: number, canvasY: number): string | null {
  for (let i = nodes.length - 1; i >= 0; i -= 1) {
    const node = nodes[i]
    if (node === undefined) continue
    if (canvasX >= node.x && canvasX <= node.x + node.width && canvasY >= node.y && canvasY <= node.y + node.height) {
      return node.key
    }
  }
  return null
}
