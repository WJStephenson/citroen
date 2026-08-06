import { useSyncExternalStore } from 'react'
import { fetchTrips } from '../api/client'
import type { Trip } from '../api/types'

/**
 * Completed trips, loaded once per session and shared by every tile that reads
 * them.
 *
 * Every trip in the response carries its whole GPS track, which makes this the
 * largest read the app makes — so it is deliberately not fetched on mount, and
 * a session where nobody asks for a trip figure never pays for it. But two
 * tiles now want the same data (the odometer's week and month totals, and
 * efficiency), and two components each holding their own copy would mean
 * fetching the largest payload in the app twice to answer two questions about
 * one set of drives.
 *
 * Hence a module-level store rather than component state: the first tile to
 * ask pays, and the second one is already holding the answer. It is a cache
 * for the life of the tab, which suits data whose newest row is a drive that
 * has already finished.
 */

let trips: Trip[] | null = null
let failed = false
let loading = false
let inFlight: Promise<void> | null = null

const listeners = new Set<() => void>()

export interface TripsFeed {
  /** Null until a load has succeeded — see `loading` and `failed` for which. */
  trips: Trip[] | null
  loading: boolean
  failed: boolean
  /** Idempotent: safe to call on every render of every tile that wants trips. */
  load: () => void
  /** Clears a previous failure and tries again. */
  retry: () => void
}

// useSyncExternalStore compares snapshots by identity, so the store hands out
// the same object until something in it actually changes.
let snapshot: TripsFeed = { trips, loading, failed, load, retry }

function publish(): void {
  snapshot = { trips, loading, failed, load, retry }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function load(): void {
  if (trips !== null || inFlight || failed) return
  loading = true
  publish()
  inFlight = fetchTrips()
    .then((loaded) => {
      trips = loaded
    })
    .catch(() => {
      failed = true
    })
    .finally(() => {
      loading = false
      inFlight = null
      publish()
    })
}

function retry(): void {
  if (inFlight) return
  failed = false
  publish()
  load()
}

export function useTrips(): TripsFeed {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => snapshot,
  )
}
