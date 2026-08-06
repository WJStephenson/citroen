import { useEffect, useState } from 'react'
import { fetchBatterySoh } from '../api/client'
import { SHARED_SETTINGS_CHANGED } from '../api/sharedSettings'

/**
 * Traction-battery state of health, as a percentage — or null when the bridge
 * has no usable figure, which is a normal answer and not an error.
 *
 * Read once per session rather than on the vehicle poll. It is a local read of
 * the bridge's own records, so it carries none of the 12V-drain cost that
 * keeps get_vehicleinfo slow; but it is also a number that moves by a percent
 * or two a *year*, so polling it on any schedule at all would be theatre.
 *
 * A failure is swallowed into null. The tile it feeds is conditional (see
 * App), so the whole of "the route isn't there", "the bridge has no reading
 * yet" and "the reading was nonsense" resolve to the same thing: no tile. An
 * error banner for a number nobody asked for would be noise.
 */
export function useBatteryHealth(enabled: boolean): number | null {
  const [soh, setSoh] = useState<number | null>(null)
  // The VIN can arrive from the settings store after the first render, the
  // same way vehicle state can — see useVehicle. Retrying on that event is
  // what stops a device's first-ever load from being the one that never shows
  // the tile.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled || soh !== null) return
    let live = true
    fetchBatterySoh()
      .then((value) => live && setSoh(value))
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
