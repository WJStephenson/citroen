/* eslint-env serviceworker */
/**
 * Service worker for the ë-C4 PWA.
 *
 * Two strategies only, per the design doc (§3.3):
 *   - App shell (HTML / CSS / JS / icons): CACHE-FIRST, for sub-second launch.
 *   - Everything under /api/*          : NETWORK-ONLY, so vehicle telemetry and
 *                                        commands are never served from a cache.
 *
 * `__SW_BUILD__` is replaced with a build timestamp by vite.config.ts at build
 * time, which rotates the cache name and evicts the previous shell.
 */

const BUILD = '__SW_BUILD__'
const SHELL_CACHE = `ec4-shell-${BUILD}`
const ASSET_CACHE = `ec4-assets-${BUILD}`

// Only files with stable, unhashed names belong here. Hashed build output under
// /assets/ is cached lazily on first use instead.
const SHELL_URLS = [
  '/',
  '/index.html',
  '/offline.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/favicon.svg',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      // Individually, so one 404 cannot fail the whole install.
      await Promise.all(
        SHELL_URLS.map((url) =>
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {}),
        ),
      )
    })(),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, ASSET_CACHE])
      const names = await caches.keys()
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

// The UI calls this when the user accepts an update prompt.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting()
})

const isApiRequest = (url) => url.pathname === '/api' || url.pathname.startsWith('/api/')

/** Cache-first: serve the cached copy, and refresh it in the background. */
async function cacheFirst(request, cacheName, { revalidate }) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request, { ignoreSearch: false })

  // The put is awaited, not fired off. notifyIfShellChanged reads the entry
  // back out of the cache to compare it against what was served, and an
  // un-awaited put is a race that read loses silently: it returns the *old*
  // body, the two compare equal, and the "new version is ready" notice never
  // appears — leaving the app pinned to a stale shell until some later launch
  // happens to win the same race.
  const network = fetch(request)
    .then(async (response) => {
      if (response.ok && response.type === 'basic') await cache.put(request, response.clone())
      return response
    })
    .catch(() => undefined)

  if (cached) {
    if (revalidate) network.then(() => notifyIfShellChanged(request, cached, cache))
    return cached
  }
  return (await network) ?? Response.error()
}

/**
 * index.html is cache-first, which would otherwise pin an old build forever.
 * Compare the freshly-fetched copy against the cached one and tell open clients
 * a newer shell is available so they can offer a reload.
 */
async function notifyIfShellChanged(request, cached, cache) {
  const updated = await cache.match(request)
  // cache.match always mints a fresh Response, so the bodies are the only
  // thing that can say whether this is the same shell.
  if (!updated) return
  const [a, b] = await Promise.all([cached.clone().text(), updated.clone().text()])
  if (a === b) return
  const clients = await self.clients.matchAll({ type: 'window' })
  for (const client of clients) client.postMessage({ type: 'SHELL_UPDATED' })
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // NETWORK-ONLY. Not cached, not retried, not stale. A wake-up command that
  // silently resolved from cache would be worse than a visible failure.
  if (isApiRequest(url)) {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(
            JSON.stringify({ error: 'offline', message: 'No connection to the bridge.' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          ),
      ),
    )
    return
  }

  // Navigations resolve to the cached shell; the SPA renders instantly and
  // fetches live state itself.
  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        const response = await cacheFirst(
          new Request('/index.html', { credentials: 'same-origin' }),
          SHELL_CACHE,
          { revalidate: true },
        )
        if (response && response.ok) return response
        return (await caches.match('/offline.html')) ?? Response.error()
      })(),
    )
    return
  }

  // Hashed build assets are immutable: cache-first with no revalidation.
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE, { revalidate: false }))
    return
  }

  if (SHELL_URLS.includes(url.pathname)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE, { revalidate: true }))
  }
})

/**
 * Charging notifications ("started", "finished"). The push itself is sent by
 * deploy/charge_notify.py, which polls the bridge independently of any tab
 * being open, and which decides *which* phones get which of the two — this
 * handler only has to render whatever payload arrives. A malformed or empty payload still has to produce a notification:
 * Chrome revokes the push permission for a site that gets a push and shows
 * nothing for it ("silent push").
 */
self.addEventListener('push', (event) => {
  let payload = {}
  try {
    if (event.data) payload = event.data.json()
  } catch {
    // Non-JSON payload: fall through to the fallback text below.
  }

  const title = payload.title || 'Charging update'
  const options = {
    body: payload.body || 'The car has something new to report.',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: payload.tag || 'charge-status',
    // A later push about the same session replaces the earlier one on
    // screen rather than stacking — see `tag` above — but should still
    // re-alert, since the ones that matter (finished charging) are rare
    // and easy to miss silently.
    renotify: true,
    data: { url: payload.url || '/' },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

/** Focuses an already-open tab instead of opening a second one. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl = event.notification.data?.url || '/'
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      const existing = clients.find((client) => new URL(client.url).origin === self.location.origin)
      if (existing) {
        await existing.focus()
        return
      }
      await self.clients.openWindow(targetUrl)
    })(),
  )
})
