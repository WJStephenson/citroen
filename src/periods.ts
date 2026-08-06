/**
 * Calendar periods, for the odometer tile's week and month readings.
 *
 * Calendar rather than rolling: a trailing 30 days answers "how much lately",
 * which nobody asks, and gives a different number every day for the same
 * driving. A month that starts on the 1st is the unit a mileage limit, a
 * lease allowance or a fuel budget is actually written in.
 *
 * Everything here is local time. The boundaries have to line up with the days
 * as the person holding the phone experiences them — a week that turns over at
 * midnight UTC is the wrong week for an hour of every British summer evening.
 */

import type { Trip } from './api/types'

/** Local midnight on the Monday of the week containing `now`. */
export function startOfWeek(now: Date): Date {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  // getDay() counts from Sunday, so in a Monday-first week Sunday is six days
  // into the week rather than the day after it.
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  return start
}

/** Local midnight on the 1st of the month containing `now`. */
export function startOfMonth(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), 1)
}

/**
 * Total km covered by trips that started at or after `since`.
 *
 * By start time, not end: a drive is counted in the period it was begun in, so
 * one crossing midnight lands in a period rather than being split across two.
 * A trip the bridge sent without a distance contributes nothing rather than
 * discarding the rest of the sum.
 */
export function distanceSince(trips: Trip[], since: Date): number {
  return trips.reduce(
    (total, trip) =>
      trip.startedAt && trip.startedAt >= since ? total + (trip.distance ?? 0) : total,
    0,
  )
}

/** What was driven in a period, and what it took to drive it. */
export interface Usage {
  /** km */
  distance: number
  /** kWh */
  energy: number
  /** How many trips these totals were summed from. */
  trips: number
}

/**
 * Distance and energy over the trips started at or after `since` — the pair an
 * efficiency figure is worked out from.
 *
 * Only trips carrying *both* numbers are counted. A trip the bridge recorded
 * without a consumption figure would otherwise add its kilometres to the
 * denominator and nothing to the numerator, quietly reporting a car that ran
 * part of the week on air. Dropping it costs a little coverage and keeps the
 * ratio true, and `trips` is returned so a caller can say how thin the sample
 * is.
 */
export function usageSince(trips: Trip[], since: Date): Usage {
  return trips.reduce<Usage>(
    (total, trip) => {
      if (!trip.startedAt || trip.startedAt < since) return total
      if (trip.distance === null || trip.energy === null) return total
      if (trip.distance <= 0 || trip.energy < 0) return total
      return {
        distance: total.distance + trip.distance,
        energy: total.energy + trip.energy,
        trips: total.trips + 1,
      }
    },
    { distance: 0, energy: 0, trips: 0 },
  )
}
