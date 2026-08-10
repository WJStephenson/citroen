/**
 * Sessions marked "free" — charged at no cost, e.g. a workplace charger
 * rather than the home tariff. Kept in the shared settings blob alongside the
 * tariff: one car, one set of free sessions, not one per phone (see
 * api/sharedSettings.ts).
 *
 * A session has no id from the bridge, so it is keyed by its start time in
 * milliseconds — the one field normaliseSession always derives the same way
 * from the same source row.
 */

import { SHARED_SETTINGS_CHANGED, getSharedSettings, patchSharedSettings } from './api/sharedSettings'

export const FREE_SESSIONS_CHANGED = SHARED_SETTINGS_CHANGED

// Same two-tier cache as tariff.ts: a useSyncExternalStore snapshot must
// return the *same* array until the value genuinely changes, so the raw
// (unparsed) field is the cache key.
let cachedRaw: unknown
let cache: number[] = []

function parse(raw: unknown): number[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
}

export function getFreeSessions(): number[] {
  const raw = getSharedSettings().freeSessions
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cache = parse(raw)
  }
  return cache
}

export function setFreeSession(startedAt: Date, free: boolean): void {
  const key = startedAt.getTime()
  const current = getFreeSessions()
  if (free === current.includes(key)) return
  const next = free ? [...current, key] : current.filter((t) => t !== key)
  patchSharedSettings({ freeSessions: next })
}
