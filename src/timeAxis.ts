// Maps wall-clock time onto the graph's horizontal slot axis. The layout places slot columns
// at a fixed pitch to the right of the leftmost node, so any (fractional) slot has an x.

export type SlotAxis = {
  leftMostSlot: number   // slot of the leftmost (root) node
  leftMostX: number      // its x position on the canvas
  blockOffset: number    // block nodes sit left of the column centre when payload columns are shown
  slotWidth: number
}

// Fractional slot for a wall-clock instant, e.g. 2.5 = halfway through slot 2.
export function currentSlot(genesisTime: number, secondsPerSlot: number, nowMs: number): number {
  return (nowMs / 1000 - genesisTime) / secondsPerSlot
}

// x of a (fractional) slot measured from the left edge of its column.
export function slotToX(axis: SlotAxis, slot: number): number {
  const columnCentre = axis.leftMostX + axis.blockOffset
  return columnCentre - axis.slotWidth / 2 + (slot - axis.leftMostSlot) * axis.slotWidth
}

// Following wall-clock time only makes sense when the data is live: the newest head must be
// within an epoch of now. Sample dumps and stale nodes fall back to centering on the head.
export function isTimeTrackable(nowSlot: number, headSlot: number | undefined, slotsPerEpoch: number): boolean {
  if (headSlot === undefined) return false
  return Math.abs(nowSlot - headSlot) <= slotsPerEpoch
}
