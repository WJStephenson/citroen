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

// Deliberately unversioned: this holds the status-notification config written
// by the app, which must survive a deploy. It is evicted by name below.
const CONFIG_CACHE = 'ec4-config'
const CONFIG_URL = '/__ec4/notify-config'

/** One notification, replaced in place. Must match PERIODIC_TAG in src/notify.ts. */
const STATUS_TAG = 'ec4-status'

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
      const keep = new Set([SHELL_CACHE, ASSET_CACHE, CONFIG_CACHE])
      const names = await caches.keys()
      await Promise.all(names.filter((n) => !keep.has(n)).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

self.addEventListener('message', (event) => {
  // The UI calls this when the user accepts an update prompt.
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
    return
  }

  // Status notification. The message always carries the current config, so the
  // worker is the only writer of it and the foreground and background paths
  // never disagree about the VIN or the distance unit.
  if (event.data?.type === 'NOTIFY') {
    const { config, state, asOf } = event.data
    event.waitUntil(
      (async () => {
        await writeConfig(config)
        if (!config?.enabled) {
          await closeStatus()
          return
        }
        if (state) await showStatus(state, config.distance, asOf)
      })(),
    )
  }
})

/* -------------------------------------------------------------------------
 * Status notification
 *
 * Android gives a PWA no home-screen widget and no icon badge, so a tagged
 * notification is the only surface that can show charge state without opening
 * the app. See src/notify.ts for why it lives here rather than in the bundle:
 * the background path below has to format identically to the foreground one,
 * and this file is served raw from public/ so the app cannot share code with
 * it in the other direction.
 * ---------------------------------------------------------------------- */

async function readConfig() {
  try {
    const cache = await caches.open(CONFIG_CACHE)
    const response = await cache.match(CONFIG_URL)
    return response ? await response.json() : null
  } catch {
    return null
  }
}

async function writeConfig(config) {
  if (!config) return
  const cache = await caches.open(CONFIG_CACHE)
  await cache.put(
    CONFIG_URL,
    new Response(JSON.stringify(config), {
      headers: { 'Content-Type': 'application/json' },
    }),
  )
}

const CHARGING_LABEL = {
  charging: 'Charging',
  'plugged-idle': 'Plugged in, not charging',
  finished: 'Charge complete',
  disconnected: 'Unplugged',
  failure: 'Charge failed',
  unknown: '',
}

const KM_PER_MILE = 1.609344

function formatRange(km, distance) {
  if (typeof km !== 'number') return null
  const value = distance === 'mi' ? km / KM_PER_MILE : km
  return `${Math.round(value).toLocaleString('en-GB')} ${distance === 'mi' ? 'mi' : 'km'}`
}

function formatRemaining(minutes) {
  if (typeof minutes !== 'number' || minutes <= 0) return null
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes % 60)
  return hours > 0 ? `${hours}h ${rest}m left` : `${rest} min left`
}

/**
 * The timestamp is not decoration. This notification can be hours old — the
 * background refresh below runs about twice a day — so a bare percentage would
 * be actively misleading.
 */
function statusText(state, distance, asOf) {
  const level = typeof state.battery === 'number' ? `${Math.round(state.battery)}%` : '—'
  const range = formatRange(state.range, distance)

  const parts = []
  const label = CHARGING_LABEL[state.charging] ?? ''
  if (label) parts.push(label)
  if (state.charging === 'charging') {
    const remaining = formatRemaining(state.chargingRemainingMinutes)
    if (remaining) parts.push(remaining)
  }
  if (asOf) {
    parts.push(
      `as of ${new Date(asOf).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
    )
  }

  return {
    title: range ? `${level} · ${range}` : level,
    body: parts.join(' · ') || 'No status yet',
  }
}

async function showStatus(state, distance, asOf) {
  const { title, body } = statusText(state, distance, asOf)
  await self.registration.showNotification(title, {
    body,
    tag: STATUS_TAG,
    icon: '/icons/icon-192.png',
    // This is a display surface, not an alert. Without silent + renotify:false
    // every 20-minute poll would buzz the phone, and the feature would last
    // about a day before being turned off.
    silent: true,
    renotify: false,
    requireInteraction: true,
    data: { url: '/' },
  })
}

async function closeStatus() {
  const existing = await self.registration.getNotifications({ tag: STATUS_TAG })
  for (const notification of existing) notification.close()
}

/**
 * A minimal mirror of api/client.ts::normalise — only the four fields the
 * notification shows. Kept deliberately small: if it needs more than this, the
 * right fix is a route on the bridge, not a second normaliser.
 */
const RAW_CHARGING_STATUS = {
  inprogress: 'charging',
  charging: 'charging',
  stopped: 'plugged-idle',
  disconnected: 'disconnected',
  finished: 'finished',
  failure: 'failure',
  quickcharge: 'charging',
}

function parseRemaining(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (!value) return null
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?/.exec(value)
  if (!match) {
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : null
  }
  return Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)
}

function fromRaw(raw) {
  const energy =
    raw.energy?.find((entry) => entry.type?.toLowerCase() === 'electric') ?? raw.energy?.[0]
  const status = energy?.charging?.status?.toLowerCase() ?? ''
  return {
    battery: typeof energy?.level === 'number' ? energy.level : null,
    range: typeof energy?.autonomy === 'number' ? energy.autonomy : null,
    charging: RAW_CHARGING_STATUS[status] ?? 'unknown',
    chargingRemainingMinutes: parseRemaining(energy?.charging?.remaining_time),
  }
}

/**
 * Background refresh, when the app is closed.
 *
 * Chrome floors periodicsync at roughly 12 hours however small an interval we
 * request, so this is "not days out of date", not live telemetry.
 *
 * from_cache=1 is not optional here. This fires on a timer with nobody
 * watching, and a timer-driven live read is exactly the pattern that holds the
 * car's ECUs awake and flattens the 12V battery (README, Battery safety). The
 * bridge's stored state costs the car nothing.
 */
async function refreshStatusFromBridge() {
  const config = await readConfig()
  if (!config?.enabled || !config.vin) return

  const base = config.apiBase ?? '/api'
  const url = `${base}/get_vehicleinfo/${encodeURIComponent(config.vin)}?from_cache=1`

  try {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) return
    // Cloudflare Access serves its login page as HTML with a 200. Overwriting a
    // good reading with a parse failure would be worse than leaving it alone.
    if (!(response.headers.get('content-type') ?? '').includes('json')) return

    const raw = await response.json()
    await showStatus(fromRaw(raw), config.distance, Date.now())
  } catch {
    // Offline, or the tunnel is down. The notification keeps its last value,
    // which is honest as long as the timestamp stays with it — and it does.
  }
}

self.addEventListener('periodicsync', (event) => {
  if (event.tag !== STATUS_TAG) return
  event.waitUntil(refreshStatusFromBridge())
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      for (const client of windows) {
        if (new URL(client.url).origin === self.location.origin) return client.focus()
      }
      return self.clients.openWindow('/')
    })(),
  )
})

const isApiRequest = (url) => url.pathname === '/api' || url.pathname.startsWith('/api/')

/** Cache-first: serve the cached copy, and refresh it in the background. */
async function cacheFirst(request, cacheName, { revalidate }) {
  const cache = await caches.open(cacheName)
  const cached = await cache.match(request, { ignoreSearch: false })

  const network = fetch(request)
    .then((response) => {
      if (response.ok && response.type === 'basic') cache.put(request, response.clone())
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
  if (!updated || updated === cached) return
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
