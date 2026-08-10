import { useSyncExternalStore } from 'react'
import { TARIFF_CHANGED, getTariff, type Tariff } from '../tariff'

// One event covers both a change made here and one made in another tab: the
// tariff lives in the shared settings blob, and api/sharedSettings.ts
// republishes a cross-tab write of the mirror as this same event. Listening
// for `storage` directly here would only fire the subscriber — getTariff reads
// the blob's in-memory snapshot, which that event does not by itself refresh.
function subscribe(onChange: () => void): () => void {
  window.addEventListener(TARIFF_CHANGED, onChange)
  return () => window.removeEventListener(TARIFF_CHANGED, onChange)
}

/**
 * The electricity tariff, live — the history tile re-prices itself as soon as a
 * rate is edited in Settings, without waiting for the sheet to be saved.
 */
export function useTariff(): Tariff {
  return useSyncExternalStore(subscribe, getTariff, getTariff)
}
