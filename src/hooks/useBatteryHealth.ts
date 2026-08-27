import { useEffect, useState } from 'react'
import { fetchBatterySoh } from '../api/client'
import { SHARED_SETTINGS_CHANGED } from '../api/sharedSettings'

/**
 * Traction-battery state of health (usable capacity retention as a percentage),
 * or null when the bridge has no usable figure, which is a normal answer and not an error.
 *
 * Prefers the live vehicle state's capacity field (from energy.battery.health.capacity
 * in get_vehicleinfo), falling back to the /battery/soh endpoint if not yet present in telemetry.
 */
export function useBatteryHealth(enabled: boolean, liveCapacity?: number | null): number | null {
  const [soh, setSoh] = useState<number | null>(() => liveCapacity ?? null)
  // The VIN can arrive from the settings store after the first render, the
  // same way vehicle state can — see useVehicle. Retrying on that event is
  // what stops a device's first-ever load from being the one that never shows
  // the tile.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (liveCapacity !== undefined && liveCapacity !== null) {
      setSoh(liveCapacity)
    }
  }, [liveCapacity])

  useEffect(() => {
    if (!enabled || soh !== null) return
    let live = true
    fetchBatterySoh()
      .then((value) => live && value !== null && setSoh(value))
      .catch(() => {})
    return () => {
      live = false
    }
  }, [enabled, soh, attempt])

  useEffect(() => {
    if (!enabled || soh !== null) return
    const onChange = () => setAttempt((n) => n + 1)
    window.addEventListener(SHARED_SETTINGS_CHANGED, onChange)
    return () => window.removeEventListener(SHARED_SETTINGS_CHANGED, onChange)
  }, [enabled, soh])

  return soh
}
