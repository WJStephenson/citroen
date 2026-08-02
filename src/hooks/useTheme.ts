import { useSyncExternalStore } from 'react'
import { THEME_CHANGED, getTheme, type Theme } from '../theme'

function subscribe(onChange: () => void): () => void {
  window.addEventListener(THEME_CHANGED, onChange)
  // Also react to a change made in another tab or window.
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(THEME_CHANGED, onChange)
    window.removeEventListener('storage', onChange)
  }
}

/** The active theme, live — re-renders when Settings changes it. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, getTheme, getTheme)
}
