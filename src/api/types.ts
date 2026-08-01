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
    properties?: { updated_at?: string }
  }
  service_type?: string
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
  /** When the *car* last reported, not when we last polled. */
  reportedAt: Date | null
}

export type CommandKind =
  | 'precondition'
  | 'chargeLimit'
  | 'chargeStart'
  | 'chargeStop'
  | 'chargeNow'
  | 'horn'
  | 'lights'

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
