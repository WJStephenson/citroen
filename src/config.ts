/**
 * Runtime configuration.
 *
 * Build-time env vars provide the defaults; the VIN and poll interval can also
 * be overridden at runtime from the Settings sheet so a rebuild is not needed
 * to point the app at a different car.
 */

const LS_VIN = 'ec4.vin'
const LS_POLL = 'ec4.pollMinutes'

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
  return localStorage.getItem(LS_VIN) ?? import.meta.env.VITE_VIN ?? ''
}

export function setVin(vin: string): void {
  const trimmed = vin.trim().toUpperCase()
  if (trimmed) localStorage.setItem(LS_VIN, trimmed)
  else localStorage.removeItem(LS_VIN)
}

export function getPollMinutes(): number {
  const stored = Number(localStorage.getItem(LS_POLL))
  const value = Number.isFinite(stored) && stored > 0 ? stored : DEFAULT_POLL_MINUTES
  return Math.max(MIN_POLL_MINUTES, value)
}

export function setPollMinutes(minutes: number): void {
  localStorage.setItem(LS_POLL, String(Math.max(MIN_POLL_MINUTES, Math.round(minutes))))
}
