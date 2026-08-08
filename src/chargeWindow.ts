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
 * What the charge type can be read as, from what the bridge does report.
 *
 * Both answers come from the same question — is the car doing what its stored
 * hour says? — asked of a car that is outside its own window, where the two
 * types behave differently and the difference is therefore visible:
 *
 *   charging there     -> 'immediate'. It is not honouring the hour; there is
 *                         no other way to read it, and it is exactly what a
 *                         stray "Charge now" leaves behind.
 *   plugged, waiting   -> 'delayed'. It is holding for the hour. A car on
 *                         IMMEDIATE_CHARGE would have started when it was
 *                         plugged in.
 *
 * Neither is a field anybody reports, and the second is the weaker of the two:
 * a charger doing its own scheduling at the wall (an Ohme, a Zappi) leaves a
 * genuinely-immediate car sitting exactly like a well-behaved one. Which is
 * why the tile shows the *evidence* alongside the answer ("plugged in and
 * waiting for 23:00") rather than asserting a setting it cannot see. An
 * inference the reader can check beats both a bare claim and a shrug.
 *
 * The narrower readings that say nothing about the type are excluded rather
 * than guessed at:
 *
 *   - Inside the window, both types charge, so neither behaviour separates
 *     them.
 *   - A car at or above its limit has a reason to be idle that has nothing to
 *     do with the hour.
 *   - Rapid charging starts on handshake whatever the schedule says — that is
 *     the point of it — so a Quick session outside the window is not evidence,
 *     and warning about it would fire on every motorway stop.
 *   - No stored hour at all: nothing to honour, nothing to conclude.
 */
export function observeChargeType({
  charging,
  mode,
  startAt,
  span,
  now,
  battery,
  limit,
}: {
  charging: ChargingStatus
  mode: string | null
  startAt: number | null
  span: number | null
  now: number
  battery: number | null
  limit: number | null
}): ChargeType | null {
  if (startAt === null) return null

  // Where "now" sits in the day measured from the start hour: small means the
  // window has recently opened, and a charge running could be the one it asked
  // for. Beyond the window's own length — or, unbounded, beyond what a charge
  // could plausibly still be — the car is outside it and the two types part.
  const since = (now - startAt + DAY) % DAY
  if (since < (span ?? ASSUMED_MAX_CHARGE)) return null

  if (charging === 'charging') {
    return mode !== null && /quick|rapid|fast/i.test(mode) ? null : 'immediate'
  }
  if (charging === 'plugged-idle') {
    if (battery === null) return null
    return battery < (limit ?? 100) ? 'delayed' : null
  }
  return null
}
