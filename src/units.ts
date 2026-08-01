/**
 * Display units.
 *
 * The bridge always reports metric — kilometres and Celsius — because that is
 * what the Stellantis API returns. Conversion is presentation only; nothing
 * sent to the car is ever converted.
 */

export type DistanceUnit = 'km' | 'mi'
export type TemperatureUnit = 'C' | 'F'

export interface UnitPreferences {
  distance: DistanceUnit
  temperature: TemperatureUnit
}

const LS_UNITS = 'ec4.units'
const KM_PER_MILE = 1.609344

/** Fired on change so open views re-render without a reload. */
export const UNITS_CHANGED = 'ec4:units-changed'

const DEFAULTS: UnitPreferences = { distance: 'km', temperature: 'C' }

// getUnits is a useSyncExternalStore snapshot, so it must return the *same*
// object until the value genuinely changes, or React re-renders forever. The
// raw string is the cache key rather than a plain "loaded" flag, so a write
// from another tab (which arrives as a storage event, not through setUnits)
// still invalidates it.
let cachedRaw: string | null | undefined
let cache: UnitPreferences = DEFAULTS

function parse(raw: string | null): UnitPreferences {
  try {
    const stored = JSON.parse(raw ?? '{}') as Partial<UnitPreferences>
    return {
      distance: stored.distance === 'mi' ? 'mi' : 'km',
      temperature: stored.temperature === 'F' ? 'F' : 'C',
    }
  } catch {
    return { ...DEFAULTS }
  }
}

export function getUnits(): UnitPreferences {
  const raw = localStorage.getItem(LS_UNITS)
  if (raw !== cachedRaw) {
    cachedRaw = raw
    cache = parse(raw)
  }
  return cache
}

export function setUnits(next: Partial<UnitPreferences>): UnitPreferences {
  const merged = { ...getUnits(), ...next }
  localStorage.setItem(LS_UNITS, JSON.stringify(merged))
  window.dispatchEvent(new Event(UNITS_CHANGED))
  return getUnits()
}

export function formatDistance(km: number | null, unit: DistanceUnit): string {
  if (km === null) return '—'
  const value = unit === 'mi' ? km / KM_PER_MILE : km
  return `${Math.round(value).toLocaleString('en-GB')} ${unit}`
}

/**
 * Whether a reading could actually be a 12V battery.
 *
 * status.battery.voltage is not dependable: upstream reports it carrying a
 * scaled or unrelated value depending on the car (flobz/psa_car_controller
 * #765), and on the ë-C4 it can sit at a constant like 99.0 — neither a
 * plausible 12V reading nor a plausible traction voltage. A resting 12V battery
 * is ~12.4-12.7V, ~14.4V on charge, and below 11.8V it is flat.
 */
export function isPlausibleAuxVoltage(volts: number | null): boolean {
  return volts !== null && volts >= 10 && volts <= 15.5
}

export function formatTemperature(celsius: number | null, unit: TemperatureUnit): string {
  if (celsius === null) return '—'
  const value = unit === 'F' ? celsius * 1.8 + 32 : celsius
  return `${value.toFixed(1)}°${unit}`
}
