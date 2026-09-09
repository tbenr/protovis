import React, { useCallback, useEffect, useRef, useState } from 'react'
import { PTC_COLORS } from './ptcNode'

type Props = {
  ptcSize: number
}

type Position = { left: number; top: number }

const DEFAULT_POSITION: Position = { left: 12, top: 200 }
const STORAGE_KEY = 'protovis.ptcLegend.position'
const FOLD_KEY = 'protovis.ptcLegend.folded'

function loadPosition(): Position {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) {
      const { left, top } = JSON.parse(saved)
      if (Number.isFinite(left) && Number.isFinite(top)) return { left, top }
    }
  } catch (e) { /* no storage available, use the default */ }
  return DEFAULT_POSITION
}

function loadFolded(): boolean {
  try { return localStorage.getItem(FOLD_KEY) === '1' } catch (e) { return false }
}

function clamp(position: Position, width: number, height: number): Position {
  return {
    left: Math.min(Math.max(0, position.left), Math.max(0, window.innerWidth - width)),
    top: Math.min(Math.max(0, position.top), Math.max(0, window.innerHeight - height)),
  }
}

function Ring({ color, width }: { color: string; width: number }) {
  return <span className="ptc-legend-ring" style={{ borderColor: color, borderWidth: width }} />
}

// Legend for the PTC vote rings drawn around Gloas FULL payload nodes. Drag it by its title
// bar; the position is remembered in localStorage. Double-click the title to reset it.
// The chevron folds it down to the title line once the colours are familiar.
export default function PtcLegend({ ptcSize }: Props) {
  const [position, setPosition] = useState<Position>(loadPosition)
  const [folded, setFolded] = useState<boolean>(loadFolded)
  const panel = useRef<HTMLDivElement>(null)
  const drag = useRef<{ startX: number; startY: number; origin: Position } | null>(null)

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(position)) } catch (e) { /* ignore */ }
  }, [position])

  useEffect(() => {
    try { localStorage.setItem(FOLD_KEY, folded ? '1' : '0') } catch (e) { /* ignore */ }
  }, [folded])

  const toggleFolded = useCallback((event: React.MouseEvent) => {
    event.stopPropagation()
    setFolded(f => !f)
  }, [])

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = { startX: event.clientX, startY: event.clientY, origin: position }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }, [position])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    // buttons === 1: primary button still held; ignores stray moves after a click or double-click
    if (!drag.current || !panel.current || event.buttons !== 1) return
    const { startX, startY, origin } = drag.current
    const { offsetWidth, offsetHeight } = panel.current
    setPosition(clamp({ left: origin.left + event.clientX - startX, top: origin.top + event.clientY - startY }, offsetWidth, offsetHeight))
  }, [])

  const onPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    drag.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }, [])

  const reset = useCallback(() => {
    drag.current = null
    setPosition(DEFAULT_POSITION)
  }, [])

  return (
    <div ref={panel} className="ptc-legend" style={{ left: position.left, top: position.top }}>
      <div className="ptc-legend-title"
        title="drag to move, double-click to reset"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onDoubleClick={reset}>
        <span>🦫 payload PTC votes (of {ptcSize})</span>
        <button className="ptc-legend-fold" onClick={toggleFolded} onPointerDown={e => e.stopPropagation()}
          title={folded ? 'expand legend' : 'fold legend'} aria-expanded={!folded}>{folded ? '▸' : '▾'}</button>
      </div>
      {!folded && <>
        <div><Ring color={PTC_COLORS.yes} width={3} /> voted payload present</div>
        <div><Ring color={PTC_COLORS.votedNotYes} width={3} /> voted payload absent</div>
        <div><Ring color={PTC_COLORS.notVoted} width={3} /> no vote received</div>
        <div><Ring color={PTC_COLORS.dataYes} width={2} /> inner ring: voted blob data available</div>
      </>}
    </div>
  )
}
