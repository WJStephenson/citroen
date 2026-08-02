import { useState } from 'react'
import {
  clearChargeStartHour,
  clearChargeStopHour,
  setChargeStartHour,
  setChargeStopHour,
} from '../api/client'
import type { Commands } from '../hooks/useCommands'
import { ClockIcon } from './Icons'
import { Widget, WidgetNote } from './Widget'

const LS_START = 'ec4.chargeStart'
const LS_STOP = 'ec4.chargeStop'

/**
 * The charging window, sent as two independent commands because the bridge
 * treats them as two unrelated features:
 *
 *   start -> /charge_hour     a remote command to the car's delayed-charge clock
 *   stop  -> /charge_control  PSACC's own logic, which cuts the charge locally
 *
 * They can therefore fail independently, so each has its own Set button rather
 * than one button that half-works. The stop hour needs charge control
 * configured in PSACC for this VIN; the start hour does not.
 *
 * Clearing them works differently too, for the same reason:
 *   - Stop is cleared with the [0, 0] sentinel the bridge reads as "disabled".
 *   - Start has no "unset". The car always holds an hour; what changes is
 *     whether it charges immediately or waits, so clearing means switching to
 *     immediate charging.
 */
export function ChargeWindowWidget({ commands }: { commands: Commands }) {
  const [start, setStart] = useState(() => localStorage.getItem(LS_START) ?? '00:30')
  const [stop, setStop] = useState(() => localStorage.getItem(LS_STOP) ?? '07:00')
  const [savedStart, setSavedStart] = useState(() => localStorage.getItem(LS_START))
  const [savedStop, setSavedStop] = useState(() => localStorage.getItem(LS_STOP))

  const disabled = Boolean(commands.active)

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

  const window =
    savedStart && savedStop
      ? `${savedStart} – ${savedStop}`
      : savedStart
        ? `From ${savedStart}`
        : savedStop
          ? `Until ${savedStop}`
          : 'No window set from this app'

  // Crossing midnight is normal for an off-peak tariff, so it is described
  // rather than flagged as an error.
  const overnight =
    savedStart !== null && savedStop !== null && savedStart > savedStop ? ' (overnight)' : ''

  return (
    <Widget icon={<ClockIcon />} label="Charging window">
      <WidgetNote>
        {window}
        {overnight}
      </WidgetNote>

      <div className="window-grid">
        <label className="window-label" htmlFor="charge-start">
          Start
        </label>
        <input
          id="charge-start"
          type="time"
          className="time-input"
          value={start}
          onChange={(event) => setStart(event.target.value)}
          disabled={disabled}
        />
        <button
          type="button"
          className={`button ${commands.active?.kind === 'chargeStart' ? 'is-busy' : ''}`}
          onClick={applyStart}
          disabled={disabled || start === savedStart}
        >
          Set
        </button>

        <label className="window-label" htmlFor="charge-stop">
          Stop
        </label>
        <input
          id="charge-stop"
          type="time"
          className="time-input"
          value={stop}
          onChange={(event) => setStop(event.target.value)}
          disabled={disabled}
        />
        <button
          type="button"
          className={`button ${commands.active?.kind === 'chargeStop' ? 'is-busy' : ''}`}
          onClick={applyStop}
          disabled={disabled || (stop === savedStop && !stopIsMidnight)}
        >
          {stopIsMidnight ? 'Clear' : 'Set'}
        </button>
      </div>

      <div className="row">
        <button
          type="button"
          className={`button ${commands.active?.kind === 'chargeNow' ? 'is-busy' : ''}`}
          onClick={clearStart}
          disabled={disabled}
        >
          Charge now
        </button>
        <button type="button" className="button" onClick={clearStop} disabled={disabled || !savedStop}>
          Clear stop
        </button>
      </div>
    </Widget>
  )
}
