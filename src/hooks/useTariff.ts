import { useSyncExternalStore } from 'react'
import { TARIFF_CHANGED, getTariff, type Tariff } from '../tariff'

function subscribe(onChange: () => void): () => void {
  window.addEventListener(TARIFF_CHANGED, onChange)
  // Also react to a change made in another tab or window.
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(TARIFF_CHANGED, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/**
 * The electricity tariff, live — the history tile re-prices itself as soon as a
 * rate is edited in Settings, without waiting for the sheet to be saved.
 */
export function useTariff(): Tariff {
  return useSyncExternalStore(subscribe, getTariff, getTariff)
}
