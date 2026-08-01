/**
 * Registers the service worker and surfaces shell updates.
 *
 * Not registered in dev: a cache-first worker in front of the Vite dev server
 * makes every edit look like it did nothing.
 */
export function registerServiceWorker(onUpdateAvailable: () => void): void {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((registration) => {
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
      .catch(() => {
        // A failed registration costs offline launch, not function. Carry on.
      })
  })

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
