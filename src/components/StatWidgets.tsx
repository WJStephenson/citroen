import { useEffect, useState, type CSSProperties } from 'react'
import { fetchTrips } from '../api/client'
import type { ChargingStatus, Trip, VehicleState } from '../api/types'
import { useUnits } from '../hooks/useUnits'
import { distanceSince, startOfMonth, startOfWeek } from '../periods'
import { formatDistance, isPlausibleAuxVoltage } from '../units'
import { Widget, WidgetNote, WidgetValue } from './Widget'
import { BatteryIcon, BoltIcon, OdometerIcon, PlugIcon, ThermometerIcon } from './Icons'

/** Meter contract: the fill carries severity, and the number stays in text ink. */
function levelColour(level: number | null): string {
  if (level === null) return 'var(--muted)'
  if (level <= 10) return 'var(--danger)'
  if (level <= 25) return 'var(--warn)'
  return 'var(--accent)'
}

/* ---------- charge ---------- */

/**
 * The one tile that is allowed to be loud: it fills from the bottom to the
 * state of charge, and the reading is cut in half by the waterline. How much
 * charge is in the car is in the silhouette, readable at arm's length without
 * finding the number.
 *
 * Range lives here as the line under it rather than as a tile of its own —
 * range *is* the charge, expressed in the unit you actually plan around, and
 * two tiles for one fact is how a dashboard turns into filler.
 */
export function ChargeWidget({ state, stale }: { state: VehicleState; stale: boolean }) {
  const units = useUnits()
  const level = state.battery
  const charging = state.charging === 'charging'
  const colour = levelColour(level)

  return (
    <Widget
      icon={<BoltIcon />}
      label="Charge"
      className={`widget-charge ${stale ? 'is-stale' : ''} ${charging ? 'is-charging' : ''}`}
      style={{ '--meter-color': colour } as CSSProperties}
      flood={level === null ? undefined : { fraction: Math.min(1, Math.max(0, level / 100)), color: colour }}
    >
      <WidgetValue
        size="lg"
        value={level === null ? '—' : Math.round(level)}
        unit={level === null ? undefined : '%'}
      />
      <WidgetNote>
        {state.range === null
          ? 'Range not reported'
          : `${formatDistance(state.range, units.distance)} of range`}
      </WidgetNote>
    </Widget>
  )
}

/* ---------- charge state ---------- */

const CHARGING_LABEL: Record<ChargingStatus, string> = {
  charging: 'Charging',
  'plugged-idle': 'Plugged in',
  finished: 'Charge complete',
  disconnected: 'Unplugged',
  failure: 'Charge fault',
  unknown: 'Unknown',
}

/**
 * Unplugged → plugged in → charging → complete is a real sequence the driver
 * moves through, so it is drawn as one: four steps with the ones behind you
 * lit. A fault is not a point on that line, so it drops the track rather than
 * pretending to sit somewhere on it.
 */
const PHASES: ChargingStatus[] = ['disconnected', 'plugged-idle', 'charging', 'finished']

function formatRemaining(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) return null
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  return hours ? `${hours}h ${rest}m left` : `${rest}m left`
}

/*
 * The mode is only ever printed while a charge is actually running. The bridge
 * reports charging_mode: "No" on an unplugged car, and a template around it
 * produced the line "No charge", which reads as a fault rather than as a car
 * sitting on the drive.
 */
function detail(state: VehicleState): string {
  const remaining = formatRemaining(state.chargingRemainingMinutes)
  if (remaining) return remaining
  switch (state.charging) {
    case 'charging':
      return state.chargingMode ? `${state.chargingMode} charge` : 'Charging now'
    case 'plugged-idle':
      return 'Waiting to start'
    case 'finished':
      return 'Ready to go'
    case 'disconnected':
      return 'Not plugged in'
    case 'failure':
      return 'Check the cable and the charger'
    default:
      return 'Not reported'
  }
}

export function ChargeStateWidget({ state }: { state: VehicleState }) {
  const phase = PHASES.indexOf(state.charging)
  const fault = state.charging === 'failure'

  return (
    <Widget icon={<PlugIcon />} label="Charge state" className="widget-charge-state">
      <p className={`state-word ${fault ? 'is-warn' : ''}`}>{CHARGING_LABEL[state.charging]}</p>

      {phase >= 0 && (
        <div className="phase" role="img" aria-label={`Step ${phase + 1} of 4`}>
          {PHASES.map((id, index) => (
            <span
              key={id}
              className={`phase-step ${index <= phase ? 'is-reached' : ''} ${
                index === phase ? 'is-now' : ''
              }`}
            />
          ))}
        </div>
      )}

      <WidgetNote tone={fault ? 'warn' : undefined}>{detail(state)}</WidgetNote>
    </Widget>
  )
}

/* ---------- cabin ---------- */

export function CabinWidget({ celsius }: { celsius: number | null }) {
  const units = useUnits()
  const value = celsius === null ? null : units.temperature === 'F' ? celsius * 1.8 + 32 : celsius

  return (
    <Widget icon={<ThermometerIcon />} label="Cabin" shape="cookie">
      <WidgetValue
        value={value === null ? '—' : Math.round(value)}
        unit={value === null ? undefined : `°${units.temperature}`}
      />
    </Widget>
  )
}

/* ---------- odometer ---------- */

/*
 * Three readings on one tile, cycled by tapping it: the total on the dash, then
 * how far the car has gone this week and this month.
 *
 * The periods are calendar ones — Monday to Sunday, and the 1st to the end of
 * the month — not the trailing 30 days. A rolling window answers "how much
 * lately", which nobody asks; a calendar one answers "how am I doing against
 * the month", which is the question a mileage limit or a fuel budget is
 * actually posed in, and it is the only one where the same number means the
 * same thing when you look again tomorrow.
 *
 * Both are period-to-date: the week's figure covers Monday to now, the month's
 * the 1st to now.
 */
type OdometerView = 'total' | 'week' | 'month'

const NEXT_VIEW: Record<OdometerView, OdometerView> = {
  total: 'week',
  week: 'month',
  month: 'total',
}

export function OdometerWidget({ km }: { km: number | null }) {
  const units = useUnits()
  const [view, setView] = useState<OdometerView>('total')
  const [trips, setTrips] = useState<Trip[] | null>(null)
  const [failed, setFailed] = useState(false)

  /*
   * Fetched on the first tap that needs it, not on mount. Every trip in the
   * response carries its whole GPS track, so this is the largest read the app
   * makes — and the tile opens on the total, which the vehicle payload already
   * has. Nobody who never taps it should pay for it.
   */
  useEffect(() => {
    if (view === 'total' || trips !== null || failed) return
    let live = true
    fetchTrips()
      .then((loaded) => live && setTrips(loaded))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [view, trips, failed])

  const since =
    view === 'week' ? startOfWeek(new Date()) : view === 'month' ? startOfMonth(new Date()) : null

  const covered = trips === null || since === null ? null : distanceSince(trips, since)

  const pending = view !== 'total' && trips === null && !failed
  const [value, unit] = formatDistance(view === 'total' ? km : covered, units.distance).split(' ')

  const note =
    view === 'total'
      ? 'Total distance'
      : failed
        ? 'No trip history'
        : pending
          ? 'Reading trips…'
          : view === 'week'
            ? 'Since Monday'
            : `Since ${since?.toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })}`

  return (
    <Widget
      icon={<OdometerIcon />}
      label="Odometer"
      className="widget-odometer"
      action={{
        label: {
          total: 'Show distance covered this week',
          week: 'Show distance covered this month',
          month: 'Show total distance',
        }[view],
        onPress: () => {
          const next = NEXT_VIEW[view]
          // A full lap back to the total is also the retry: a trip read that
          // failed once should not leave the tile stuck on two dead views.
          if (next === 'total') setFailed(false)
          setView(next)
        },
      }}
    >
      <WidgetValue value={pending ? '…' : value} unit={pending ? undefined : unit} />
      <WidgetNote>{note}</WidgetNote>
    </Widget>
  )
}

/* ---------- 12V auxiliary ---------- */

/*
 * The range the dial covers. A resting 12V battery is ~12.4–12.7V, ~14.4V on
 * charge, and below 11.8V it will not crank — so the scale is drawn tight
 * around the band where the reading actually means something. On 0–15V every
 * plausible value would sit within the same few degrees of arc.
 */
const AUX_MIN = 11
const AUX_MAX = 14.5
const AUX_LOW = 12.0

const DIAL_R = 42
const DIAL_C = 2 * Math.PI * DIAL_R
/** 270°, opening at the bottom, the way every gauge in the car does. */
const DIAL_SWEEP = 0.75

/**
 * The only instrument on the dashboard: the tile's own edge is the dial, and
 * the arc is the whole point — a bare number here means nothing, because
 * two-thirds of a volt is the difference between a car that starts and one that
 * does not.
 */
export function AuxWidget({ volts }: { volts: number | null }) {
  if (!isPlausibleAuxVoltage(volts)) return null
  const value = volts as number
  const low = value < AUX_LOW
  const fraction = Math.min(1, Math.max(0, (value - AUX_MIN) / (AUX_MAX - AUX_MIN)))

  return (
    <Widget
      icon={<BatteryIcon />}
      label="12V"
      shape="circle"
      className={`widget-aux ${low ? 'is-warn' : ''}`}
    >
      <svg className="dial" viewBox="0 0 100 100" aria-hidden="true">
        <circle
          className="dial-track"
          cx="50"
          cy="50"
          r={DIAL_R}
          strokeDasharray={`${DIAL_C * DIAL_SWEEP} ${DIAL_C}`}
          transform="rotate(135 50 50)"
        />
        <circle
          className="dial-value"
          cx="50"
          cy="50"
          r={DIAL_R}
          strokeDasharray={`${DIAL_C * DIAL_SWEEP * fraction} ${DIAL_C}`}
          transform="rotate(135 50 50)"
        />
      </svg>
      <WidgetValue value={value.toFixed(1)} unit="V" />
      <WidgetNote tone={low ? 'warn' : undefined}>{low ? 'Low' : 'Healthy'}</WidgetNote>
    </Widget>
  )
}
