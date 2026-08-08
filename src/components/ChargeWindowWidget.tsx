import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  clearChargeStartHour,
  clearChargeStopHour,
  resumeDelayedCharge,
  setChargeStartHour,
  setChargeStopHour,
} from '../api/client'
import {
  DAY,
  formatSpan,
  isWindowOpen,
  minutesNow,
  observeChargeType,
  toMinutes,
  windowSpan,
  type ChargeType,
} from '../chargeWindow'
import type { Commands } from '../hooks/useCommands'
import type { VehicleState } from '../api/types'
import { BoltIcon, CheckIcon, ClockIcon } from './Icons'
import { Widget } from './Widget'

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
 *   - Start has no "unset". The car always holds an hour; what changes is the
 *     charge *type* — whether it charges immediately or waits for that hour.
 *
 * Which makes the type a third setting, and it gets its own row rather than
 * being the side effect of a button labelled something else. It used to be
 * exactly that: a one-way "Charge now" that sent IMMEDIATE_CHARGE with no way
 * back and nothing on the tile to show it had happened. The car kept the hour,
 * so the dial, the headline and the car's own infotainment screen all went on
 * showing a schedule the car had stopped honouring, and the only route back to
 * it was re-sending a start hour — which works only because /charge_hour
 * carries type=delayed along with the hour, and which pauses whatever charge is
 * running at the time.
 *
 * Both directions are on the wire now (/charge_now/{VIN}/{1|0}) and the row
 * says which one the car appears to be on. "Appears" is doing real work there —
 * see observeChargeType. Nothing reports the type back, so the row shows an
 * observation where there is one, this device's own last command where there is
 * not, and "not reported" rather than a confident guess when it has neither.
 *
 * What the dial and headline show is read back from the car/bridge —
 * state.chargeStartHour from the car's own next_delayed_time, chargeStopHour
 * from PSACC's /charge_control — not "what we last asked for". A stored
 * setting can be silently lost (an OTP re-auth after a connectivity outage
 * once wiped PSACC's stop hour without touching the car's own start hour;
 * see the app_decoder patch in docker-compose.yml) and this tile has to say
 * so, not keep repeating the last command back as if it were still in
 * effect. Right after a command the optimistic value shows immediately, and
 * the live refresh useCommands.run schedules a few seconds later corrects it
 * if the car didn't actually take it.
 *
 * The tile is in four bands, top to bottom: what the window *is* (the dial and
 * its headline), what it is *set to* (the two editable rows), whether the car
 * is using it at all (the charge type), and the override that throws the stop
 * hour away. Only the second band is a form, and it is the only part drawn on a
 * raised panel — so the reading above it is a reading, not the first field of
 * one.
 */
export function ChargeWindowWidget({ commands, state }: { commands: Commands; state: VehicleState }) {
  const [start, setStart] = useState(() => state.chargeStartHour ?? '00:30')
  const [stop, setStop] = useState(() => state.chargeStopHour ?? '07:00')

  // A poll can land the car's real value under this tile at any time. Only
  // nudge the editable field if it still matched the old known value — an
  // in-progress local edit is never clobbered by a poll landing mid-edit.
  const knownStartRef = useRef(state.chargeStartHour)
  const knownStopRef = useRef(state.chargeStopHour)

  useEffect(() => {
    const nextStart = state.chargeStartHour
    if (nextStart !== knownStartRef.current) {
      setStart((draft) => (draft === knownStartRef.current ? (nextStart ?? '00:30') : draft))
      knownStartRef.current = nextStart
    }
    const nextStop = state.chargeStopHour
    if (nextStop !== knownStopRef.current) {
      setStop((draft) => (draft === knownStopRef.current ? (nextStop ?? '07:00') : draft))
      knownStopRef.current = nextStop
    }
  }, [state.chargeStartHour, state.chargeStopHour])

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
   * One tile, three command kinds. The ring says this tile is working; each
   * row's own spinner says which of its actions — the tile alone could not, and
   * the start hour and the stop hour fail independently.
   */
  const kind = commands.active?.kind

  const savedStart = state.chargeStartHour
  const savedStop = state.chargeStopHour
  const startAt = toMinutes(savedStart)
  const stopAt = toMinutes(savedStop)

  /* Crossing midnight is normal for an off-peak tariff, so it is measured
     forward from the start rather than flagged as an error. */
  const span = windowSpan(startAt, stopAt)
  const overnight = stopAt !== null && startAt !== null && stopAt <= startAt
  const open = isWindowOpen(startAt, span, now)

  /*
   * Which charge type the car is on, as well as it can be known.
   *
   * `observed` is read from what the car is doing right now — see
   * observeChargeType — and is deliberately never remembered. A car charging
   * outside its window says nothing about the car an hour after it stopped, so
   * writing the observation down turns a momentary reading into a claim that
   * outlives it. (It did exactly that in the first cut of this tile: a car that
   * had been on immediate went on being described that way long after a start
   * hour had put it back on schedule.)
   *
   * `assumed` is nothing grander than this device's memory of its own last
   * command, for the stretches where the car's behaviour separates neither type
   * — unplugged, mostly. It is not persisted: a hint that outlives the session
   * it was made in is indistinguishable from a reading, and this app has been
   * bitten by that before (see the charge hints this tile used to show).
   */
  const [assumed, setAssumed] = useState<{ type: ChargeType; against: number | null } | null>(null)
  const observed = observeChargeType({
    charging: state.charging,
    mode: state.chargingMode,
    startAt,
    span,
    now,
    battery: state.battery,
    limit: state.chargeControlConfigured ? state.chargeLimitPercent : null,
  })

  /*
   * The car takes 30-90s to act, so the reading on screen when you press a
   * button is necessarily from before you pressed it. Until the car has
   * reported something *since*, what was asked for outranks what can be seen —
   * otherwise pressing Schedule on a charging car is answered by the tile
   * insisting, from the stale reading, that it is still on immediate.
   *
   * The test is on the reading the car sent, not on a clock: the car's and the
   * phone's are two different clocks and neither is ours to trust.
   */
  const reportedAt = state.reportedAt?.getTime() ?? null
  const answered = assumed === null || reportedAt !== assumed.against
  /* Everything the tile says about the charge type comes through here, so the
     segments, the note and the warning cannot end up telling three stories —
     the whole row goes quiet together while a command is unanswered. */
  const reading = answered ? observed : null
  const chargeType = reading ?? assumed?.type ?? null

  // Once the car has answered and disagrees, the hint has been overtaken —
  // by another phone, by the car, or by any start hour set since. Drop it, so
  // it cannot resurface the next time the car is unplugged and unreadable.
  useEffect(() => {
    if (answered && observed && assumed && observed !== assumed.type) setAssumed(null)
  }, [answered, observed, assumed])

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
      optimistic: { chargeStartHour: start },
      send: () => setChargeStartHour(parsed[0], parsed[1]),
    })
  }

  const applyStop = () => {
    const parsed = parse(stop)
    if (!parsed) return
    void commands.run({
      kind: 'chargeStop',
      label: stopIsMidnight ? 'Clearing stop time' : `Setting charge stop to ${stop}`,
      optimistic: { chargeStopHour: stopIsMidnight ? null : stop },
      send: () => setChargeStopHour(parsed[0], parsed[1]),
    })
  }

  /*
   * The charge type, both directions on one command kind — they are the same
   * message to the car with one field swapped, and only one of them can be in
   * flight anyway.
   *
   * No optimistic patch: the car keeps holding whatever hour it had (that part
   * of state.chargeStartHour stays true either way), and the thing that does
   * change has no field on VehicleState to patch because the bridge never
   * reports it. `assumed` stands in for that, and is only set once the bridge
   * has acknowledged the command — a rejected command must not leave the row
   * claiming a type the car never took.
   */
  const applyChargeType = (type: ChargeType) => {
    void commands
      .run({
        kind: 'chargeNow',
        label:
          type === 'immediate'
            ? 'Switching to immediate charging'
            : 'Putting the car back on its schedule',
        send: type === 'immediate' ? clearChargeStartHour : resumeDelayedCharge,
      })
      .then((sent) => {
        if (sent) setAssumed({ type, against: state.reportedAt?.getTime() ?? null })
      })
  }

  const clearStop = () =>
    void commands.run({
      kind: 'chargeStop',
      label: 'Clearing stop time',
      optimistic: { chargeStopHour: null },
      send: clearChargeStopHour,
    })

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

  /*
   * Every line below the headline used to assert the window was in force —
   * "Starts in 9h 30m", "Waits until then to start" — on the strength of the
   * hours alone, which is precisely the assertion the car can quietly stop
   * honouring. When the car is seen not honouring it, that claim is withdrawn
   * rather than dressed up: the window is still *set*, it is simply not what
   * the car is doing, and the row underneath says what to press about it.
   *
   * Read from the car only. A hint from this phone lights its own segment and
   * says so in its own row; it does not get to overwrite the reading above it
   * or paint it as a warning. Warning colour on this dashboard means the car is
   * doing something, and a remembered command is not the car doing anything.
   */
  const ignoringSchedule = reading === 'immediate'

  /*
   * Open says the clock is inside the window, which is not the same claim as
   * the car acting on it. Both the badge and the arc's glow say "this is
   * happening", so both stand down when the type says it is not — rather than
   * glowing away next to a warning that contradicts them.
   */
  const showOpen = open && !ignoringSchedule

  const meta = ignoringSchedule
    ? 'Charging now, outside the window'
    : span === 0
      ? 'Start and stop are the same'
      : until !== null
        ? `${open ? 'Ends' : 'Starts'} in ${formatSpan(until)}${overnight ? ' · overnight' : ''}`
        : savedStart
          ? 'Waits until then to start'
          : savedStop
            ? 'Starts immediately, stops then'
            : 'Charges as soon as it is plugged in'

  /*
   * What the row can say, in descending order of evidence: what the car is
   * doing, what this phone last asked for, and why neither is available.
   *
   * The first two both name the behaviour they are read from rather than
   * asserting a setting nothing reports — "plugged in and waiting for 23:00" is
   * something you can look out of the window and check, where "on schedule"
   * would be the app's word for it and nothing more.
   */
  const typeNote =
    savedStart === null
      ? 'The car reports no stored hour, so there is nothing to wait for'
      : reading === 'immediate'
        ? // The line above the panel has already said what is happening; this
          // one says what it means and what the switch beside it is for.
          `On immediate charge — ${savedStart} stays stored but unused`
        : reading === 'delayed'
          ? `Plugged in and waiting for ${savedStart}`
          : chargeType === 'immediate'
            ? `Set to charge now from this phone — ${savedStart} stays stored, unused`
            : chargeType === 'delayed'
              ? `Set back to ${savedStart} from this phone`
              : state.charging === 'disconnected'
                ? 'Not plugged in — the car only shows which it is on by what it does'
                : 'Nothing the car is doing right now separates the two'

  return (
    <Widget
      icon={<ClockIcon />}
      label="Charging window"
      className={`widget-window ${showOpen ? 'is-open' : ''}`}
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
            {showOpen && <span className="window-open">Open</span>}
          </p>
          <p className={`widget-note ${ignoringSchedule ? 'is-warn' : ''}`}>{meta}</p>
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
          hint={
            // Charge control being unset is the exact failure this tile used
            // to hide: PSACC forgets the stop hour on certain reconnects (see
            // the app_decoder patch), and without this the row would just
            // keep showing whatever was last typed in as if it still held.
            !state.chargeControlConfigured
              ? "Not set up in PSACC — this won't take effect until it is"
              : // The 00:00 sentinel used to be signalled by the button quietly
                // relabelling itself to "Clear". Said out loud instead, because
                // the button is now a mark rather than a word.
                stopIsMidnight
                ? '00:00 clears the stop time'
                : undefined
          }
        />
      </div>

      {/*
        The third band: whether the car is using the window above at all. It is
        two commands, not a preference — each one wakes the car and takes the
        same 30-90s as everything else on this tile — so the pair is lit by
        what is known about the car rather than by what was last tapped, and
        neither is lit when nothing is known.
      */}
      <div className={`window-mode ${ignoringSchedule ? 'is-warn' : ''}`}>
        <div className="window-mode-row">
          <span className="window-mode-label">
            <BoltIcon />
            Charge type
          </span>
          <div className="segmented is-pair" role="group" aria-label="Charge type">
            <button
              type="button"
              className={`segment ${chargeType === 'delayed' ? 'is-selected' : ''}`}
              aria-pressed={chargeType === 'delayed'}
              onClick={() => applyChargeType('delayed')}
              disabled={disabled || savedStart === null}
            >
              Schedule
            </button>
            <button
              type="button"
              className={`segment ${chargeType === 'immediate' ? 'is-selected' : ''}`}
              aria-pressed={chargeType === 'immediate'}
              onClick={() => applyChargeType('immediate')}
              disabled={disabled}
            >
              Charge now
            </button>
          </div>
        </div>
        <p className={`window-mode-note ${reading === 'immediate' ? 'is-warn' : ''}`}>{typeNote}</p>
      </div>

      <div className="window-actions">
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
