/**
 * Where the car was standing when each charge began.
 *
 * `/vehicles/chargings` carries no position — `Charging.get_chargings()` has no
 * field for one — so this is not something that can be looked up after the
 * fact. If it is not written down at the moment the charge starts, that charge
 * has no place attached to it and never will.
 *
 * Two things watch for that moment and both write here: the server-side
 * watcher (deploy/charge_notify.py), which is running whether or not anyone
 * has the app open and catches the overnight charges nobody is awake for, and
 * hooks/useChargeLocationLog in the app itself, for the case where somebody is
 * standing at the car with the dashboard in front of them. Neither is
 * guaranteed to be there, which is why a session with no record is a normal
 * state the panel says out loud rather than an error.
 *
 * Kept in the shared settings blob alongside the tariff and the free sessions:
 * one car, one history of where it charged, not one per phone.
 */

import { SHARED_SETTINGS_CHANGED, getSharedSettings, patchSharedSettings } from './api/sharedSettings'
import type { ChargingSession } from './api/types'

export const CHARGE_LOCATIONS_CHANGED = SHARED_SETTINGS_CHANGED

/** Where the car was at `at`, while it was charging. */
export interface ChargeLocation {
  /** When the observation was made, in milliseconds — the *observer's* clock. */
  at: number
  lat: number
  lon: number
}

/**
 * Stored to five decimal places, which is about a metre. Anything finer is
 * noise from a parked car's GPS, and this list is carried in a settings blob
 * every device fetches on every boot.
 */
const COORD_DP = 5
/**
 * Roughly 33m. Two recordings this close together, in time and in space, are
 * the same charge seen twice — the watcher and an open app both notice the
 * same start, and there is no shared id to tell those apart with.
 */
const SAME_PLACE_DEGREES = 0.0003
const DEDUPE_MS = 45 * 60_000
/** Well over a year of daily charging; the oldest are dropped first. */
const MAX_RECORDS = 300

/**
 * How far either side of a session a recording may fall and still belong to
 * it.
 *
 * The window is generous because neither recorder shares a clock with the
 * bridge that stamped `start_at`, and because a recorder only sees the start
 * on its own next poll — up to five minutes late for either of them. It can
 * afford to be: a charging car is a parked car, so any position seen while a
 * session was running is where that session happened, and the *nearest*
 * recording wins when two sessions' windows overlap.
 */
const MATCH_BEFORE_MS = 30 * 60_000
const MATCH_AFTER_MS = 30 * 60_000
/** Stand-in span for a session whose duration the bridge never recorded. */
const ASSUMED_SPAN_MS = 60 * 60_000

// Same two-tier cache as freeSessions.ts, for the same reason: a
// useSyncExternalStore snapshot must return the *same* array until the value
// genuinely changes, so the raw (unparsed) field is the cache key.
let cachedRaw: unknown
let cache: ChargeLocation[] = []

const numeric = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

function parse(raw: unknown): ChargeLocation[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((entry): entry is ChargeLocation => {
      if (!entry || typeof entry !== 'object') return false
      const { at, lat, lon } = entry as Record<string, unknown>
      return numeric(at) && numeric(lat) && numeric(lon)
    })
    .map(({ at, lat, lon }) => ({ at, lat, lon }))
    .sort((a, b) => a.at - b.at)
}

export function getChargeLocations(): ChargeLocation[] {
  const raw = getSharedSettings().chargeLocations
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cache = parse(raw)
  }
  return cache
}

const round = (value: number) => Number(value.toFixed(COORD_DP))

/**
 * Writes down where the car is, as the charge it has just started.
 *
 * Silently does nothing when the same place has already been recorded in the
 * last three quarters of an hour — see SAME_PLACE_DEGREES. That covers the
 * watcher and a phone both catching the same start, without suppressing a
 * genuinely different charge somewhere else half an hour later, which is a
 * drive away and so cannot be within a stone's throw of the last one.
 */
export function recordChargeLocation(
  place: { lat: number; lon: number },
  at: number = Date.now(),
): void {
  if (!numeric(place.lat) || !numeric(place.lon) || !numeric(at)) return
  const lat = round(place.lat)
  const lon = round(place.lon)
  const current = getChargeLocations()
  const duplicate = current.some(
    (record) =>
      Math.abs(record.at - at) <= DEDUPE_MS &&
      Math.abs(record.lat - lat) <= SAME_PLACE_DEGREES &&
      Math.abs(record.lon - lon) <= SAME_PLACE_DEGREES,
  )
  if (duplicate) return
  const next = [...current, { at, lat, lon }]
    .sort((a, b) => a.at - b.at)
    .slice(-MAX_RECORDS)
  void patchSharedSettings({ chargeLocations: next })
}

/**
 * The recording that belongs to `session`, if one was ever made.
 *
 * A session has no id from the bridge and nothing either recorder writes can
 * be keyed to one, so this is decided by time: a recording made between the
 * session starting and it finishing is, by the fact that a charging car cannot
 * drive away, a recording of where that session happened. The window is padded
 * at both ends for the clock the bridge stamped `start_at` with and the poll
 * that noticed the start a few minutes after it, and where two windows overlap
 * — back-to-back sessions — the recording nearest the start wins, which is
 * each session's own.
 */
export function locationForSession(
  session: Pick<ChargingSession, 'startedAt' | 'durationMinutes'>,
  records: ChargeLocation[],
): ChargeLocation | null {
  const startedAt = session.startedAt?.getTime()
  if (startedAt === undefined) return null
  const span =
    session.durationMinutes !== null && session.durationMinutes > 0
      ? session.durationMinutes * 60_000
      : ASSUMED_SPAN_MS
  const from = startedAt - MATCH_BEFORE_MS
  const to = startedAt + span + MATCH_AFTER_MS

  let best: ChargeLocation | null = null
  for (const record of records) {
    if (record.at < from || record.at > to) continue
    if (best === null || Math.abs(record.at - startedAt) < Math.abs(best.at - startedAt)) {
      best = record
    }
  }
  return best
}
