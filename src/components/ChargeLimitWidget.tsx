import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { setChargeLimit } from '../api/client'
import type { Commands } from '../hooks/useCommands'
import { LimitIcon } from './Icons'
import { Widget, WidgetNote } from './Widget'

const LS_LIMIT = 'ec4.chargeLimit'

const MIN = 50
const MAX = 100
const STEP = 5
const DEFAULT = 80

/** Vertical travel for the whole 50–100 sweep. 22px a step is a deliberate move. */
const SWEEP_PX = 220
/** Below this the finger is still deciding, and a long press can claim it. */
const START_PX = 6
/** How long the keyboard waits after the last arrow before it sends. */
const KEY_SETTLE_MS = 700

const snap = (value: number) =>
  Math.min(MAX, Math.max(MIN, Math.round(value / STEP) * STEP))

function stored(): number | null {
  const value = Number(localStorage.getItem(LS_LIMIT))
  return Number.isFinite(value) && value > 0 ? value : null
}

/**
 * The maximum the car will charge to, set by swiping the tile up and down.
 *
 * Nothing is sent while the finger is moving. The gesture only moves a pending
 * number; releasing is what commits it. Sending on every step would put a dozen
 * commands on the wire for one decision, and each of those wakes the car.
 *
 * The swipe has to coexist with the grid's long press, so it does not claim the
 * pointer until the finger has actually travelled — hold still and the tile
 * gets picked up for rearranging instead.
 *
 * get_vehicleinfo does not report the configured threshold back, so the last
 * value we successfully set is remembered locally and shown as current. It is a
 * display hint, not authoritative state.
 */
export function ChargeLimitWidget({ commands }: { commands: Commands }) {
  const [saved, setSaved] = useState<number | null>(stored)
  const [value, setValue] = useState(() => stored() ?? DEFAULT)
  const [dragging, setDragging] = useState(false)
  const [settling, setSettling] = useState(false)
  const gesture = useRef<{ pointerId: number; startY: number; from: number; live: boolean } | null>(null)

  const busy = commands.active?.kind === 'chargeLimit'
  const blocked = Boolean(commands.active)

  const commit = (next: number) => {
    if (next === saved) return
    void commands.run({
      kind: 'chargeLimit',
      label: `Setting charge limit to ${next}%`,
      send: async () => {
        const result = await setChargeLimit(next)
        localStorage.setItem(LS_LIMIT, String(next))
        setSaved(next)
        return result
      },
    })
  }

  // The keyboard has no "release", so it settles instead: the value lands once
  // the arrow keys stop.
  useEffect(() => {
    if (!settling) return
    const timer = window.setTimeout(() => {
      setSettling(false)
      commit(value)
    }, KEY_SETTLE_MS)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settling, value])

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (blocked || gesture.current) return
    if (event.pointerType === 'mouse' && event.button !== 0) return
    gesture.current = { pointerId: event.pointerId, startY: event.clientY, from: value, live: false }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current || event.pointerId !== current.pointerId) return
    const travelled = current.startY - event.clientY

    if (!current.live) {
      if (Math.abs(travelled) < START_PX) return
      current.live = true
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
    }
    setValue(snap(current.from + (travelled / SWEEP_PX) * (MAX - MIN)))
  }

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current
    if (!current || event.pointerId !== current.pointerId) return
    gesture.current = null
    if (!current.live) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    setDragging(false)
    commit(value)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (blocked) return
    const next =
      event.key === 'ArrowUp' || event.key === 'ArrowRight'
        ? value + STEP
        : event.key === 'ArrowDown' || event.key === 'ArrowLeft'
          ? value - STEP
          : event.key === 'Home'
            ? MIN
            : event.key === 'End'
              ? MAX
              : null
    if (next === null) return
    event.preventDefault()
    event.stopPropagation() // never let an arrow key reach the grid's reorder handler
    setValue(snap(next))
    setSettling(true)
  }

  const pending = dragging || settling
  const note = pending
    ? `Release to set ${value}%`
    : saved === null
      ? 'Swipe up or down to change'
      : `Set to ${saved}%`

  return (
    <Widget icon={<LimitIcon />} label="Charge limit" className="widget-limit">
      <div
        className={`limit-swipe ${dragging ? 'is-dragging' : ''} ${busy ? 'is-busy' : ''}`}
        role="slider"
        tabIndex={0}
        aria-label="Maximum charge"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={value}
        aria-valuetext={`${value} percent`}
        aria-disabled={blocked || undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
      >
        <p className="widget-value">
          {value}
          <span className="widget-unit">%</span>
        </p>
        <div className="limit-track" aria-hidden="true">
          <div
            className="limit-fill"
            style={{ height: `${((value - MIN) / (MAX - MIN)) * 100}%` }}
          />
        </div>
      </div>
      <WidgetNote>{note}</WidgetNote>
    </Widget>
  )
}
