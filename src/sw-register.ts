/**
 * Registers the service worker and surfaces shell updates.
 *
 * Not registered in dev: a cache-first worker in front of the Vite dev server
 * makes every edit look like it did nothing.
 */
let registrationError: string | null = null

/**
 * Why registration failed, if it did. Registration failing costs offline
 * launch and nothing else, so it stays non-fatal — but it also silently
 * disables push notifications, and a caller showing a permanently greyed-out
 * notifications toggle needs to be able to say why (see
 * push.ts::pushUnavailableReason).
 */
export function serviceWorkerRegistrationError(): string | null {
  return registrationError
}

export function registerServiceWorker(onUpdateAvailable: () => void): void {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return

  const start = () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
        registrationError = null
        registration.addEventListener('updatefound', () => {
          const installing = registration.installing
          if (!installing) return
          installing.addEventListener('statechange', () => {
            // controller present => this is an update, not a first install.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) {
              onUpdateAvailable()
            }
          })
        })
      })
      .catch((error: unknown) => {
        // Non-fatal, but no longer silent: swallowing this entirely meant a
        // worker that never registered was indistinguishable from one that
        // registered fine, from anywhere outside a debugger.
        registrationError = error instanceof Error ? error.message : String(error)
      })
  }

  /*
   * `load` may well have fired already. This runs from a React effect, and
   * React flushes passive effects asynchronously after paint — on a warm
   * cache, with the shell's few subresources served from disk, that lands
   * *after* the load event. A listener added then waits for an event that
   * has already happened, so the worker never registers at all: no offline
   * launch, and no push notifications, with nothing logged either way.
   */
  if (document.readyState === 'complete') start()
  else window.addEventListener('load', start, { once: true })

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data?.type === 'SHELL_UPDATED') onUpdateAvailable()
  })

  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  })
}

export function applyUpdate(): void {
  void navigator.serviceWorker.getRegistration().then((registration) => {
    if (registration?.waiting) registration.waiting.postMessage({ type: 'SKIP_WAITING' })
    else window.location.reload()
  })
}
