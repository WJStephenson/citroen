/**
 * Two layers of types:
 *
 *  - `Raw*` mirrors what psa_car_controller actually returns. Every field is
 *    optional because the shape varies by firmware, by trim, and by whether the
 *    car has answered since the last deep sleep.
 *  - `VehicleState` is the normalised, strict shape the UI renders. Nothing in
 *    src/components ever touches a Raw type.
 *
 * All the loosening lives in api/client.ts::normalise.
 */

export interface RawCharging {
  status?: string
  charging_mode?: string
  charging_rate?: number
  remaining_time?: string | number
  next_delayed_time?: string
}

export interface RawEnergy {
  type?: string
  level?: number
  autonomy?: number
  updated_at?: string
  charging?: RawCharging
}

export interface RawVehicleInfo {
  vin?: string
  energy?: RawEnergy[]
  battery?: { voltage?: number; current?: number }
  preconditionning?: {
    air_conditioning?: { status?: string; updated_at?: string }
  }
  timed_odometer?: { mileage?: number }
  environment?: { air?: { temp?: number } }
  last_position?: {
    geometry?: { coordinates?: number[] }
    properties?: { updated_at?: string; heading?: number }
  }
  service_type?: string
}

/**
 * `GET /charge_control?vin=` with no hour/minute/percentage params is
 * read-only — see get_charge_control in psa_car_controller/web/view/api.py,
 * which only mutates when those params are present and always returns the
 * ChargeControl dict either way. This is that dict.
 *
 * "VIN not in list" comes back as `{error: "..."}` (HTTP 200) when charge
 * control was never set up for this VIN — not a fetch failure.
 */
export interface RawChargeControl {
  _stop_hour?: [number, number] | null
  percentage_threshold?: number
  error?: string
}

export type ChargingStatus =
  | 'charging'
  | 'plugged-idle'
  | 'finished'
  | 'disconnected'
  | 'failure'
  | 'unknown'

export type PreconditioningStatus = 'on' | 'off' | 'finished' | 'unknown'

export interface VehicleState {
  vin: string
  /** State of charge, 0-100. */
  battery: number | null
  /** Remaining range in km. */
  range: number | null
  charging: ChargingStatus
  /** Free-text mode from the bridge, e.g. "Slow" / "Quick". */
  chargingMode: string | null
  /** Minutes remaining on the current charge, when the car reports it. */
  chargingRemainingMinutes: number | null
  preconditioning: PreconditioningStatus
  /** Cabin temperature in °C. */
  cabinTemp: number | null
  /** Odometer in km. */
  odometer: number | null
  /** 12V auxiliary battery voltage — the drain risk called out in §5. */
  auxVoltage: number | null
  /** Where the car last reported being parked or driving. */
  location: VehicleLocation | null
  /** When the *car* last reported, not when we last polled. */
  reportedAt: Date | null
  /**
   * HH:MM the car itself currently holds as its delayed-charge start, read
   * from `next_delayed_time` — not what any device last asked for. Null if
   * the car reports no delayed-charge time at all.
   */
  chargeStartHour: string | null
  /**
   * HH:MM PSACC will cut the charge at, read back from its own
   * /charge_control config — null if no stop hour is set, which is
   * indistinguishable from "not configured" without chargeControlConfigured.
   */
  chargeStopHour: string | null
  /** The percentage PSACC will stop the charge at, read back the same way. */
  chargeLimitPercent: number | null
  /**
   * Whether PSACC's charge_control is set up for this VIN at all. When false,
   * chargeStopHour/chargeLimitPercent are meaningless (nothing to read), and
   * setting either will fail with "VIN not in list" — see command() in
   * client.ts.
   */
  chargeControlConfigured: boolean
}

export interface VehicleLocation {
  lat: number
  lon: number
  /** Compass heading in degrees, when the car reports one. */
  heading: number | null
}

/** One completed charging session, as Charging.get_chargings() returns it. */
export interface RawChargingSession {
  start_at?: string
  stop_at?: string
  start_level?: number
  end_level?: number
  charging_mode?: string
  vin?: string
  mileage?: number
  price?: number
  /** Energy in kWh, despite the name — see normaliseSession. */
  kw?: number
  co2?: number
  duration_min?: number
  duration_str?: string
}

export interface ChargingSession {
  startedAt: Date | null
  /** Energy added, kWh. */
  energy: number | null
  startLevel: number | null
  endLevel: number | null
  durationMinutes: number | null
  mode: string | null
  price: number | null
}

/**
 * One trip from /vehicles/trips.
 *
 * The bridge sends far more than this per trip — consumption figures, an
 * altitude delta, and a `positions` object holding the whole GPS track — but
 * only the date and the distance are read here, so the rest is left undeclared
 * rather than modelled and ignored.
 */
export interface RawTrip {
  id?: number
  /**
   * Serialised by Flask's jsonify, which emits an RFC 1123 HTTP-date
   * ("Wed, 05 Aug 2026 07:12:33 GMT") on Flask < 2.3 and ISO 8601 after it.
   * `new Date` reads both, so nothing here has to know which is in front of it.
   */
  start_at?: string
  /** Distance covered by this trip, km. */
  distance?: number
  /** The odometer at the end of the trip, km. */
  mileage?: number
}

export interface Trip {
  startedAt: Date | null
  /** km */
  distance: number | null
}

export type CommandKind =
  | 'precondition'
  | 'chargeLimit'
  | 'chargeStart'
  | 'chargeStop'
  | 'chargeNow'
  | 'horn'
  | 'lights'
  | 'lock'

export interface CommandResult {
  ok: boolean
  message: string
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly kind: 'network' | 'auth' | 'timeout' | 'server' | 'config' = 'server',
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
