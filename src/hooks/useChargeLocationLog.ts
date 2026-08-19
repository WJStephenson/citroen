import { useEffect, useRef } from 'react'
import type { VehicleState } from '../api/types'
import { recordChargeLocation } from '../chargeLocations'
import { getPollMinutes } from '../config'

/**
 * How many poll intervals may separate two readings and still be read as one
 * edge. Two consecutive polls are one interval apart; the slack absorbs a poll
 * that was late because the app was backgrounded across it.
 */
const EDGE_INTERVALS = 3

/**
 * Writes down where the car is on the poll where it is first seen charging,
 * so the charging history can show where each session happened — see
 * chargeLocations.ts for why it cannot be recovered afterwards.
 *
 * An edge, not a state: "the car is charging" is true for hours, and a
 * position taken at hour six is the same place but not the same fact. Two
 * conditions have to hold before a change counts as one.
 *
 *   - The reading before it has to have been a real one. `charging` is never
 *     applied optimistically by a command, so the value is always an
 *     observation, but the app opens on the last *stored* reading (see
 *     api/snapshot.ts) and that one can be days old.
 *   - And it has to have been recent. A stored reading of a car sitting
 *     unplugged on Tuesday says nothing about whether Saturday's charge began
 *     one minute or nine hours ago, and a recording that lands hours after the
 *     start falls outside the session and matches nothing.
 *
 * Both are enforced by comparing when the two readings were *fetched* rather
 * than by counting renders — a re-render of the same reading is not a poll,
 * and neither is an optimistic patch.
 *
 * The app is only ever a second pair of eyes here: it polls solely while it is
 * on screen, so most charges start with nothing running but the server-side
 * watcher. This is for the case where someone is standing at the car with the
 * dashboard open, which is exactly when they most want the charge recorded.
 */
export function useChargeLocationLog(state: VehicleState | null, fetchedAt: Date | null): void {
  const previous = useRef<{ readAt: number; charging: boolean } | null>(null)

  useEffect(() => {
    if (!state || !fetchedAt) return
    const readAt = fetchedAt.getTime()
    const last = previous.current
    if (last?.readAt === readAt) return // the same reading, re-rendered

    const charging = state.charging === 'charging'
    previous.current = { readAt, charging }

    if (!last || last.charging || !charging) return
    if (readAt - last.readAt > getPollMinutes() * 60_000 * EDGE_INTERVALS) return
    if (!state.location) return
    recordChargeLocation(state.location, readAt)
  }, [state, fetchedAt])
}
