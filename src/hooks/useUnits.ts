import { useSyncExternalStore } from 'react'
import { UNITS_CHANGED, getUnits, type UnitPreferences } from '../units'

function subscribe(onChange: () => void): () => void {
  window.addEventListener(UNITS_CHANGED, onChange)
  // Also react to a change made in another tab or window.
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(UNITS_CHANGED, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/**
 * Unit preferences, live. getUnits() returns a cached object that is only
 * replaced when preferences change, so useSyncExternalStore sees a stable
 * snapshot and does not loop.
 */
export function useUnits(): UnitPreferences {
  return useSyncExternalStore(subscribe, getUnits, getUnits)
}
