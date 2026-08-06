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
  type ChargingSession,
  type ChargingStatus,
  type CommandResult,
  type PreconditioningStatus,
  type RawChargeControl,
  type RawChargingSession,
  type RawTrip,
  type RawVehicleInfo,
  type Trip,
  type VehicleLocation,
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
   *
   * NOTE: ChargeControl.set_stop_hour treats [0, 0] as "disabled", so 00:00
   * cannot be set as a stop time — it clears the stop hour instead. See
   * clearChargeStopHour below.
   */
  chargeStop: (vin: string, hour: number, minute: number) =>
    `/charge_control?vin=${encodeURIComponent(vin)}&hour=${hour}&minute=${minute}`,
  /**
   * Same URL with no hour/minute/percentage — get_charge_control only
   * mutates when those are present, so this reads PSACC's current
   * stop-hour/threshold for this VIN without changing anything.
   */
  chargeControlState: (vin: string) => `/charge_control?vin=${encodeURIComponent(vin)}`,
  /**
   * Charge type: immediate (1) or delayed (0). Immediate is how a deferred
   * start is cancelled — the car keeps the stored hour but stops honouring it.
   */
  chargeNow: (vin: string, now: boolean) =>
    `/charge_now/${encodeURIComponent(vin)}/${now ? 1 : 0}`,
  horn: (vin: string, count: number) => `/horn/${encodeURIComponent(vin)}/${count}`,
  /** Duration is accepted but the car runs the lights for ~10s regardless. */
  lights: (vin: string, seconds: number) => `/lights/${encodeURIComponent(vin)}/${seconds}`,
  lockDoor: (vin: string, lock: boolean) =>
    `/lock_door/${encodeURIComponent(vin)}/${lock ? 1 : 0}`,
  chargings: () => '/vehicles/chargings',
  trips: () => '/vehicles/trips',
} as const

/** Said the same way wherever it is raised — see the two throw sites below. */
const OFFLINE_MESSAGE = 'No connection — this device is offline.'

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
    // A dead radio and a dead bridge produce the same rejected fetch, but they
    // are not the same fact and must not read as one: with no connection at
    // all, nothing was asked of the bridge and nothing is known about it.
    if (navigator.onLine === false) throw new ApiError(OFFLINE_MESSAGE, undefined, 'offline')
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
    const body = (await response.json().catch(() => null)) as
      | { message?: string; error?: string }
      | null
    // The service worker answers a failed /api/* call with a synthetic 503 so
    // the app gets JSON rather than a rejected fetch (see public/sw.js) — the
    // one case where "offline" arrives as a response instead of an exception.
    if (body?.error === 'offline') {
      throw new ApiError(OFFLINE_MESSAGE, response.status, 'offline')
    }
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

/**
 * `next_delayed_time`'s swagger doc claims an RFC3339 timestamp, but in
 * practice PSA sends the same PT#H#M duration shape `remaining_time` uses —
 * confirmed against psa_car_controller's own parse_hour (common/utils.py),
 * which every charge_now/get_charge_hour call relies on to read this exact
 * field. "PT23H" is the stored hour 23:00, not "23 hours from now"; treating
 * it as a real timestamp silently produces nothing, since `new Date("PT23H")`
 * is Invalid Date.
 */
function hhmmFromDuration(value: string | undefined): string | null {
  if (!value) return null
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(value)
  if (!match) return null
  const hour = Number(match[1] ?? 0)
  const minute = Number(match[2] ?? 0)
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** [hour, minute] -> local HH:MM, the same shape the charge widgets edit. */
function hhmmFromPair(pair: [number, number] | null | undefined): string | null {
  if (!pair) return null
  const [h, m] = pair
  if (typeof h !== 'number' || typeof m !== 'number') return null
  if (h === 0 && m === 0) return null // ChargeControl's own "disabled" sentinel
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

interface ChargeControlState {
  configured: boolean
  stopHour: string | null
  percentageThreshold: number | null
}

const UNCONFIGURED: ChargeControlState = { configured: false, stopHour: null, percentageThreshold: null }

/**
 * Reads PSACC's local charge-control config for this VIN without changing
 * it (see endpoints.chargeControlState). Never touches the car, so this is
 * safe to call on every poll regardless of the 12V-drain concerns that keep
 * get_vehicleinfo polling slow.
 *
 * "Not configured" is a normal, expected state (see ChargeLimitWidget /
 * ChargeWindowWidget) — the bridge reports it as `{error: "VIN not in
 * list"}` with an HTTP 200, which is handled here as data, not a failure.
 * A genuine fetch failure (network/timeout/auth) is left to propagate:
 * fetchVehicleState below lets it fail the whole poll rather than risk
 * mislabelling "the bridge didn't answer" as "charge control is off".
 */
export async function fetchChargeControlState(): Promise<ChargeControlState> {
  const vin = requireVin()
  const raw = await request<RawChargeControl>(endpoints.chargeControlState(vin), READ_TIMEOUT_MS)
  if (raw.error) return UNCONFIGURED
  return {
    configured: true,
    stopHour: hhmmFromPair(raw._stop_hour ?? null),
    percentageThreshold: num(raw.percentage_threshold),
  }
}

/**
 * GeoJSON orders coordinates [lon, lat, altitude?] — easy to transpose by
 * accident, so this is the one place that reads them.
 */
function parseLocation(raw: RawVehicleInfo): VehicleLocation | null {
  const coordinates = raw.last_position?.geometry?.coordinates
  if (!coordinates || coordinates.length < 2) return null
  const [lon, lat] = coordinates
  if (typeof lon !== 'number' || typeof lat !== 'number') return null
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null
  if (lon === 0 && lat === 0) return null // the bridge's "no fix yet" sentinel
  return { lat, lon, heading: num(raw.last_position?.properties?.heading) }
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
    location: parseLocation(raw),
    reportedAt: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
    chargeStartHour: hhmmFromDuration(charging?.next_delayed_time),
    // Filled in by fetchVehicleState from the separate /charge_control read —
    // get_vehicleinfo has no opinion on either.
    chargeStopHour: null,
    chargeLimitPercent: null,
    chargeControlConfigured: false,
  }
}

/**
 * `fromCache` reads psa_car_controller's stored state instead of waking the
 * car. Background polling passes true; pull-to-refresh passes false.
 *
 * Charge-control state is fetched alongside it every time, cache flag or
 * not — it's a local bridge read (see fetchChargeControlState), not a call
 * to the car, so it carries none of the wake-up cost that flag exists to
 * avoid. Both requests are awaited together: a failure in either fails the
 * whole poll rather than risk half-updating the UI with one true reading and
 * one stale one.
 */
export async function fetchVehicleState(fromCache = false): Promise<VehicleState> {
  const vin = requireVin()
  const [raw, chargeControl] = await Promise.all([
    request<RawVehicleInfo>(endpoints.vehicleInfo(vin, fromCache), READ_TIMEOUT_MS),
    fetchChargeControlState(),
  ])
  return {
    ...normalise(raw, vin),
    chargeStopHour: chargeControl.stopHour,
    chargeLimitPercent: chargeControl.percentageThreshold,
    chargeControlConfigured: chargeControl.configured,
  }
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
    if (message === 'VIN not in list') {
      throw new ApiError(
        'Charge control is not set up in psa_car_controller for this VIN.',
        200,
      )
    }
    // horn / lights / wakeup / lock_door all report throttling this way.
    if (/rate limit/i.test(message)) {
      throw new ApiError('Rate limited by the bridge — wait a moment and retry.', 200, 'server')
    }
    throw new ApiError(message, 200)
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
  // [0, 0] is the bridge's "disabled" sentinel, so it cannot mean midnight.
  if (h === 0 && m === 0) return clearChargeStopHour()
  return command(endpoints.chargeStop(requireVin(), h, m), `Charging stops at ${hhmm(h, m)}`)
}

/** Sends the [0, 0] sentinel that ChargeControl.set_stop_hour reads as "off". */
export function clearChargeStopHour(): Promise<CommandResult> {
  return command(endpoints.chargeStop(requireVin(), 0, 0), 'Stop time cleared')
}

/**
 * Cancels a deferred start by switching the car to immediate charging. The
 * stored hour stays in the car; it simply stops being honoured.
 */
export function clearChargeStartHour(): Promise<CommandResult> {
  return command(endpoints.chargeNow(requireVin(), true), 'Charging immediately')
}

/** Puts the car back on its stored delayed-charge hour. */
export function resumeDelayedCharge(): Promise<CommandResult> {
  return command(endpoints.chargeNow(requireVin(), false), 'Delayed charging resumed')
}

/**
 * PSACC's `kw` field is energy in kWh, not power:
 *   consumption_kw = (level - last_charge.start_level) / 100 * car.battery_power
 * Renaming it here so nothing downstream plots it as kilowatts.
 */
export function normaliseSession(raw: RawChargingSession): ChargingSession {
  const started = raw.start_at ? new Date(raw.start_at) : null
  const startedAt = started && !Number.isNaN(started.getTime()) ? started : null
  const stopped = raw.stop_at ? new Date(raw.stop_at) : null
  const stoppedAt = stopped && !Number.isNaN(stopped.getTime()) ? stopped : null

  /*
   * duration_min is what the bridge normally supplies, but it is missing on
   * rows written by older versions. The two timestamps say the same thing and
   * are the only ones present on those rows — and the duration is no longer
   * cosmetic now that a tariff splits a session's energy across rate periods by
   * how long it spent in each.
   */
  const spanned =
    startedAt && stoppedAt ? Math.round((stoppedAt.getTime() - startedAt.getTime()) / 60_000) : null

  return {
    startedAt,
    energy: num(raw.kw),
    startLevel: num(raw.start_level),
    endLevel: num(raw.end_level),
    durationMinutes: num(raw.duration_min) ?? (spanned !== null && spanned > 0 ? spanned : null),
    mode: raw.charging_mode ?? null,
    price: num(raw.price),
  }
}

/**
 * Charging history. This reads psa_car_controller's own database and never
 * touches the car, so it is free to call whenever.
 *
 * The bridge returns [] rather than an error when it has too little data yet.
 */
export async function fetchChargingSessions(): Promise<ChargingSession[]> {
  const raw = await request<RawChargingSession[]>(endpoints.chargings(), READ_TIMEOUT_MS)
  if (!Array.isArray(raw)) return []
  return raw
    .map(normaliseSession)
    .filter((session) => session.startedAt !== null)
    .sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0))
}

/**
 * Completed trips, from psa_car_controller's own database — like /chargings it
 * never touches the car.
 *
 * Every trip carries its whole GPS track in `positions`, so this response is
 * substantially larger than the charging one and grows with the car's history.
 * It is read on demand rather than on mount for that reason — see
 * OdometerWidget.
 *
 * The bridge returns [] rather than an error when it has too little data yet.
 */
export async function fetchTrips(): Promise<Trip[]> {
  const raw = await request<RawTrip[]>(endpoints.trips(), READ_TIMEOUT_MS)
  if (!Array.isArray(raw)) return []
  return raw
    .map((trip) => {
      const started = trip.start_at ? new Date(trip.start_at) : null
      return {
        startedAt: started && !Number.isNaN(started.getTime()) ? started : null,
        distance: num(trip.distance),
      }
    })
    .filter((trip) => trip.startedAt !== null)
    .sort((a, b) => (a.startedAt?.getTime() ?? 0) - (b.startedAt?.getTime() ?? 0))
}

export function soundHorn(count = 1): Promise<CommandResult> {
  const times = Math.min(5, Math.max(1, Math.round(count)))
  return command(endpoints.horn(requireVin(), times), 'Horn sounded')
}

export function flashLights(seconds = 10): Promise<CommandResult> {
  return command(endpoints.lights(requireVin(), seconds), 'Lights flashed')
}

/**
 * `get_vehicleinfo` reports no door-lock field, so the app cannot show whether
 * the car is actually locked — this is fire-and-forget, same as horn/lights.
 */
export function setDoorLock(locked: boolean): Promise<CommandResult> {
  return command(
    endpoints.lockDoor(requireVin(), locked),
    locked ? 'Doors locked' : 'Doors unlocked',
  )
}
