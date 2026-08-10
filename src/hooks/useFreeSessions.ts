import { useSyncExternalStore } from 'react'
import { FREE_SESSIONS_CHANGED, getFreeSessions } from '../freeSessions'

// One event covers a change made here and one made in another tab alike — see
// the note in useTariff.ts, which shares the blob and the reason.
function subscribe(onChange: () => void): () => void {
  window.addEventListener(FREE_SESSIONS_CHANGED, onChange)
  return () => window.removeEventListener(FREE_SESSIONS_CHANGED, onChange)
}

/**
 * Sessions marked free, live — the history tile re-prices itself as soon as
 * the toggle is tapped, without waiting for a reload.
 */
export function useFreeSessions(): number[] {
  return useSyncExternalStore(subscribe, getFreeSessions, getFreeSessions)
}
