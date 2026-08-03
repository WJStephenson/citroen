import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchVehicleState } from '../api/client'
import { SHARED_SETTINGS_CHANGED } from '../api/sharedSettings'
import { ApiError, type VehicleState } from '../api/types'
import { getPollMinutes } from '../config'

export interface VehicleFeed {
  state: VehicleState | null
  error: ApiError | null
  /** True only for the initial load, so refreshes don't blank the screen. */
  loading: boolean
  refreshing: boolean
  /** When *we* last successfully polled the bridge. */
  fetchedAt: Date | null
  /**
   * `live` forces a read from the car itself. Omit it for routine refreshes,
   * which read psa_car_controller's cache and never wake a parked car.
   */
  refresh: (options?: { live?: boolean }) => Promise<void>
  /** Locally applied expectation, reconciled on the next successful poll. */
  patch: (changes: Partial<VehicleState>) => void
}

/**
 * Owns vehicle telemetry.
 *
 * Polling is deliberately slow (20+ minutes, see config.MIN_POLL_MINUTES):
 * every poll can keep the car's ECUs awake and drain the 12V auxiliary battery.
 * The timer is also suspended whenever the app is not visible, so a PWA left
 * open in the background costs nothing.
 */
export function useVehicle(enabled: boolean): VehicleFeed {
  const [state, setState] = useState<VehicleState | null>(null)
  const [error, setError] = useState<ApiError | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null)

  // Guards against two overlapping polls (manual pull + timer firing together).
  const inFlight = useRef<Promise<void> | null>(null)
  const fetchedAtRef = useRef<Date | null>(null)
  const errorRef = useRef<ApiError | null>(null)

  const refresh = useCallback<VehicleFeed['refresh']>(async (options) => {
    if (inFlight.current) return inFlight.current

    const run = (async () => {
      setRefreshing(true)
      try {
        const next = await fetchVehicleState(!options?.live)
        setState(next)
        errorRef.current = null
        setError(null)
        const now = new Date()
        fetchedAtRef.current = now
        setFetchedAt(now)
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

    const tick = () => {
      if (document.visibilityState === 'visible') void refresh()
      schedule()
    }

    // On foreground: only hit the car if the data is actually stale. Returning
    // to the app ten times in a minute must not mean ten wake-up attempts.
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return
      const last = fetchedAtRef.current
      const stale = !last || Date.now() - last.getTime() > getPollMinutes() * 60_000
      if (stale) void refresh()
      schedule()
    }

    void refresh()
    schedule()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      window.clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
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
