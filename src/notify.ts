/**
 * Status notification — the only glanceable surface Android gives a PWA.
 *
 * There is no home-screen widget API for web apps on Android (the `widgets`
 * manifest member is Windows/Edge only), and the Badging API that would put a
 * number on the launcher icon is not implemented in Chrome for Android. A
 * service-worker notification with a fixed `tag` is what remains: it sits in
 * the shade and on the lock screen, and re-showing it with the same tag
 * replaces it in place rather than stacking.
 *
 * It is updated from two places:
 *
 *   - the app, on every successful poll, whenever it is open;
 *   - the service worker's `periodicsync` handler, when the app is closed.
 *
 * The second one is genuinely best-effort. Chrome floors periodic sync at
 * ~12 hours regardless of the interval requested, needs the app installed, and
 * weights it by site engagement. Treat it as "the number will not be days old",
 * not as live telemetry. The notification always carries the timestamp of the
 * reading precisely because it can be stale.
 *
 * All formatting lives in public/sw.js, so the foreground and background paths
 * cannot drift apart. This module only decides *whether* to publish and hands
 * over the state.
 */

import type { VehicleState } from './api/types'
import { API_BASE, getVin } from './config'
import { getUnits } from './units'

const LS_KEY = 'ec4.statusNotification'

/** Must match STATUS_TAG / PERIODIC_TAG in public/sw.js. */
const PERIODIC_TAG = 'ec4-status'

/**
 * Chrome will not fire periodicsync more often than every 12 hours whatever we
 * ask for, so asking for less just looks like a bug to the next reader.
 */
const PERIODIC_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000

interface PeriodicSyncManager {
  register(tag: string, options?: { minInterval: number }): Promise<void>
  unregister(tag: string): Promise<void>
}

/** Not in lib.dom yet — Chromium-only, behind no flag but unstandardised. */
type MaybePeriodicSync = ServiceWorkerRegistration & { periodicSync?: PeriodicSyncManager }

export interface NotifyResult {
  ok: boolean
  message: string
}

/**
 * Dev has no service worker at all (see sw-register.ts), and notifications are
 * only shown through a registration, so the feature genuinely cannot work
 * there. Reporting that honestly beats a toggle that silently does nothing.
 */
export function isSupported(): boolean {
  return 'serviceWorker' in navigator && 'Notification' in window && import.meta.env.PROD
}

export function isBlocked(): boolean {
  return 'Notification' in window && Notification.permission === 'denied'
}

export function isEnabled(): boolean {
  if (!('Notification' in window)) return false
  return localStorage.getItem(LS_KEY) === '1' && Notification.permission === 'granted'
}

function config() {
  return {
    enabled: isEnabled(),
    vin: getVin(),
    apiBase: API_BASE,
    distance: getUnits().distance,
  }
}

/**
 * The service worker owns both the notification and the stored config, so every
 * message carries the current config and the worker is the only writer.
 */
async function send(payload: { state?: VehicleState; asOf?: number }): Promise<void> {
  const registration = await navigator.serviceWorker.ready
  registration.active?.postMessage({ type: 'NOTIFY', config: config(), ...payload })
}

export async function enable(): Promise<NotifyResult> {
  if (!isSupported()) {
    return { ok: false, message: 'Needs the installed app over HTTPS — not available here.' }
  }

  // Chrome requires a user gesture for this, which is why it is wired to the
  // toggle rather than run on load.
  const permission =
    Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission

  if (permission !== 'granted') {
    return {
      ok: false,
      message: 'Notifications are blocked for this site. Allow them in the browser’s site settings.',
    }
  }

  localStorage.setItem(LS_KEY, '1')
  await send({})
  const background = await registerPeriodicSync()

  return {
    ok: true,
    message: background
      ? 'On. Updates whenever the app is open, and about twice a day in the background.'
      : 'On. Updates whenever the app is open — background refresh is unavailable on this device.',
  }
}

export async function disable(): Promise<void> {
  localStorage.removeItem(LS_KEY)
  if (!isSupported()) return

  // Sending the now-disabled config is what makes the worker close the
  // notification and stop its background refresh doing any work.
  await send({})

  const registration = (await navigator.serviceWorker.ready) as MaybePeriodicSync
  try {
    await registration.periodicSync?.unregister(PERIODIC_TAG)
  } catch {
    // Never registered, or unsupported. Nothing to undo.
  }
}

/** No-op unless the user has turned the notification on. */
export async function publishStatus(state: VehicleState, asOf: Date | null): Promise<void> {
  if (!isEnabled() || !isSupported()) return
  try {
    await send({ state, asOf: (asOf ?? new Date()).getTime() })
  } catch {
    // A notification that fails to update must never break the dashboard.
  }
}

/**
 * Returns whether background refresh is actually available, so the UI can say
 * so rather than implying an update cadence the device will not honour.
 */
async function registerPeriodicSync(): Promise<boolean> {
  try {
    const registration = (await navigator.serviceWorker.ready) as MaybePeriodicSync
    if (!registration.periodicSync) return false

    // Chrome grants this silently to installed apps with enough engagement, and
    // withholds it otherwise. There is no prompt to trigger.
    const status = await navigator.permissions.query({
      name: 'periodic-background-sync' as PermissionName,
    })
    if (status.state !== 'granted') return false

    await registration.periodicSync.register(PERIODIC_TAG, {
      minInterval: PERIODIC_MIN_INTERVAL_MS,
    })
    return true
  } catch {
    return false
  }
}
