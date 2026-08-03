/**
 * Electricity tariff, and what a charging session cost on it.
 *
 * The bridge reports a `price` per session, but it computes that from the
 * single flat rate configured in psa_car_controller — which is wrong for
 * anything time-of-use. An EV tariff is the whole reason the charging window
 * exists: the point of starting at 00:30 is that the electricity is a quarter
 * of the price, and a cost worked out at the day rate hides exactly the saving
 * the schedule was set up to make.
 *
 * So cost is computed here instead, from the session's own clock span, and the
 * bridge's figure is used only when no tariff has been entered.
 *
 * There is one electricity contract for the car, not one per phone, so the
 * tariff itself is shared across every device (see api/sharedSettings.ts)
 * rather than stored per-browser.
 */

import { SHARED_SETTINGS_CHANGED, getSharedSettings, patchSharedSettings } from './api/sharedSettings'

export interface Tariff {
  /** Off until rates are entered — an unconfigured tariff must not silently
      re-price every session at 0p. */
  enabled: boolean
  /** Pence per kWh. Pence rather than pounds because that is how tariffs are
      quoted, and entering 28.62 is less error-prone than 0.2862. */
  dayRate: number
  nightRate: number
  /** "HH:MM". The cheap window — may cross midnight, and usually does. */
  nightStart: string
  nightEnd: string
}

const DAY = 1440

/** Fired on change so open views re-render without a reload — including a
    change that just arrived from another device. */
export const TARIFF_CHANGED = SHARED_SETTINGS_CHANGED

/*
 * Economy 7 as it is most commonly metered, which is also what the charging
 * window's own defaults (00:30–07:00) are set up for. Rates are left at 0 and
 * `enabled` at false: a plausible-looking default rate would be quietly wrong
 * for everyone, and wrong money is worse than no money.
 */
const DEFAULTS: Tariff = {
  enabled: false,
  dayRate: 0,
  nightRate: 0,
  nightStart: '00:30',
  nightEnd: '07:30',
}

// Same contract as getUnits: a useSyncExternalStore snapshot must return the
// *same* object until the value genuinely changes, so the raw (already
// parsed) field is the cache key — a fetch that lands the same tariff another
// device already had must not force every subscriber to re-render.
let cachedRaw: unknown
let cache: Tariff = DEFAULTS

const isTime = (value: unknown): value is string =>
  typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)

const rate = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0

function parse(raw: unknown): Tariff {
  const stored = (raw && typeof raw === 'object' ? raw : {}) as Partial<Tariff>
  return {
    enabled: stored.enabled === true,
    dayRate: rate(stored.dayRate),
    nightRate: rate(stored.nightRate),
    nightStart: isTime(stored.nightStart) ? stored.nightStart : DEFAULTS.nightStart,
    nightEnd: isTime(stored.nightEnd) ? stored.nightEnd : DEFAULTS.nightEnd,
  }
}

export function getTariff(): Tariff {
  const raw = getSharedSettings().tariff
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cache = parse(raw)
  }
  return cache
}

export function setTariff(next: Partial<Tariff>): Tariff {
  const merged = { ...getTariff(), ...next }
  patchSharedSettings({ tariff: merged })
  return merged
}

/** Minutes past midnight, or null if the string is not a time. */
function toMinutes(value: string): number | null {
  if (!isTime(value)) return null
  const [h, m] = value.split(':').map(Number)
  return (h as number) * 60 + (m as number)
}

/**
 * How many of the `length` minutes starting at `from` fall inside the night
 * window.
 *
 * Walked as a set of day-length blocks rather than by comparing timestamps: a
 * charge can start at 22:00 and run past two separate night windows, and the
 * window itself usually wraps midnight, so any "is start < end" arithmetic gets
 * one of those two cases wrong. Counting whole days and then the remainder is
 * the version that has no special cases in it.
 */
export function nightMinutes(from: number, length: number, tariff: Tariff): number {
  const start = toMinutes(tariff.nightStart)
  const end = toMinutes(tariff.nightEnd)
  if (start === null || end === null || start === end) return 0

  // Length of the cheap window, measured forward from its start so a window
  // crossing midnight is the ordinary case rather than the exception.
  const windowLength = (end - start + DAY) % DAY

  const wholeDays = Math.floor(length / DAY)
  let counted = wholeDays * windowLength

  // The remainder, minute-blocked against the window's position in the day.
  let cursor = ((from % DAY) + DAY) % DAY
  let left = length - wholeDays * DAY
  while (left > 0) {
    const intoWindow = (cursor - start + DAY) % DAY
    if (intoWindow < windowLength) {
      // Inside the cheap window; take the rest of it, or what is left.
      const run = Math.min(left, windowLength - intoWindow)
      counted += run
      cursor = (cursor + run) % DAY
      left -= run
    } else {
      // Outside it; skip to when it next opens.
      const untilWindow = (start - cursor + DAY) % DAY
      const run = Math.min(left, untilWindow)
      cursor = (cursor + run) % DAY
      left -= run
    }
  }

  return counted
}

export interface SessionCost {
  /** Pounds. */
  total: number
  /** Of the energy added, how much was billed at the night rate. */
  nightKwh: number
  dayKwh: number
}

/**
 * What a session cost, splitting its energy across the two rates in proportion
 * to the minutes it spent in each.
 *
 * The split is pro rata by time, which assumes the car drew power at a steady
 * rate throughout. It does not: charging tapers as the battery fills, so a
 * session that crosses out of the cheap window in its final hour is charged
 * slightly more day-rate energy here than it really used. The bridge records
 * the power curve that would fix this but exposes no route to it (see the
 * README), and the error is small next to the difference between the two rates
 * — which is the thing this exists to show.
 */
export function costOf(
  session: { startedAt: Date | null; durationMinutes: number | null; energy: number | null },
  tariff: Tariff,
): SessionCost | null {
  if (!tariff.enabled) return null
  const { energy, durationMinutes, startedAt } = session
  if (energy === null || energy <= 0) return null

  // Without a clock span there is nothing to split on, so the whole charge is
  // priced at the day rate rather than guessed at.
  if (startedAt === null || durationMinutes === null || durationMinutes <= 0) {
    return { total: (energy * tariff.dayRate) / 100, nightKwh: 0, dayKwh: energy }
  }

  const from = startedAt.getHours() * 60 + startedAt.getMinutes()
  const night = nightMinutes(from, durationMinutes, tariff)
  const nightKwh = energy * (night / durationMinutes)
  const dayKwh = energy - nightKwh

  return {
    total: (nightKwh * tariff.nightRate + dayKwh * tariff.dayRate) / 100,
    nightKwh,
    dayKwh,
  }
}

/** "£4.20". Money is always two decimals, however small. */
export function formatMoney(pounds: number): string {
  return `£${pounds.toFixed(2)}`
}
