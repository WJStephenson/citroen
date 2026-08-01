/**
 * The single place that knows psa_car_controller's URL shapes.
 *
 * Verified against the upstream source, not the design doc — the doc was wrong
 * about charge_control in two ways (it put the VIN in the path and called the
 * threshold `single_threshold`). Real signatures, from
 * psa_car_controller/web/view/api.py:
 *
 *   /get_vehicleinfo/<vin>?from_cache=1
 *   /preconditioning/<vin>/<0|1>
 *   /charge_control?vin=&percentage=          <- VIN is a QUERY param
 *   /charge_control?vin=&hour=&minute=        <- sets the STOP hour
 *   /charge_hour?vin=&hour=&minute=           <- sets the START hour
 */

import { API_BASE, COMMAND_TIMEOUT_MS, READ_TIMEOUT_MS, getVin } from '../config'
import {
  ApiError,
  type ChargingStatus,
  type CommandResult,
  type PreconditioningStatus,
  type RawVehicleInfo,
  type VehicleState,
} from './types'

export const endpoints = {
  /**
   * from_cache=1 returns psa_car_controller's last known state without
   * contacting the car. Background polls use it so a parked car is never woken
   * on a timer; manual refresh omits it to force a live read.
   */
  vehicleInfo: (vin: string, fromCache = false) =>
    `/get_vehicleinfo/${encodeURIComponent(vin)}${fromCache ? '?from_cache=1' : ''}`,
  preconditioning: (vin: string, on: boolean) =>
    `/preconditioning/${encodeURIComponent(vin)}/${on ? 1 : 0}`,
  /** Local PSACC charge-control config — requires charge control set up in PSACC. */
  chargeLimit: (vin: string, limit: number) =>
    `/charge_control?vin=${encodeURIComponent(vin)}&percentage=${limit}`,
  /** Remote command to the car: the hour charging should START. */
  chargeStart: (vin: string, hour: number, minute: number) =>
    `/charge_hour?vin=${encodeURIComponent(vin)}&hour=${hour}&minute=${minute}`,
  /**
   * The hour charging should STOP. Same local charge-control mechanism as the
   * percentage threshold, so it carries the same "VIN not in list" caveat.
   */
  chargeStop: (vin: string, hour: number, minute: number) =>
    `/charge_control?vin=${encodeURIComponent(vin)}&hour=${hour}&minute=${minute}`,
} as const

async function request<T>(path: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      signal: controller.signal,
      // Cloudflare Access sets an authorisation cookie on the tunnel hostname;
      // it has to ride along or every call 302s to the login page.
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
  } catch {
    if (controller.signal.aborted) {
      throw new ApiError(
        'The car did not answer in time. It may still be waking up.',
        undefined,
        'timeout',
      )
    }
    throw new ApiError('Cannot reach the bridge.', undefined, 'network')
  } finally {
    clearTimeout(timer)
  }

  // Cloudflare Access redirects unauthenticated calls to its login page, which
  // arrives here as HTML with a 200. Treat a non-JSON body as an auth failure
  // rather than letting JSON.parse throw something unreadable.
  const contentType = response.headers.get('content-type') ?? ''
  if (response.status === 401 || response.status === 403) {
    throw new ApiError('Access denied by the edge. Re-authenticate.', response.status, 'auth')
  }
  if (!contentType.includes('json')) {
    const body = await response.text().catch(() => '')
    if (/<html/i.test(body)) {
      throw new ApiError('Session expired. Reload to sign in again.', response.status, 'auth')
    }
    throw new ApiError(`Unexpected response from the bridge (${response.status}).`, response.status)
  }
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null
    throw new ApiError(body?.message ?? `Bridge returned ${response.status}.`, response.status)
  }

  return (await response.json()) as T
}

function requireVin(): string {
  const vin = getVin()
  if (!vin) throw new ApiError('No VIN configured. Set one in Settings.', undefined, 'config')
  return vin
}

const CHARGING_STATUS: Record<string, ChargingStatus> = {
  inprogress: 'charging',
  charging: 'charging',
  stopped: 'plugged-idle',
  disconnected: 'disconnected',
  finished: 'finished',
  failure: 'failure',
  quickcharge: 'charging',
}

const PRECONDITIONING_STATUS: Record<string, PreconditioningStatus> = {
  enabled: 'on',
  activated: 'on',
  disabled: 'off',
  deactivated: 'off',
  finished: 'finished',
  done: 'finished',
}

/** Minutes, from either an ISO-8601 duration ("PT1H30M") or a plain number. */
function parseRemaining(value: string | number | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (!value) return null
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(value)
  if (!match) {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : null
  }
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export function normalise(raw: RawVehicleInfo, vin: string): VehicleState {
  // A car with both an EV and a fuel tank reports several energy entries.
  const energy = raw.energy?.find((e) => e.type?.toLowerCase() === 'electric') ?? raw.energy?.[0]
  const charging = energy?.charging
  const acStatus = raw.preconditionning?.air_conditioning?.status?.toLowerCase()
  const reportedAt = energy?.updated_at ?? raw.last_position?.properties?.updated_at
  const parsedDate = reportedAt ? new Date(reportedAt) : null

  return {
    vin: raw.vin ?? vin,
    battery: num(energy?.level),
    range: num(energy?.autonomy),
    charging: CHARGING_STATUS[charging?.status?.toLowerCase() ?? ''] ?? 'unknown',
    chargingMode: charging?.charging_mode ?? null,
    chargingRemainingMinutes: parseRemaining(charging?.remaining_time),
    preconditioning: PRECONDITIONING_STATUS[acStatus ?? ''] ?? 'unknown',
    cabinTemp: num(raw.environment?.air?.temp),
    odometer: num(raw.timed_odometer?.mileage),
    auxVoltage: num(raw.battery?.voltage),
    reportedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
  }
}

/**
 * `fromCache` reads psa_car_controller's stored state instead of waking the
 * car. Background polling passes true; pull-to-refresh passes false.
 */
export async function fetchVehicleState(fromCache = false): Promise<VehicleState> {
  const vin = requireVin()
  const raw = await request<RawVehicleInfo>(
    endpoints.vehicleInfo(vin, fromCache),
    READ_TIMEOUT_MS,
  )
  return normalise(raw, vin)
}

/**
 * Commands return quickly with an acknowledgement; the car itself acts 30-90s
 * later. The UI is responsible for saying so — see CommandOverlay.
 */
async function command(path: string, success: string): Promise<CommandResult> {
  const body = await request<unknown>(path, COMMAND_TIMEOUT_MS)

  // psa_car_controller reports several failures as {"error": "..."} with an
  // HTTP 200 — notably charge_control when charge control is not configured
  // ("VIN not in list"). Without this check the UI would cheerfully report
  // success for a command that did nothing.
  if (body && typeof body === 'object' && 'error' in body) {
    const message = String((body as { error: unknown }).error)
    throw new ApiError(
      message === 'VIN not in list'
        ? 'Charge control is not set up in psa_car_controller for this VIN.'
        : message,
      200,
    )
  }

  return { ok: true, message: success }
}

export function setPreconditioning(on: boolean): Promise<CommandResult> {
  return command(
    endpoints.preconditioning(requireVin(), on),
    on ? 'Pre-conditioning requested' : 'Pre-conditioning stopped',
  )
}

export function setChargeLimit(limit: number): Promise<CommandResult> {
  const clamped = Math.min(100, Math.max(20, Math.round(limit)))
  return command(
    endpoints.chargeLimit(requireVin(), clamped),
    `Charge limit set to ${clamped}%`,
  )
}

const clampHour = (hour: number) => Math.min(23, Math.max(0, Math.round(hour)))
const clampMinute = (minute: number) => Math.min(59, Math.max(0, Math.round(minute)))
const hhmm = (hour: number, minute: number) =>
  `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`

export function setChargeStartHour(hour: number, minute: number): Promise<CommandResult> {
  const h = clampHour(hour)
  const m = clampMinute(minute)
  return command(endpoints.chargeStart(requireVin(), h, m), `Charging starts at ${hhmm(h, m)}`)
}

export function setChargeStopHour(hour: number, minute: number): Promise<CommandResult> {
  const h = clampHour(hour)
  const m = clampMinute(minute)
  return command(endpoints.chargeStop(requireVin(), h, m), `Charging stops at ${hhmm(h, m)}`)
}
