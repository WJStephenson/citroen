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
 * How much energy the car is using, in the form the chosen distance unit is
 * normally quoted in — and they are quoted the opposite way up from each other.
 * Metric practice is kWh per 100 km, where lower is better; British and
 * American EV drivers talk in miles per kWh, where higher is. Printing
 * "kWh/100mi" because the app is in miles would be technically consistent and
 * read as a foreign number.
 *
 * The ratio is returned split, numerator from denominator ("17.2 kWh" / "per
 * 100 km"), because a half-width tile has no room for a nine-character unit
 * beside a 34px number — the tile puts the second half on its note line
 * instead. See EfficiencyWidget.
 *
 * Null when the pair cannot produce a ratio, rather than an infinity or a NaN
 * dressed up as a reading.
 */
export function formatEfficiency(
  energyKwh: number,
  distanceKm: number,
  unit: DistanceUnit,
): { value: string; unit: string; per: string } | null {
  if (!(distanceKm > 0) || !(energyKwh > 0)) return null
  if (unit === 'mi') {
    return {
      value: (distanceKm / KM_PER_MILE / energyKwh).toFixed(1),
      unit: 'mi',
      per: 'per kWh',
    }
  }
  return { value: ((energyKwh / distanceKm) * 100).toFixed(1), unit: 'kWh', per: 'per 100 km' }
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
