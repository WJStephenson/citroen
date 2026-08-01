import type { CSSProperties } from 'react'
import type { ChargingStatus } from '../api/types'
import { useUnits } from '../hooks/useUnits'
import { formatDistance } from '../units'

/** Minimum visual width so a near-empty bar still reads as a rounded pill, not a sliver. */
const MIN_WIDTH_PX = 16

interface Props {
  level: number | null
  range: number | null
  charging: ChargingStatus
  stale: boolean
}

/** Meter contract: fill carries severity; the track is a dim wash of the same hue. */
function levelColour(level: number | null): string {
  if (level === null) return 'var(--muted)'
  if (level <= 10) return 'var(--danger)'
  if (level <= 25) return 'var(--warn)'
  return 'var(--accent)'
}

export function BatteryBar({ level, range, charging, stale }: Props) {
  const units = useUnits()
  const fraction = level === null ? 0 : Math.min(100, Math.max(0, level)) / 100
  const colour = levelColour(level)

  return (
    <div
      className={`battery-bar ${stale ? 'is-stale' : ''}`}
      style={{ '--meter-color': colour } as CSSProperties}
    >
      <div className="battery-bar-header">
        <div className="battery-bar-value">
          {charging === 'charging' && (
            <span className="battery-bar-bolt" aria-hidden="true">
              ⚡
            </span>
          )}
          {level === null ? '—' : Math.round(level)}
          <span className="battery-bar-unit">%</span>
        </div>
        <div className="battery-bar-range">
          {range === null ? 'Range unknown' : formatDistance(range, units.distance)}
        </div>
      </div>

      <div
        className="battery-bar-track"
        role="img"
        aria-label={`Battery ${level ?? 'unknown'} percent`}
      >
        <div
          className="battery-bar-fill"
          style={{ width: `max(${MIN_WIDTH_PX}px, ${fraction * 100}%)` }}
        />
      </div>
    </div>
  )
}
