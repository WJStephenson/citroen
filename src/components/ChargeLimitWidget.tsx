import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { setChargeLimit } from '../api/client'
import type { VehicleState } from '../api/types'
import type { Commands } from '../hooks/useCommands'
import { LimitIcon } from './Icons'
import { Widget, WidgetNote } from './Widget'

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
 * `get_vehicleinfo` does not report the configured threshold, but PSACC's own
 * /charge_control does when read without mutating params — see
 * fetchChargeControlState in api/client.ts. state.chargeLimitPercent is that
 * live reading, not a locally remembered "last value any device sent"; if
 * PSACC's config was ever reset (a re-auth after a connectivity outage does
 * this — see the app_decoder patch in docker-compose.yml) this tile now shows
 * that honestly instead of continuing to display a stale number nobody's car
 * is actually holding.
 */
export function ChargeLimitWidget({ commands, state }: { commands: Commands; state: VehicleState }) {
  const saved = state.chargeControlConfigured ? state.chargeLimitPercent : null
  const [value, setValue] = useState(() => saved ?? DEFAULT)
  const [dragging, setDragging] = useState(false)
  const [settling, setSettling] = useState(false)
  const gesture = useRef<{ pointerId: number; startY: number; from: number; live: boolean } | null>(null)
  const savedRef = useRef(saved)

  // A poll can land the car's real value under this tile at any time. Only
  // nudge the pending value if it still matched the old known one — a swipe
  // already in progress locally is never clobbered.
  useEffect(() => {
    if (saved === savedRef.current) return
    setValue((draft) => (draft === savedRef.current ? (saved ?? DEFAULT) : draft))
    savedRef.current = saved
  }, [saved])

  const busy = commands.active?.kind === 'chargeLimit'
  const blocked = Boolean(commands.active)

  const commit = (next: number) => {
    if (next === saved) return
    void commands.run({
      kind: 'chargeLimit',
      label: `Setting charge limit to ${next}%`,
      optimistic: { chargeLimitPercent: next, chargeControlConfigured: true },
      send: () => setChargeLimit(next),
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
    : !state.chargeControlConfigured
      ? "Not set up in PSACC — won't take effect until it is"
      : saved === null
        ? 'Swipe up or down to change'
        : `Set to ${saved}%`

  return (
    <Widget
      icon={<LimitIcon />}
      label="Charge limit"
      className="widget-limit"
      working={busy}
      outcome={commands.outcomeFor('chargeLimit')}
    >
      <div
        className={`limit-swipe ${dragging ? 'is-dragging' : ''}`}
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
