import { useSyncExternalStore } from 'react'
import { FREE_SESSIONS_CHANGED, getFreeSessions } from '../freeSessions'

function subscribe(onChange: () => void): () => void {
  window.addEventListener(FREE_SESSIONS_CHANGED, onChange)
  // Also react to a change made in another tab or window.
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(FREE_SESSIONS_CHANGED, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/**
 * Sessions marked free, live — the history tile re-prices itself as soon as
 * the toggle is tapped, without waiting for a reload.
 */
export function useFreeSessions(): number[] {
  return useSyncExternalStore(subscribe, getFreeSessions, getFreeSessions)
}
