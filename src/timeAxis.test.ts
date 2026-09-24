import { currentSlot, slotToX, isTimeTrackable, SlotAxis } from './timeAxis'

describe('currentSlot', () => {
  it('returns a fractional slot from wall-clock time', () => {
    // genesis 1000s, 12s slots, now = 1000 + 12 * 2.5
    expect(currentSlot(1000, 12, (1000 + 30) * 1000)).toBeCloseTo(2.5)
  })

  it('is negative before genesis', () => {
    expect(currentSlot(1000, 12, 988 * 1000)).toBe(-1)
  })
})

describe('slotToX', () => {
  // the leftmost node sits at slot 10, x = 500; slots are 300 wide and, with payload columns,
  // block nodes are shifted left by a quarter slot inside their column
  const axis: SlotAxis = { leftMostSlot: 10, leftMostX: 500, blockOffset: 75, slotWidth: 300 }

  it('maps the left edge of the leftmost slot column', () => {
    // column centre = 500 + 75 = 575, left edge = 575 - 150
    expect(slotToX(axis, 10)).toBe(425)
  })

  it('maps fractional slots linearly', () => {
    expect(slotToX(axis, 12.5)).toBe(425 + 2.5 * 300)
  })

  it('works without payload columns', () => {
    expect(slotToX({ leftMostSlot: 0, leftMostX: 0, blockOffset: 0, slotWidth: 150 }, 1)).toBe(75)
  })
})

describe('isTimeTrackable', () => {
  it('accepts a head within one epoch of now', () => {
    expect(isTimeTrackable(1000.4, 1000, 32)).toBe(true)
    expect(isTimeTrackable(1031, 1000, 32)).toBe(true)
  })

  it('rejects a head far in the past or future (samples, stale nodes)', () => {
    expect(isTimeTrackable(15_000_000, 111, 32)).toBe(false)
    expect(isTimeTrackable(1000, 1040, 32)).toBe(false)
  })

  it('rejects missing heads', () => {
    expect(isTimeTrackable(1000, undefined, 32)).toBe(false)
  })
})
