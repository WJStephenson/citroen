/**
 * The charging window as arithmetic, kept apart from the tile that draws it.
 *
 * A deferred start is two settings in the car, not one:
 *
 *   the hour  — `next_delayed_time`, which is what the infotainment screen
 *               shows and what `state.chargeStartHour` reads back
 *   the type  — IMMEDIATE_CHARGE or DELAYED_CHARGE, which decides whether that
 *               hour is honoured at all
 *
 * The bridge sends both in one message (`/charge_hour` sets the hour *as
 * delayed*; `/charge_now/{VIN}/{0|1}` re-sends the stored hour with the type
 * swapped), but it reports back only the first. So a car sitting on
 * IMMEDIATE_CHARGE with 23:00 still stored looks, in every field anything can
 * read, exactly like a car that will wait until 23:00 — and then charges the
 * moment it is plugged in at one in the afternoon.
 *
 * That gap is what observeChargeType below closes, as far as it can be closed
 * without a field to read.
 */

import type { ChargingStatus } from './api/types'

export const DAY = 1440

/** Which of the two the car is running on. Never reported; see observeChargeType. */
export type ChargeType = 'immediate' | 'delayed'

/**
 * How long a scheduled charge is assumed to be able to run, used only when no
 * stop hour is set and the window therefore has no end of its own.
 *
 * The e-C4 takes about seven and a half hours to fill from empty on a 7 kW
 * home charger, so a charge still running twelve hours after the start hour is
 * not the charge that start hour asked for. Generous on purpose: this bound
 * decides whether the app is willing to call the schedule broken, and it
 * should only do that when it is sure.
 */
export const ASSUMED_MAX_CHARGE = 12 * 60

export function minutesNow(now: Date = new Date()): number {
  return now.getHours() * 60 + now.getMinutes()
}

export function toMinutes(value: string | null): number | null {
  if (!value) return null
  const [h, m] = value.split(':').map(Number)
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return null
  return h * 60 + m
}

/**
 * How long the window lasts, measured forward from the start. Crossing
 * midnight is normal for an off-peak tariff, so it is wrapped rather than
 * flagged as an error. Null when either end is unset — a window with one end
 * has no length.
 */
export function windowSpan(startAt: number | null, stopAt: number | null): number | null {
  if (startAt === null || stopAt === null) return null
  return (stopAt - startAt + DAY) % DAY
}

/** Whether `now` falls inside the window. A window with no length is never open. */
export function isWindowOpen(startAt: number | null, span: number | null, now: number): boolean {
  if (startAt === null || span === null) return false
  return (now - startAt + DAY) % DAY < span
}

export function formatSpan(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (!h) return `${m}m`
  return m ? `${h}h ${m}m` : `${h}h`
}

/**
 * What can be *proved* about the charge type from what the bridge does report.
 *
 * A car that is charging outside its own window is not honouring its stored
 * hour — there is no other way to read it, and it is exactly the state a stray
 * "Charge now" leaves behind. That is worth saying out loud, because nothing
 * else on the car or in the app will: the hour stays on the dashboard, on the
 * infotainment screen, and in `next_delayed_time` throughout.
 *
 * Nothing here ever returns 'delayed'. An idle plugged-in car is *consistent*
 * with a schedule that is holding, but it is equally consistent with a charge
 * that finished, one the limit cut short, or one the bridge stopped at the
 * stop hour — so it proves nothing, and this returns null rather than guessing
 * in the reassuring direction. Saying "not reported" is the honest answer and
 * the tile is written to say it.
 *
 * Rapid charging is exempt. A DC charger starts the moment it handshakes,
 * schedule or no schedule — that is the point of one — so a Quick session
 * outside the window is not evidence of anything, and warning about it would
 * fire on every motorway stop.
 */
export function observeChargeType({
  charging,
  mode,
  startAt,
  span,
  now,
}: {
  charging: ChargingStatus
  mode: string | null
  startAt: number | null
  span: number | null
  now: number
}): ChargeType | null {
  if (startAt === null) return null
  if (charging !== 'charging') return null
  if (mode !== null && /quick|rapid|fast/i.test(mode)) return null
  // Where "now" sits in the day measured from the start hour: small means the
  // window has recently opened, and this could be the charge it asked for.
  const since = (now - startAt + DAY) % DAY
  return since < (span ?? ASSUMED_MAX_CHARGE) ? null : 'immediate'
}
