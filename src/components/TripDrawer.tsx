import type { CSSProperties } from 'react'
import type { Trip } from '../api/types'
import { useDialog } from '../hooks/useDialog'
import { useSheetDismiss } from '../hooks/useSheetDismiss'
import { useUnits } from '../hooks/useUnits'
import {
  formatAltitude,
  formatDistance,
  formatEfficiency,
  formatSpeed,
  formatTripDistance,
  formatTripDuration,
} from '../units'
import { TripMap } from './TripMap'

interface Props {
  trip: Trip | null
  onClose: () => void
}

function fullDateTime(date: Date | null): string {
  if (!date) return '—'
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function arrivalTime(start: Date | null, durationMinutes: number | null): string | null {
  if (!start || durationMinutes === null || durationMinutes <= 0) return null
  const end = new Date(start.getTime() + durationMinutes * 60_000)
  return end.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function TripDrawer({ trip, onClose }: Props) {
  const units = useUnits()
  const sheet = useSheetDismiss(onClose)
  useDialog(sheet.sheetRef, onClose)

  if (!trip) return null

  const efficiency =
    trip.energy !== null && trip.distance !== null
      ? formatEfficiency(trip.energy, trip.distance, units.distance)
      : null

  const arrival = arrivalTime(trip.startedAt, trip.durationMinutes)

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        ref={sheet.sheetRef}
        className={`sheet trip-drawer ${sheet.dragging ? 'is-dragging' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Trip details"
        tabIndex={-1}
        style={{ '--sheet-offset': `${sheet.offset}px` } as CSSProperties}
        onClick={(event) => event.stopPropagation()}
        {...sheet.handlers}
      >
        <div className="sheet-grip" role="presentation" />

        <div className="trip-drawer-header">
          <h2>Trip details</h2>
          <p className="trip-drawer-date">{fullDateTime(trip.startedAt)}</p>
          {arrival && (
            <p className="trip-drawer-arrival">
              Arrived ~{arrival} · {formatTripDuration(trip.durationMinutes)}
            </p>
          )}
        </div>

        <div className="trip-stats-grid">
          <div className="trip-stat-card">
            <span className="trip-stat-label">Distance</span>
            <span className="trip-stat-value">
              {formatTripDistance(trip.distance, units.distance)}
            </span>
          </div>

          <div className="trip-stat-card">
            <span className="trip-stat-label">Duration</span>
            <span className="trip-stat-value">
              {formatTripDuration(trip.durationMinutes)}
            </span>
          </div>

          <div className="trip-stat-card">
            <span className="trip-stat-label">Average Speed</span>
            <span className="trip-stat-value">
              {formatSpeed(trip.speedAverage, units.distance)}
            </span>
          </div>

          <div className="trip-stat-card">
            <span className="trip-stat-label">Energy Used</span>
            <span className="trip-stat-value">
              {trip.energy !== null ? `${trip.energy.toFixed(1)} kWh` : '—'}
            </span>
          </div>

          <div className="trip-stat-card">
            <span className="trip-stat-label">Efficiency</span>
            <span className="trip-stat-value">
              {efficiency ? `${efficiency.value} ${efficiency.unit}/${efficiency.per.replace('per ', '')}` : '—'}
            </span>
          </div>

          <div className="trip-stat-card">
            <span className="trip-stat-label">End Odometer</span>
            <span className="trip-stat-value">
              {formatDistance(trip.mileage, units.distance)}
            </span>
          </div>

          {trip.altitudeDiff !== null && (
            <div className="trip-stat-card">
              <span className="trip-stat-label">Elevation</span>
              <span className="trip-stat-value">
                {formatAltitude(trip.altitudeDiff, units.distance)}
              </span>
            </div>
          )}
        </div>

        <div className="trip-drawer-section">
          <h3>Route map</h3>
          <TripMap positions={trip.positions} />
        </div>

        <div className="sheet-actions">
          <button type="button" className="button is-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
