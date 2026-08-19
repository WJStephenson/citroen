import { useSyncExternalStore } from 'react'
import { CHARGE_LOCATIONS_CHANGED, type ChargeLocation, getChargeLocations } from '../chargeLocations'

// One event covers a change made here and one made in another tab alike — see
// the note in useTariff.ts, which shares the blob and the reason.
function subscribe(onChange: () => void): () => void {
  window.addEventListener(CHARGE_LOCATIONS_CHANGED, onChange)
  return () => window.removeEventListener(CHARGE_LOCATIONS_CHANGED, onChange)
}

/**
 * Where the car was for each recorded charge, live — a charge that starts
 * while the history tile is open gets its map without waiting for a reload.
 */
export function useChargeLocations(): ChargeLocation[] {
  return useSyncExternalStore(subscribe, getChargeLocations, getChargeLocations)
}
