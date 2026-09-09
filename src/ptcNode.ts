// Custom vis-network shape for Gloas FULL payload nodes: the usual filled circle
// wrapped in rings that show the PTC (Payload Timeliness Committee) vote as a
// share of the whole committee, so it reads the same with 16 or 512 members.
//
// Outer ring, clockwise from the top: voted payload present (green), voted payload
// absent (orange), no vote received (grey track). Inner thin ring: voted blob data
// available (blue). Counts come from payload_availability_yes_count,
// payload_attester_count and payload_data_availability_yes_count.

import { PtcVoteFractions } from './forkChoiceApi'

export const PTC_COLORS = {
  yes: '#3fb950',
  votedNotYes: '#f0a030',
  notVoted: '#c8c8c8',
  dataYes: '#378add',
  dataTrack: '#e2e2e2',
}

const OUTER_RING_GAP = 4
const OUTER_RING_WIDTH = 7
const INNER_RING_WIDTH = 4
const LABEL_FONT = '14px arial'

type CtxRendererArgs = {
  ctx: CanvasRenderingContext2D
  x: number
  y: number
  state: { selected: boolean; hover: boolean }
  style: any
  label: string
}

function arc(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, fraction: number, color: string, width: number) {
  if (fraction <= 0) return
  const start = -Math.PI / 2
  ctx.beginPath()
  ctx.arc(x, y, r, start, start + Math.min(fraction, 1) * 2 * Math.PI)
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.lineCap = 'butt'
  ctx.stroke()
}

export function makePtcNodeRenderer(fractions: PtcVoteFractions) {
  return ({ ctx, x, y, state, style, label }: CtxRendererArgs) => {
    const bodyRadius: number = style.size ?? 25
    const innerRadius = bodyRadius + OUTER_RING_GAP + INNER_RING_WIDTH / 2
    const outerRadius = innerRadius + INNER_RING_WIDTH / 2 + 1 + OUTER_RING_WIDTH / 2
    const extent = outerRadius + OUTER_RING_WIDTH / 2
    return {
      drawNode() {
        // rings
        arc(ctx, x, y, outerRadius, 1, PTC_COLORS.notVoted, OUTER_RING_WIDTH)
        arc(ctx, x, y, outerRadius, fractions.yes + fractions.votedNotYes, PTC_COLORS.votedNotYes, OUTER_RING_WIDTH)
        arc(ctx, x, y, outerRadius, fractions.yes, PTC_COLORS.yes, OUTER_RING_WIDTH)
        arc(ctx, x, y, innerRadius, 1, PTC_COLORS.dataTrack, INNER_RING_WIDTH)
        arc(ctx, x, y, innerRadius, fractions.dataYes, PTC_COLORS.dataYes, INNER_RING_WIDTH)
        // body: same circle vis would draw for shape 'dot'
        ctx.beginPath()
        ctx.arc(x, y, bodyRadius, 0, 2 * Math.PI)
        ctx.fillStyle = style.color
        ctx.fill()
        if (state.selected || state.hover) {
          ctx.lineWidth = state.selected ? 3 : 2
          ctx.strokeStyle = style.borderColor ?? '#2b7ce9'
          ctx.stroke()
        }
      },
      drawExternalLabel() {
        if (!label) return
        ctx.font = LABEL_FONT
        ctx.fillStyle = '#343434'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'top'
        ctx.fillText(label, x, y + extent + 4)
      },
      nodeDimensions: { width: extent * 2, height: extent * 2 },
    }
  }
}

// Custom shape for Gloas EMPTY payload nodes: a hollow dashed circle in the node's validity
// colour with a big ∅ inside, so it reads as "no payload" next to the solid block and FULL nodes.
export function makeEmptyNodeRenderer() {
  return ({ ctx, x, y, state, style }: CtxRendererArgs) => {
    const radius: number = style.size ?? 25
    return {
      drawNode() {
        ctx.beginPath()
        ctx.arc(x, y, radius, 0, 2 * Math.PI)
        // opaque body (white, lightly tinted with the validity colour) so edges do not show through
        ctx.fillStyle = '#ffffff'
        ctx.fill()
        ctx.globalAlpha = 0.12
        ctx.fillStyle = style.color
        ctx.fill()
        ctx.globalAlpha = 1
        ctx.setLineDash([6, 5])
        ctx.lineWidth = state.selected ? 4 : 3
        ctx.strokeStyle = state.selected || state.hover ? (style.borderColor ?? '#2b7ce9') : style.color
        ctx.stroke()
        ctx.setLineDash([])
        ctx.font = `${Math.round(radius * 1.2)}px arial`
        ctx.fillStyle = style.color
        ctx.globalAlpha = 0.85
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('∅', x, y + radius * 0.05)
        ctx.globalAlpha = 1
      },
      nodeDimensions: { width: radius * 2, height: radius * 2 },
    }
  }
}
