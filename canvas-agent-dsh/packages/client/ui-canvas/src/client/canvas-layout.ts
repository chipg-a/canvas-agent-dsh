/**
 * Canvas mind-map layout engine: place a canvas tree (trunk nodes + fork
 * branches) into 2D coordinates for SVG rendering. Pure function — no React,
 * no DOM. Layout rule (design §6.3): trunk grows horizontally, fork branches
 * hang vertically beneath their fork point, children of each branch grow
 * horizontally from the branch header.
 */

/** A positioned node card for rendering. */
export interface CanvasPositionedNode {
  /** Unique key (session id + turn). */
  key: string
  /** Session the node belongs to. */
  sessionId: string
  /** Turn within the session. */
  turn: number
  /** Card text preview. */
  text: string
  /** Node lifecycle state. */
  state: 'settled' | 'pending' | 'removed'
  /** Whether pinned. */
  pinned: boolean
  /** Produced file paths. */
  produced: string[]
  /** Canvas x (left). */
  x: number
  /** Canvas y (top). */
  y: number
}

/** A positioned branch header. */
export interface CanvasPositionedBranch {
  /** Branch session id. */
  sessionId: string
  /** Parent session id. */
  parentSessionId: string
  /** Canvas x (left). */
  x: number
  /** Canvas y (top). */
  y: number
}

/** One fork branch of the tree. */
export interface CanvasLayoutBranchInput {
  sessionId: string
  parentSessionId: string
  /** This branch's nodes, in turn order. */
  nodes: { turn: number; text: string; state: 'settled' | 'pending' | 'removed'; pinned: boolean; produced: string[] }[]
  /** Recursive sub-branches. */
  children: CanvasLayoutBranchInput[]
}

/** Input to the layout engine: the trunk's nodes plus fork branches. */
export interface CanvasLayoutInput {
  /** The trunk session id. */
  trunkSessionId: string
  /** The trunk's nodes, in turn order. */
  trunkNodes: { turn: number; text: string; state: 'settled' | 'pending' | 'removed'; pinned: boolean; produced: string[] }[]
  /** Fork branches hanging from the trunk. */
  branches: CanvasLayoutBranchInput[]
}

/** The layout result. */
export interface CanvasLayout {
  /** Positioned trunk nodes. */
  trunk: CanvasPositionedNode[]
  /** Positioned branch headers. */
  branches: CanvasPositionedBranch[]
  /** Positioned branch nodes (nested branches included). */
  branchNodes: CanvasPositionedNode[]
  /** Total bounds: width and height of the laid-out canvas. */
  width: number
  height: number
}

/** Card metrics (px). */
const CARD_W = 260
const CARD_H = 120
const TRUNK_GAP_X = 40
const BRANCH_GAP_X = 40
const BRANCH_GAP_Y = 40
const TRUNK_START_X = 40
const TRUNK_START_Y = 40

/**
 * Lay out a canvas tree.
 * @param input - the tree (trunk nodes + branches).
 * @returns positioned cards and the total bounds.
 */
export function layoutCanvas(input: CanvasLayoutInput): CanvasLayout {
  const trunk: CanvasPositionedNode[] = input.trunkNodes.map((node, index) => ({
    key: `${input.trunkSessionId}:${String(node.turn)}`,
    sessionId: input.trunkSessionId,
    turn: node.turn,
    text: node.text,
    state: node.state,
    pinned: node.pinned,
    produced: node.produced,
    x: TRUNK_START_X + index * (CARD_W + TRUNK_GAP_X),
    y: TRUNK_START_Y,
  }))

  const branches: CanvasPositionedBranch[] = []
  const branchNodes: CanvasPositionedNode[] = []
  // Trunk vertical center: the row where branches hang from.
  const trunkCenterY = TRUNK_START_Y + CARD_H / 2
  let branchCursorX = TRUNK_START_X
  let maxBranchBottom = TRUNK_START_Y + CARD_H

  const placeBranch = (branch: CanvasLayoutBranchInput, depth: number, offsetY: number): number => {
    // Branch header sits below the trunk (depth 0) or below its parent.
    const headerY = depth === 0 ? trunkCenterY + BRANCH_GAP_Y : offsetY
    branches.push({
      sessionId: branch.sessionId,
      parentSessionId: branch.parentSessionId,
      x: branchCursorX,
      y: headerY,
    })
    // Branch nodes grow horizontally from the header.
    const nodeStartX = branchCursorX + CARD_W + BRANCH_GAP_X
    let rowY = headerY
    const rowHeight = Math.max(1, branch.nodes.length) * (CARD_H + BRANCH_GAP_Y) - BRANCH_GAP_Y
    branch.nodes.forEach((node, index) => {
      branchNodes.push({
        key: `${branch.sessionId}:${String(node.turn)}`,
        sessionId: branch.sessionId,
        turn: node.turn,
        text: node.text,
        state: node.state,
        pinned: node.pinned,
        produced: node.produced,
        x: nodeStartX,
        y: rowY + index * (CARD_H + BRANCH_GAP_Y),
      })
    })
    // Children hang below the branch's row.
    let childY = rowY + rowHeight + BRANCH_GAP_Y
    const childStartX = branchCursorX
    for (const child of branch.children) {
      // Recurse with a deeper x column: children place at their own cursor.
      const saved = branchCursorX
      branchCursorX = childStartX + CARD_W + BRANCH_GAP_X
      const bottom = placeBranch(child, depth + 1, childY)
      branchCursorX = saved
      childY = bottom + BRANCH_GAP_Y
    }
    maxBranchBottom = Math.max(maxBranchBottom, childY)
    return childY
  }

  for (const branch of input.branches) {
    placeBranch(branch, 0, 0)
    branchCursorX += CARD_W * 2 + BRANCH_GAP_X * 2
  }

  const width = Math.max(
    TRUNK_START_X + input.trunkNodes.length * (CARD_W + TRUNK_GAP_X),
    ...branches.map(b => b.x + CARD_W),
    ...branchNodes.map(n => n.x + CARD_W),
  )
  const height = Math.max(maxBranchBottom, trunkCenterY + CARD_H / 2)
  return { trunk, branches, branchNodes, width, height }
}
