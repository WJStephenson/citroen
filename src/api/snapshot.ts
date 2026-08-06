/**
 * The last vehicle state this device successfully read, kept on disk so the
 * app has something true to show the moment it opens.
 *
 * The service worker already gets the shell up in well under a second, but a
 * dashboard that renders instantly and then says "No vehicle data yet" is not a
 * dashboard — it is a network client with a nice loading screen. Underground
 * car parks, lifts and rural lanes are exactly where someone stands wondering
 * what the charge was, and the answer from twenty minutes ago is nearly always
 * the answer they wanted.
 *
 * What is stored is a *reading*, never an expectation: only a successful poll
 * writes here, so the optimistic patches useVehicle applies while a command is
 * in flight can never be persisted as though the car had confirmed them.
 *
 * Per-browser (localStorage), not in the shared settings blob — this is a cache
 * of what one device last saw, not a setting the household agrees on. It is
 * also the reason the snapshot is discarded when the VIN changes: a reading
 * from a different car is worse than no reading.
 *
 * Note this sits outside the app lock, in the same store as the VIN and the
 * tariff. The lock keeps the controls behind a PIN or a passkey; it has never
 * been an at-rest encryption boundary, and telemetry is not made safer by
 * being thrown away on every launch.
 */

import type { VehicleState } from './types'

const LS_SNAPSHOT = 'ec4.lastState'
/** Bumped when VehicleState changes shape, so an old blob is dropped rather
    than half-read into fields that no longer mean what they did. */
const VERSION = 3

export interface Snapshot {
  state: VehicleState
  /** When this device polled — the same clock App's "Updated N ago" reads. */
  fetchedAt: Date
}

interface Envelope {
  v: number
  vin: string
  fetchedAt: string
  state: Omit<VehicleState, 'reportedAt'> & { reportedAt: string | null }
}

export function saveSnapshot(state: VehicleState, fetchedAt: Date): void {
  try {
    const envelope: Envelope = {
      v: VERSION,
      vin: state.vin,
      fetchedAt: fetchedAt.toISOString(),
      state: { ...state, reportedAt: state.reportedAt?.toISOString() ?? null },
    }
    localStorage.setItem(LS_SNAPSHOT, JSON.stringify(envelope))
  } catch {
    // A full or disabled store costs the app nothing but this cache.
  }
}

export function clearSnapshot(): void {
  localStorage.removeItem(LS_SNAPSHOT)
}

/**
 * The last reading, or null if there isn't a usable one.
 *
 * `vin` is the VIN configured *now*. A snapshot for another car is dropped; an
 * empty VIN is not treated as a mismatch, because on a device's very first
 * load the shared VIN can still be in flight (see api/sharedSettings.ts) and
 * the snapshot would be thrown away for no reason.
 */
export function loadSnapshot(vin: string): Snapshot | null {
  let envelope: Envelope
  try {
    const raw = localStorage.getItem(LS_SNAPSHOT)
    if (!raw) return null
    envelope = JSON.parse(raw) as Envelope
  } catch {
    return null
  }

  if (!envelope || envelope.v !== VERSION || !envelope.state) return null
  if (vin && envelope.vin && envelope.vin !== vin) {
    clearSnapshot()
    return null
  }

  const fetchedAt = new Date(envelope.fetchedAt)
  if (Number.isNaN(fetchedAt.getTime())) return null

  const reported = envelope.state.reportedAt ? new Date(envelope.state.reportedAt) : null

  return {
    fetchedAt,
    state: {
      ...envelope.state,
      reportedAt: reported && !Number.isNaN(reported.getTime()) ? reported : null,
    },
  }
}
