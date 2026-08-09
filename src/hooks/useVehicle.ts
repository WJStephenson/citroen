import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchVehicleState } from '../api/client'
import { SHARED_SETTINGS_CHANGED } from '../api/sharedSettings'
import { loadSnapshot, saveSnapshot } from '../api/snapshot'
import { ApiError, type VehicleState } from '../api/types'
import { getPollMinutes, getVin } from '../config'

export interface VehicleFeed {
  state: VehicleState | null
  error: ApiError | null
  /** True only for the initial load, so refreshes don't blank the screen. */
  loading: boolean
  refreshing: boolean
  /**
   * When *we* last successfully read. Says the app is working, not that the
   * car has said anything lately — for that, see `state.reportedAt`, which is
   * what the dashboard shows.
   */
  fetchedAt: Date | null
  refresh: () => Promise<void>
  /** Locally applied expectation, reconciled on the next successful poll. */
  patch: (changes: Partial<VehicleState>) => void
}

/**
 * Owns vehicle telemetry.
 *
 * Every poll here is a read of Stellantis's status record and never reaches
 * the car (see api/client.ts::fetchVehicleState). Polling was slowed to 20+
 * minutes to protect the 12V battery from a cost reads do not have, and the
 * effect was the opposite of the intent: the app sat on an old reading for
 * twenty minutes at a time and made people press the one button they had been
 * told wakes the car. The interval is now about not leaning on someone else's
 * API — see config.MIN_POLL_MINUTES.
 *
 * The timer is still suspended whenever the app is not visible: nobody is
 * reading a backgrounded dashboard, and the charge-finished notification comes
 * from the server-side watcher (deploy/charge_notify.py) rather than from here.
 *
 * The feed opens on the last stored reading rather than on nothing (see
 * api/snapshot.ts), so the dashboard is answerable the instant it is launched
 * and stays answerable with no connection at all.
 */
export function useVehicle(enabled: boolean): VehicleFeed {
  // Read once, at construction: a snapshot that lands mid-session would be
  // older than whatever is already on screen.
  const [cached] = useState(() => loadSnapshot(getVin()))
  const [state, setState] = useState<VehicleState | null>(cached?.state ?? null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(cached === null)
  const [refreshing, setRefreshing] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(cached?.fetchedAt ?? null)

  // Guards against two overlapping polls (the ⟳ button + the timer firing
  // together).
  const inFlight = useRef<Promise<void> | null>(null)
  const fetchedAtRef = useRef<Date | null>(cached?.fetchedAt ?? null)
  const errorRef = useRef<ApiError | null>(null)

  const refresh = useCallback<VehicleFeed['refresh']>(async () => {
    if (inFlight.current) return inFlight.current

    const run = (async () => {
      setRefreshing(true)
      try {
        const next = await fetchVehicleState()
        setState(next)
        errorRef.current = null
        setError(null)
        const now = new Date()
        fetchedAtRef.current = now
        setFetchedAt(now)
        // Only a reading is stored, never a `patch`ed expectation.
        saveSnapshot(next, now)
      } catch (caught) {
        const apiError =
          caught instanceof ApiError
            ? caught
            : new ApiError('Something went wrong talking to the bridge.')
        errorRef.current = apiError
        setError(apiError)
      } finally {
        setLoading(false)
        setRefreshing(false)
        inFlight.current = null
      }
    })()

    inFlight.current = run
    return run
  }, [])

  const patch = useCallback((changes: Partial<VehicleState>) => {
    setState((current) => (current ? { ...current, ...changes } : current))
  }, [])

  useEffect(() => {
    if (!enabled) return

    let timer: number | undefined

    const schedule = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(tick, getPollMinutes() * 60_000)
    }

    // Offline, the request cannot do anything but fail — and a failure would
    // replace a perfectly good stale reading with an error. The timer keeps
    // running so the poll resumes on its own schedule if the `online` event
    // never arrives.
    const tick = () => {
      if (document.visibilityState === 'visible' && navigator.onLine !== false) void refresh()
      schedule()
    }

    // On foreground: only read if the last one has aged out. Returning to the
    // app ten times in a minute is one read, not ten.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      const last = fetchedAtRef.current
      const stale = !last || Date.now() - last.getTime() > getPollMinutes() * 60_000
      if (stale && navigator.onLine !== false) void refresh()
      schedule()
    }

    /*
     * Coming back into signal is the one moment a poll is worth making off
     * schedule: the reading on screen is by definition older than the outage,
     * and the alternative is sitting on it for the rest of the interval. Only
     * when the app is actually being looked at, though — a phone that regains
     * signal in a pocket has nobody to show it to.
     */
    const onOnline = () => {
      if (document.visibilityState === 'visible') void refresh()
      schedule()
    }

    /*
     * The first attempt is made even with no connection, unlike the ones on a
     * timer. It fails immediately and costs nothing, and it is what resolves
     * the initial loading state: a device that has never had a snapshot to
     * fall back on would otherwise sit on the skeleton until the radio came
     * back. The failure is also the honest thing to show — a cached reading
     * carries an offline banner, an empty app carries "you are offline".
     */
    void refresh()
    schedule()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)

    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
    }
  }, [enabled, refresh])

  // A device's very first load can ask for vehicle state before the shared
  // VIN has arrived from the settings store (see api/sharedSettings.ts),
  // which fails with ApiError kind 'config'. Retry once it lands, rather than
  // waiting out the rest of the poll interval — every other error kind is left
  // alone, since an unrelated shared-settings change (say, the tariff) is not
  // a reason to hit the bridge again.
  useEffect(() => {
    if (!enabled) return
    const onSettingsChange = () => {
      if (errorRef.current?.kind === 'config') void refresh()
    }
    window.addEventListener(SHARED_SETTINGS_CHANGED, onSettingsChange)
    return () => window.removeEventListener(SHARED_SETTINGS_CHANGED, onSettingsChange)
  }, [enabled, refresh])

  return { state, error, loading, refreshing, fetchedAt, refresh, patch }
}
