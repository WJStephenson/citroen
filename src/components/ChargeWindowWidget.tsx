import { useEffect, useState, type ReactNode } from 'react'
import {
  clearChargeStartHour,
  clearChargeStopHour,
  setChargeStartHour,
  setChargeStopHour,
} from '../api/client'
import type { Commands } from '../hooks/useCommands'
import { BoltIcon, CheckIcon, ClockIcon } from './Icons'
import { Widget } from './Widget'

const LS_START = 'ec4.chargeStart'
const LS_STOP = 'ec4.chargeStop'

const DAY = 1440

/*
 * Dial geometry, in the 100×100 viewBox the ring is drawn in. A charging window
 * is a span on a clock, not a bar on a line: it wraps midnight as a matter of
 * course, which a ring shows for free and a left-to-right track has to
 * apologise for. Midnight sits at the top, so the overnight window every
 * off-peak tariff wants reads as an arc across the top of the dial.
 */
const RING_R = 38
const RING_C = 2 * Math.PI * RING_R
/** A one-sided window has no length to draw, so its end gets a round-capped stub. */
const STUB = 15

/**
 * The charging window, sent as two independent commands because the bridge
 * treats them as two unrelated features:
 *
 *   start -> /charge_hour     a remote command to the car's delayed-charge clock
 *   stop  -> /charge_control  PSACC's own logic, which cuts the charge locally
 *
 * They can therefore fail independently, so each has its own confirm button
 * rather than one button that half-works. The stop hour needs charge control
 * configured in PSACC for this VIN; the start hour does not.
 *
 * Clearing them works differently too, for the same reason:
 *   - Stop is cleared with the [0, 0] sentinel the bridge reads as "disabled".
 *   - Start has no "unset". The car always holds an hour; what changes is
 *     whether it charges immediately or waits, so clearing means switching to
 *     immediate charging.
 *
 * The tile is in three bands, top to bottom: what the window *is* (the dial and
 * its headline), what it is *set to* (the two editable rows), and the two
 * overrides that throw it away. Only the middle band is a form, and it is the
 * only part drawn on a raised panel — so the reading above it is a reading, not
 * the first field of one.
 */
export function ChargeWindowWidget({ commands }: { commands: Commands }) {
  const [start, setStart] = useState(() => localStorage.getItem(LS_START) ?? '00:30')
  const [stop, setStop] = useState(() => localStorage.getItem(LS_STOP) ?? '07:00')
  const [savedStart, setSavedStart] = useState(() => localStorage.getItem(LS_START))
  const [savedStop, setSavedStop] = useState(() => localStorage.getItem(LS_STOP))

  /*
   * The dial carries a marker for the present, which is what makes "is the
   * window open right now?" answerable without doing clock arithmetic. A minute
   * is as fine as the window itself is set, so nothing here needs a faster tick.
   */
  const [now, setNow] = useState(minutesNow)
  useEffect(() => {
    const timer = window.setInterval(() => setNow(minutesNow()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const disabled = Boolean(commands.active)
  /*
   * One tile, three commands. The ring says this tile is working; each row's own
   * spinner says which of its actions — the tile alone could not, and the start
   * hour and the stop hour fail independently.
   */
  const kind = commands.active?.kind

  const parse = (value: string): [number, number] | null => {
    const [h, m] = value.split(':').map(Number)
    if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return null
    return [h, m]
  }

  // 00:00 reaches the bridge as "disable", never as midnight.
  const stopIsMidnight = stop === '00:00'

  const applyStart = () => {
    const parsed = parse(start)
    if (!parsed) return
    void commands.run({
      kind: 'chargeStart',
      label: `Setting charge start to ${start}`,
      send: async () => {
        const result = await setChargeStartHour(parsed[0], parsed[1])
        localStorage.setItem(LS_START, start)
        setSavedStart(start)
        return result
      },
    })
  }

  const applyStop = () => {
    const parsed = parse(stop)
    if (!parsed) return
    void commands.run({
      kind: 'chargeStop',
      label: stopIsMidnight ? 'Clearing stop time' : `Setting charge stop to ${stop}`,
      send: async () => {
        const result = await setChargeStopHour(parsed[0], parsed[1])
        if (stopIsMidnight) {
          localStorage.removeItem(LS_STOP)
          setSavedStop(null)
        } else {
          localStorage.setItem(LS_STOP, stop)
          setSavedStop(stop)
        }
        return result
      },
    })
  }

  const clearStart = () =>
    void commands.run({
      kind: 'chargeNow',
      label: 'Switching to immediate charging',
      send: async () => {
        const result = await clearChargeStartHour()
        localStorage.removeItem(LS_START)
        setSavedStart(null)
        return result
      },
    })

  const clearStop = () =>
    void commands.run({
      kind: 'chargeStop',
      label: 'Clearing stop time',
      send: async () => {
        const result = await clearChargeStopHour()
        localStorage.removeItem(LS_STOP)
        setSavedStop(null)
        return result
      },
    })

  const startAt = toMinutes(savedStart)
  const stopAt = toMinutes(savedStop)

  /* Crossing midnight is normal for an off-peak tariff, so it is measured
     forward from the start rather than flagged as an error. */
  const span = startAt !== null && stopAt !== null ? (stopAt - startAt + DAY) % DAY : null
  const overnight = span !== null && stopAt !== null && startAt !== null && stopAt <= startAt
  const open = span !== null && startAt !== null && (now - startAt + DAY) % DAY < span

  const headline =
    savedStart && savedStop
      ? `${savedStart} – ${savedStop}`
      : savedStart
        ? `From ${savedStart}`
        : savedStop
          ? `Until ${savedStop}`
          : 'Not set'

  /*
   * How long the window lasts is already the number in the middle of the dial,
   * so this line does not repeat it. What the dial cannot say is *when* — the
   * arc shows where the window sits on the day, but not how far round to it
   * from here, which is the thing you actually want at half past ten at night.
   */
  const until =
    startAt === null || stopAt === null
      ? null
      : open
        ? (stopAt - now + DAY) % DAY
        : (startAt - now + DAY) % DAY

  const meta =
    span === 0
      ? 'Start and stop are the same'
      : until !== null
        ? `${open ? 'Ends' : 'Starts'} in ${formatSpan(until)}${overnight ? ' · overnight' : ''}`
        : savedStart
          ? 'Waits until then to start'
          : savedStop
            ? 'Starts immediately, stops then'
            : 'Charges as soon as it is plugged in'

  return (
    <Widget
      icon={<ClockIcon />}
      label="Charging window"
      className={`widget-window ${open ? 'is-open' : ''}`}
      working={kind === 'chargeStart' || kind === 'chargeStop' || kind === 'chargeNow'}
      outcome={commands.outcomeFor('chargeStart', 'chargeStop', 'chargeNow')}
    >
      <div className="window-top">
        <div className="window-dial">
          <svg viewBox="0 0 100 100" aria-hidden="true">
            <circle className="window-track" cx="50" cy="50" r={RING_R} />

            {/* Quarters of the day, so the ring reads as a clock rather than as
                a progress bar bent into a circle. Midnight is the brighter one:
                it is where the arc is measured from and where it wraps. */}
            {[0, 6, 12, 18].map((hour) => (
              <line
                key={hour}
                className={`window-tick ${hour === 0 ? 'is-midnight' : ''}`}
                x1="50"
                y1={50 - RING_R - 9}
                x2="50"
                y2={50 - RING_R - 5}
                transform={`rotate(${(hour / 24) * 360} 50 50)`}
              />
            ))}

            {startAt !== null && (
              <circle
                className="window-arc"
                cx="50"
                cy="50"
                r={RING_R}
                strokeDasharray={`${((span === null || span === 0 ? STUB : span) / DAY) * RING_C} ${RING_C}`}
                transform={`rotate(${(startAt / DAY) * 360 - 90} 50 50)`}
              />
            )}
            {startAt === null && stopAt !== null && (
              <circle
                className="window-arc"
                cx="50"
                cy="50"
                r={RING_R}
                strokeDasharray={`${(STUB / DAY) * RING_C} ${RING_C}`}
                transform={`rotate(${((stopAt - STUB) / DAY) * 360 - 90} 50 50)`}
              />
            )}

            {/* Now. Ringed in the tile's own colour so it stays legible where it
                crosses the arc. */}
            <circle
              className="window-now"
              cx="50"
              cy={50 - RING_R}
              r="3.4"
              transform={`rotate(${(now / DAY) * 360} 50 50)`}
            />
          </svg>

          <p className="window-dial-centre" aria-hidden="true">
            {span === null || span === 0 ? '—' : formatSpan(span)}
          </p>
        </div>

        <div className="window-summary">
          <p className="window-time">
            {headline}
            {open && <span className="window-open">Open</span>}
          </p>
          <p className="widget-note">{meta}</p>
        </div>
      </div>

      <div className="window-panel" role="group" aria-label="Charging window times">
        <WindowRow
          id="charge-start"
          label="Start"
          tone="start"
          value={start}
          onChange={setStart}
          disabled={disabled}
          working={kind === 'chargeStart'}
          dirty={start !== savedStart}
          onApply={applyStart}
          applyLabel={`Set the charge start time to ${start}`}
        />
        <WindowRow
          id="charge-stop"
          label="Stop"
          tone="stop"
          value={stop}
          onChange={setStop}
          disabled={disabled}
          working={kind === 'chargeStop'}
          dirty={stop !== savedStop || stopIsMidnight}
          onApply={applyStop}
          applyLabel={stopIsMidnight ? 'Clear the stop time' : `Set the charge stop time to ${stop}`}
          /* The 00:00 sentinel used to be signalled by the button quietly
             relabelling itself to "Clear". Said out loud instead, because the
             button is now a mark rather than a word. */
          hint={stopIsMidnight ? '00:00 clears the stop time' : undefined}
        />
      </div>

      <div className="window-actions">
        <button
          type="button"
          className={`button ${kind === 'chargeNow' ? 'is-busy' : ''}`}
          onClick={clearStart}
          disabled={disabled}
        >
          <BoltIcon />
          Charge now
        </button>
        <button
          type="button"
          className="button is-quiet"
          onClick={clearStop}
          disabled={disabled || !savedStop}
        >
          Clear stop
        </button>
      </div>
    </Widget>
  )
}

/**
 * One editable time: what it is, what it is set to, and a mark to send it.
 *
 * The confirm button only lights when the field differs from what the car was
 * last told — so the row itself says whether there is anything to send, and the
 * two rows say it independently, which is the whole reason there are two.
 */
function WindowRow({
  id,
  label,
  tone,
  value,
  onChange,
  disabled,
  working,
  dirty,
  onApply,
  applyLabel,
  hint,
}: {
  id: string
  label: string
  tone: 'start' | 'stop'
  value: string
  onChange: (value: string) => void
  disabled: boolean
  working: boolean
  dirty: boolean
  onApply: () => void
  applyLabel: string
  hint?: ReactNode
}) {
  return (
    <div className={`window-row ${dirty ? 'is-dirty' : ''}`}>
      <label className="window-label" htmlFor={id}>
        <span className={`window-dot is-${tone}`} aria-hidden="true" />
        {label}
      </label>
      <input
        id={id}
        type="time"
        className="time-input is-chip"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled}
      />
      <button
        type="button"
        className={`window-apply ${dirty ? 'is-ready' : ''} ${working ? 'is-working' : ''}`}
        onClick={onApply}
        disabled={disabled || !dirty}
        aria-label={applyLabel}
      >
        <CheckIcon />
      </button>
      {hint && <p className="window-hint">{hint}</p>}
    </div>
  )
}

function minutesNow(): number {
  const date = new Date()
  return date.getHours() * 60 + date.getMinutes()
}

function toMinutes(value: string | null): number | null {
  if (!value) return null
  const [h, m] = value.split(':').map(Number)
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return null
  return h * 60 + m
}

function formatSpan(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}
