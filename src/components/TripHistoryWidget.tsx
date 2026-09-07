import { useEffect, useMemo, useState } from 'react'
import type { Trip } from '../api/types'
import { useTrips } from '../hooks/useTrips'
import { useUnits } from '../hooks/useUnits'
import { startOfMonth, startOfWeek } from '../periods'
import {
  formatDistance,
  formatEfficiency,
  formatSpeed,
  formatTripDistance,
  formatTripDuration,
} from '../units'
import { ChevronRightIcon, RouteIcon } from './Icons'
import { TripDrawer } from './TripDrawer'
import { Widget, WidgetNote } from './Widget'

type PeriodFilter = 'all' | 'month' | 'week'
type DistanceFilter = 'all' | 'drive' | 'long'

const INITIAL_PAGE_SIZE = 10
const PAGE_SIZE_STEP = 15

function isToday(date: Date): boolean {
  const now = new Date()
  return (
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear()
  )
}

function isYesterday(date: Date): boolean {
  const yesterday = new Date()
  yesterday.setDate(yesterday.getDate() - 1)
  return (
    date.getDate() === yesterday.getDate() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getFullYear() === yesterday.getFullYear()
  )
}

function formatTripDate(date: Date | null): string {
  if (!date) return '—'
  const time = date.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
  if (isToday(date)) return `Today · ${time}`
  if (isYesterday(date)) return `Yesterday · ${time}`

  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  const formattedDate = date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
  return `${formattedDate} · ${time}`
}

export function TripHistoryWidget() {
  const units = useUnits()
  const { trips, loading, failed, load, retry } = useTrips()

  const [period, setPeriod] = useState<PeriodFilter>('all')
  const [distanceMin, setDistanceMin] = useState<DistanceFilter>('all')
  const [visibleCount, setVisibleCount] = useState(INITIAL_PAGE_SIZE)
  const [selectedTrip, setSelectedTrip] = useState<Trip | null>(null)

  // Load trips automatically when widget mounts
  useEffect(() => {
    if (trips === null && !failed && !loading) {
      load()
    }
  }, [trips, failed, loading, load])

  // Filter and sort trips (newest first)
  const filteredTrips = useMemo(() => {
    if (!trips) return []

    const now = new Date()
    const weekStart = startOfWeek(now)
    const monthStart = startOfMonth(now)

    return [...trips]
      .reverse() // Trips come sorted oldest first; reverse to show newest first
      .filter((trip) => {
        if (!trip.startedAt) return false

        // Period filter
        if (period === 'week' && trip.startedAt < weekStart) return false
        if (period === 'month' && trip.startedAt < monthStart) return false

        // Distance filter
        const km = trip.distance ?? 0
        if (distanceMin === 'drive' && km < 1.0) return false
        if (distanceMin === 'long' && km < 10.0) return false

        return true
      })
  }, [trips, period, distanceMin])

  // Summary statistics for the filtered trips
  const summary = useMemo(() => {
    let totalKm = 0
    let totalEnergy = 0
    let energyCount = 0

    for (const trip of filteredTrips) {
      if (trip.distance !== null && trip.distance > 0) {
        totalKm += trip.distance
      }
      if (trip.energy !== null && trip.energy > 0) {
        totalEnergy += trip.energy
        energyCount++
      }
    }

    const efficiency =
      totalKm > 0 && totalEnergy > 0 ? formatEfficiency(totalEnergy, totalKm, units.distance) : null

    return {
      count: filteredTrips.length,
      totalKm,
      totalEnergy,
      efficiency,
    }
  }, [filteredTrips, units.distance])

  const visibleTrips = useMemo(() => {
    return filteredTrips.slice(0, visibleCount)
  }, [filteredTrips, visibleCount])

  const hasMore = visibleCount < filteredTrips.length

  return (
    <>
      <Widget
        icon={<RouteIcon />}
        label="Trip history"
        className="widget-trip-history"
      >
        {/* Filter Controls */}
        <div className="trip-filters-bar">
          <div className="trip-filter-group" role="group" aria-label="Time period">
            <button
              type="button"
              className={`segment ${period === 'all' ? 'is-selected' : ''}`}
              aria-pressed={period === 'all'}
              onClick={() => {
                setPeriod('all')
                setVisibleCount(INITIAL_PAGE_SIZE)
              }}
            >
              All
            </button>
            <button
              type="button"
              className={`segment ${period === 'month' ? 'is-selected' : ''}`}
              aria-pressed={period === 'month'}
              onClick={() => {
                setPeriod('month')
                setVisibleCount(INITIAL_PAGE_SIZE)
              }}
            >
              Month
            </button>
            <button
              type="button"
              className={`segment ${period === 'week' ? 'is-selected' : ''}`}
              aria-pressed={period === 'week'}
              onClick={() => {
                setPeriod('week')
                setVisibleCount(INITIAL_PAGE_SIZE)
              }}
            >
              Week
            </button>
          </div>

          <div className="trip-filter-group" role="group" aria-label="Distance filter">
            <button
              type="button"
              className={`segment ${distanceMin === 'all' ? 'is-selected' : ''}`}
              aria-pressed={distanceMin === 'all'}
              onClick={() => {
                setDistanceMin('all')
                setVisibleCount(INITIAL_PAGE_SIZE)
              }}
            >
              All dist
            </button>
            <button
              type="button"
              className={`segment ${distanceMin === 'drive' ? 'is-selected' : ''}`}
              aria-pressed={distanceMin === 'drive'}
              title="Hide short moves under 1 km / 0.6 mi"
              onClick={() => {
                setDistanceMin('drive')
                setVisibleCount(INITIAL_PAGE_SIZE)
              }}
            >
              &gt; 1 km
            </button>
            <button
              type="button"
              className={`segment ${distanceMin === 'long' ? 'is-selected' : ''}`}
              aria-pressed={distanceMin === 'long'}
              title="Longer journeys over 10 km / 6 mi"
              onClick={() => {
                setDistanceMin('long')
                setVisibleCount(INITIAL_PAGE_SIZE)
              }}
            >
              &gt; 10 km
            </button>
          </div>
        </div>

        {/* State Banners: Loading, Failed, or Empty */}
        {loading && trips === null && (
          <div className="trip-list-message">
            <p>Reading trips from the bridge…</p>
          </div>
        )}

        {failed && trips === null && (
          <div className="trip-list-message is-error">
            <p>Could not load trip history</p>
            <button type="button" className="button is-small" onClick={retry}>
              Retry
            </button>
          </div>
        )}

        {trips !== null && filteredTrips.length === 0 && (
          <div className="trip-list-message">
            <p>No trips match the selected filters</p>
          </div>
        )}

        {/* Filter Summary Strip */}
        {trips !== null && filteredTrips.length > 0 && (
          <div className="trip-summary-strip">
            <div className="trip-summary-item">
              <span className="trip-summary-val">{summary.count}</span>
              <span className="trip-summary-lbl">{summary.count === 1 ? 'trip' : 'trips'}</span>
            </div>
            <div className="trip-summary-sep" />
            <div className="trip-summary-item">
              <span className="trip-summary-val">
                {formatDistance(summary.totalKm, units.distance)}
              </span>
              <span className="trip-summary-lbl">total distance</span>
            </div>
            {summary.efficiency && (
              <>
                <div className="trip-summary-sep" />
                <div className="trip-summary-item">
                  <span className="trip-summary-val">
                    {summary.efficiency.value} {summary.efficiency.unit}
                  </span>
                  <span className="trip-summary-lbl">{summary.efficiency.per}</span>
                </div>
              </>
            )}
          </div>
        )}

        {/* Trip List */}
        {visibleTrips.length > 0 && (
          <div className="trip-list" role="list">
            {visibleTrips.map((trip) => {
              const tripKey = trip.id ?? trip.startedAt?.getTime() ?? Math.random()
              const eff =
                trip.energy !== null && trip.distance !== null
                  ? formatEfficiency(trip.energy, trip.distance, units.distance)
                  : null

              return (
                <button
                  key={tripKey}
                  type="button"
                  className="trip-row"
                  onClick={() => setSelectedTrip(trip)}
                  aria-label={`Trip on ${formatTripDate(trip.startedAt)}, ${formatTripDistance(trip.distance, units.distance)}`}
                >
                  <div className="trip-row-main">
                    <div className="trip-row-primary">
                      <span className="trip-row-date">{formatTripDate(trip.startedAt)}</span>
                      <span className="trip-row-distance">
                        {formatTripDistance(trip.distance, units.distance)}
                      </span>
                    </div>

                    <div className="trip-row-secondary">
                      <span className="trip-row-meta">
                        {formatTripDuration(trip.durationMinutes)}
                        {trip.speedAverage !== null && trip.speedAverage > 0 && (
                          <> · avg {formatSpeed(trip.speedAverage, units.distance)}</>
                        )}
                      </span>
                      {eff ? (
                        <span className="trip-row-eff">
                          {eff.value} {eff.unit}/{eff.per.replace('per ', '')}
                        </span>
                      ) : trip.energy !== null ? (
                        <span className="trip-row-eff">{trip.energy.toFixed(1)} kWh</span>
                      ) : null}
                    </div>
                  </div>

                  <span className="trip-row-arrow" aria-hidden="true">
                    <ChevronRightIcon />
                  </span>
                </button>
              )
            })}
          </div>
        )}

        {/* Show More Button */}
        {hasMore && (
          <div className="trip-list-actions">
            <button
              type="button"
              className="button is-small is-ghost"
              onClick={() => setVisibleCount((prev) => prev + PAGE_SIZE_STEP)}
            >
              Show more ({filteredTrips.length - visibleCount} remaining)
            </button>
          </div>
        )}

        <WidgetNote>
          {trips ? `${trips.length} drives recorded by vehicle telemetry` : undefined}
        </WidgetNote>
      </Widget>

      {/* Detail Bottom Sheet Drawer */}
      {selectedTrip && (
        <TripDrawer
          trip={selectedTrip}
          onClose={() => setSelectedTrip(null)}
        />
      )}
    </>
  )
}
