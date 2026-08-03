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
 * The doc's §5 mitigation for 12V auxiliary battery drain: never poll the car
 * more often than this while it is parked. Manual pull-to-refresh is the
 * primary way to get fresh state.
 */
export const MIN_POLL_MINUTES = 20
export const DEFAULT_POLL_MINUTES = Number(import.meta.env.VITE_POLL_MINUTES ?? 20)

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

export function setVin(vin: string): void {
  patchSharedSettings({ vin: vin.trim().toUpperCase() })
}

export function getPollMinutes(): number {
  const raw = getSharedSettings().pollMinutes
  const value = typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_POLL_MINUTES
  return Math.max(MIN_POLL_MINUTES, value)
}

export function setPollMinutes(minutes: number): void {
  patchSharedSettings({ pollMinutes: Math.max(MIN_POLL_MINUTES, Math.round(minutes)) })
}
