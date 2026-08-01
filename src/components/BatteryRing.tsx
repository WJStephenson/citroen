import type { ChargingStatus } from '../api/types'
import { useUnits } from '../hooks/useUnits'
import { formatDistance } from '../units'

const RADIUS = 86
const STROKE = 12
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
/** The ring is a 280° arc with a gap at the bottom, like the car's cluster. */
const SWEEP = 280 / 360

interface Props {
  level: number | null
  range: number | null
  charging: ChargingStatus
  stale: boolean
}

function levelColour(level: number | null): string {
  if (level === null) return 'var(--muted)'
  if (level <= 10) return 'var(--danger)'
  if (level <= 25) return 'var(--warn)'
  return 'var(--accent)'
}

export function BatteryRing({ level, range, charging, stale }: Props) {
  const units = useUnits()
  const fraction = level === null ? 0 : Math.min(100, Math.max(0, level)) / 100
  const track = CIRCUMFERENCE * SWEEP
  const filled = track * fraction

  return (
    <div className={`ring ${stale ? 'is-stale' : ''}`}>
      <svg viewBox="0 0 200 200" role="img" aria-label={`Battery ${level ?? 'unknown'} percent`}>
        <g transform="rotate(130 100 100)">
          <circle
            cx="100"
            cy="100"
            r={RADIUS}
            fill="none"
            stroke="var(--track)"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${track} ${CIRCUMFERENCE}`}
          />
          <circle
            className="ring-fill"
            cx="100"
            cy="100"
            r={RADIUS}
            fill="none"
            stroke={levelColour(level)}
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${CIRCUMFERENCE}`}
          />
        </g>
      </svg>

      <div className="ring-readout">
        {charging === 'charging' && (
          <span className="ring-bolt" aria-hidden="true">
            ⚡
          </span>
        )}
        <div className="ring-level">
          {level === null ? '—' : Math.round(level)}
          <span className="ring-unit">%</span>
        </div>
        <div className="ring-range">
          {range === null ? 'Range unknown' : formatDistance(range, units.distance)}
        </div>
      </div>
    </div>
  )
}
