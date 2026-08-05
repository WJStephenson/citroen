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
