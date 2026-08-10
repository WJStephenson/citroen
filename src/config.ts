/**
 * Runtime configuration.
 *
 * Build-time env vars provide the defaults; the VIN and poll interval can also
 * be overridden at runtime from the Settings sheet so a rebuild is not needed
 * to point the app at a different car. Both are shared across every device
 * controlling this car (see api/sharedSettings.ts) rather than being stored
 * per-browser — there is one car and one poll policy for it, not one per phone.
 */

import { getSharedSettings, patchSharedSettings } from './api/sharedSettings'

/** nginx strips this prefix before proxying to psa_car_controller:5000. */
export const API_BASE = import.meta.env.VITE_API_BASE ?? '/api'

/**
 * How often the app re-reads vehicle state in the background.
 *
 * This used to be floored at 20 minutes as the doc's §5 mitigation for 12V
 * drain, on the belief that a read reaches the car. It does not: reading
 * without `from_cache` calls Stellantis's `/vehicles/{id}/status`, which
 * returns whatever the car last uploaded to them (see api/client.ts). The one
 * call that touches the car is `/wakeup`, which is a deliberate, confirmed
 * action here and nothing else in the app sends it.
 *
 * So the floor is now what a read actually costs — someone else's API — and is
 * set by Stellantis's tolerance rather than the car's battery. psa_car_controller
 * polls the same endpoint every 120s when charge control is on, which puts five
 * minutes comfortably inside what upstream treats as normal.
 */
export const MIN_POLL_MINUTES = 5
export const DEFAULT_POLL_MINUTES = Number(import.meta.env.VITE_POLL_MINUTES ?? 5)

/**
 * How old the car's own reading may get before the dashboard says so.
 *
 * Measured on the car's timestamp, not on ours — see App.tsx. Two hours is
 * long enough that an ordinary parked evening does not cry stale, and short
 * enough that a car which has genuinely stopped reporting is called out before
 * you plan a journey around one of its numbers.
 */
export const STALE_AFTER_MINUTES = 120

/**
 * Stellantis sends an SMS wake-up packet to the car's ECU and the vehicle can
 * take 30-90s to answer. nginx is configured with a 120s read timeout; the
 * client gives up slightly earlier so the error is ours, not a proxy 504.
 */
export const COMMAND_TIMEOUT_MS = 115_000
export const READ_TIMEOUT_MS = 30_000
export const EXPECTED_WAKE_SECONDS = 90

/** Re-lock the UI if the app has been backgrounded for longer than this. */
export const LOCK_GRACE_MS = 60_000

export function getVin(): string {
  const raw = getSharedSettings().vin
  return typeof raw === 'string' && raw ? raw : (import.meta.env.VITE_VIN ?? '')
}

/** Resolves once the store has it — see patchSharedSettings. */
export function setVin(vin: string): Promise<boolean> {
  return patchSharedSettings({ vin: vin.trim().toUpperCase() })
}

export function getPollMinutes(): number {
  const raw = getSharedSettings().pollMinutes
  const value = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_MINUTES
  return Math.max(MIN_POLL_MINUTES, value)
}

/** Resolves once the store has it — see patchSharedSettings. */
export function setPollMinutes(minutes: number): Promise<boolean> {
  return patchSharedSettings({ pollMinutes: Math.max(MIN_POLL_MINUTES, Math.round(minutes)) })
}

/**
 * Whether the schedule is put back in force each time the car is unplugged.
 *
 * Nothing in this app acts on it: the setting is read by the server-side
 * watcher (deploy/charge_notify.py), which is the only thing awake at the
 * moment a car is unplugged. It lives here because the switch that sets it
 * does, and because the two have to agree on what an absent value means —
 * on, matching rearm_enabled in the watcher. A household that has never
 * opened the switch has no stored value, and the behaviour it turns off is
 * the one that makes a start hour mean anything past its first charge.
 *
 * Shared rather than per-device for the obvious reason: there is one car, one
 * schedule, and one watcher acting on it. A per-phone answer would be a
 * setting three phones could disagree about while the server did one thing.
 */
export function getRearmOnUnplug(): boolean {
  return getSharedSettings().rearmScheduleOnUnplug !== false
}

/** Resolves once the store has it — see patchSharedSettings. */
export function setRearmOnUnplug(on: boolean): Promise<boolean> {
  return patchSharedSettings({ rearmScheduleOnUnplug: on })
}
