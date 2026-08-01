import type { VehicleState } from '../api/types'
import { useUnits } from '../hooks/useUnits'
import { formatDistance, formatTemperature, isPlausibleAuxVoltage } from '../units'

const CHARGING_LABEL: Record<VehicleState['charging'], string> = {
  charging: 'Charging',
  'plugged-idle': 'Plugged in, idle',
  finished: 'Charge complete',
  disconnected: 'Unplugged',
  failure: 'Charge fault',
  unknown: 'Unknown',
}

function formatDuration(minutes: number | null): string | null {
  if (minutes === null || minutes <= 0) return null
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return h ? `${h}h ${m}m left` : `${m}m left`
}

export function StatusStrip({ state }: { state: VehicleState }) {
  const units = useUnits()
  const remaining = formatDuration(state.chargingRemainingMinutes)

  /*
   * The tile only appears when the reading could actually be a 12V battery —
   * see isPlausibleAuxVoltage. A number that never changes, driving a
   * low-voltage warning that can never fire, is worse than showing nothing:
   * it looks like reassurance.
   */
  const plausibleAux = isPlausibleAuxVoltage(state.auxVoltage)

  // Below ~12.0V the 12V auxiliary battery is heading for a no-start, which is
  // the failure mode the doc's polling limits exist to avoid.
  const auxLow = plausibleAux && (state.auxVoltage as number) < 12.0

  const items: { label: string; value: string; tone?: 'warn' }[] = [
    {
      label: 'Charge',
      value: remaining ? `${CHARGING_LABEL[state.charging]} · ${remaining}` : CHARGING_LABEL[state.charging],
    },
    { label: 'Cabin', value: formatTemperature(state.cabinTemp, units.temperature) },
    { label: 'Odometer', value: formatDistance(state.odometer, units.distance) },
  ]

  if (plausibleAux) {
    items.push({
      label: '12V aux',
      value: `${(state.auxVoltage as number).toFixed(1)}V`,
      ...(auxLow ? { tone: 'warn' as const } : {}),
    })
  }

  return (
    <dl className="status-strip">
      {items.map((item) => (
        <div key={item.label} className={`status-item ${item.tone === 'warn' ? 'is-warn' : ''}`}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  )
}
