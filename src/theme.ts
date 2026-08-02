/**
 * Light/dark theme, set from Settings. Defaults to dark — the manifest and
 * status-bar chrome are tuned for it — and light is an explicit opt-in
 * rather than following the OS, so the choice survives a system-theme change
 * mid-session without the app repainting under the user.
 */

export type Theme = 'dark' | 'light'

const LS_THEME = 'ec4.theme'

/** Fired on change so open views re-render without a reload. */
export const THEME_CHANGED = 'ec4:theme-changed'

export function getTheme(): Theme {
  return localStorage.getItem(LS_THEME) === 'light' ? 'light' : 'dark'
}

/** Reflects the theme onto the document so CSS variables and the status-bar
 * chrome both pick it up — called on boot (see index.html) and on change. */
export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', theme === 'light' ? '#f2f2f4' : '#121212')
}

export function setTheme(theme: Theme): void {
  localStorage.setItem(LS_THEME, theme)
  applyTheme(theme)
  window.dispatchEvent(new Event(THEME_CHANGED))
}
