/**
 * The settings shared by everyone who controls this car — VIN, poll interval,
 * tariff, dashboard layout, and the charge start/stop/limit hints — synced
 * with the settings-store sidecar (see deploy/settings_store.py) instead of
 * living in each browser's own localStorage.
 *
 * This module only owns the blob's transport: fetching it, mirroring it to
 * localStorage so the app still opens instantly offline, and pushing changes
 * back. It deliberately knows nothing about what any individual field means —
 * config.ts, tariff.ts, useWidgetOrder.ts and the charge widgets each parse
 * their own slice defensively, the same way api/client.ts never trusts the
 * bridge's own payload shape rather than validating it here first.
 */

const SETTINGS_BASE = import.meta.env.VITE_SETTINGS_BASE ?? '/settings'
const REQUEST_TIMEOUT_MS = 10_000
const LS_MIRROR = 'ec4.sharedSettings'
/** Foregrounding the app re-syncs at most this often. */
const REFRESH_THROTTLE_MS = 60_000

export type SharedSettingsBlob = Record<string, unknown>

/** Fired whenever the local mirror changes, whether from this device writing
    it or a fresh read landing from the server. */
export const SHARED_SETTINGS_CHANGED = 'ec4:shared-settings-changed'

function readMirror(): SharedSettingsBlob {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LS_MIRROR) ?? '{}')
    return parsed && typeof parsed === 'object' ? (parsed as SharedSettingsBlob) : {}
  } catch {
    return {}
  }
}

let cache: SharedSettingsBlob = readMirror()

function commit(next: SharedSettingsBlob): void {
  cache = next
  localStorage.setItem(LS_MIRROR, JSON.stringify(next))
  window.dispatchEvent(new Event(SHARED_SETTINGS_CHANGED))
}

/** Synchronous snapshot — the local mirror, which is why every read in this
    app can stay synchronous even though the source of truth is a network
    call away. */
export function getSharedSettings(): SharedSettingsBlob {
  return cache
}

async function request(method: 'GET' | 'PUT', body?: SharedSettingsBlob): Promise<SharedSettingsBlob | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`${SETTINGS_BASE}/`, {
      method,
      // Cloudflare Access's cookie has to ride along, same as api/client.ts.
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    })
    if (!response.ok) return null
    const json: unknown = await response.json()
    return json && typeof json === 'object' ? (json as SharedSettingsBlob) : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Pulls the latest blob and updates the local mirror if the store answered.
 * A failed or offline attempt silently keeps whatever was last known — the
 * same stale-but-usable stance the service worker takes with the app shell.
 */
export async function refreshSharedSettings(): Promise<void> {
  const remote = await request('GET')
  if (remote) commit(remote)
}

/**
 * Merges `patch` into the shared blob: applied to the local mirror at once,
 * so this device's own UI reflects it immediately, and sent to the store. A
 * device that is briefly offline keeps its own change; the next successful
 * read or write from any device reconciles it. Good enough for a household
 * sharing one car — not built for simultaneous editors.
 *
 * Resolves true once the store has taken the change. Most callers have no use
 * for that and may ignore it — a tariff edit or a widget reorder is allowed to
 * settle whenever it settles. A caller that is about to *reload the page*
 * cannot: navigation aborts an in-flight fetch, and the reload's own GET then
 * overwrites the local mirror with the server's older blob, so the setting
 * appears to save and then silently reverts. That is what the Settings sheet
 * awaits before reloading.
 *
 * The store answers a PUT with the whole merged blob, and that answer is
 * committed in place of the optimistic one: it is the reconciled truth,
 * including any field another phone changed in the meantime.
 */
export async function patchSharedSettings(patch: SharedSettingsBlob): Promise<boolean> {
  commit({ ...cache, ...patch })
  const merged = await request('PUT', patch)
  if (merged) commit(merged)
  return merged !== null
}

/**
 * Fetches once at boot, then again whenever the app is foregrounded, so a
 * change another phone made while this one was asleep shows up without
 * needing a reload. Throttled the same way useVehicle throttles its own
 * foreground refetch, for the same reason: repeated foregrounding must not
 * mean repeated network calls.
 */
export function startSharedSettingsSync(): void {
  let lastRefresh = 0

  const refresh = () => {
    lastRefresh = Date.now()
    void refreshSharedSettings()
  }

  refresh()

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (Date.now() - lastRefresh > REFRESH_THROTTLE_MS) refresh()
  })
}
