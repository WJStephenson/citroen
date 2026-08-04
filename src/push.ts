/**
 * Web Push subscription management for "notify me when charging finishes".
 *
 * The subscription itself is per-device — each browser mints its own unique
 * PushSubscription — but *who to notify* is shared across every phone
 * controlling the car, the same way the tariff and free sessions are (see
 * api/sharedSettings.ts): whether someone hears about the charge finishing
 * is a property of the car, not of any one phone.
 *
 * The watching itself happens server-side, in deploy/charge-notify/watcher.py,
 * independent of any tab being open. It has to: useVehicle.ts's poll loop
 * deliberately suspends whenever the app is backgrounded, and a charge
 * finishing overnight is exactly when nobody has the tab open.
 */

import { SHARED_SETTINGS_CHANGED, getSharedSettings, patchSharedSettings } from './api/sharedSettings'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? ''

export const PUSH_SUBSCRIPTIONS_CHANGED = SHARED_SETTINGS_CHANGED

export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && VAPID_PUBLIC_KEY !== ''
}

/** The one non-boilerplate step in subscribing: the key has to be bytes, not base64url text. */
function applicationServerKey(base64url: string): Uint8Array {
  const padding = '='.repeat((4 - (base64url.length % 4)) % 4)
  const base64 = (base64url + padding).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(base64)
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

interface StoredSubscription {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

function isStoredSubscription(value: unknown): value is StoredSubscription {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredSubscription).endpoint === 'string' &&
    typeof (value as StoredSubscription).keys?.p256dh === 'string' &&
    typeof (value as StoredSubscription).keys?.auth === 'string'
  )
}

function storedSubscriptions(): StoredSubscription[] {
  const raw = getSharedSettings().pushSubscriptions
  return Array.isArray(raw) ? raw.filter(isStoredSubscription) : []
}

/** This browser's live subscription, if it has one — independent of what's in the shared list. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null
  const registration = await navigator.serviceWorker.ready
  return registration.pushManager.getSubscription()
}

/**
 * Requests notification permission and subscribes this browser, adding it
 * to the shared list watcher.py reads. A device re-subscribing (its old
 * endpoint may have rotated) replaces its own prior entry by matching the
 * *new* endpoint against nothing — the caller is expected to have already
 * unsubscribed a stale one, which the PushManager does implicitly on
 * subscribe() if one already existed for this registration.
 *
 * Returns false rather than throwing on a denied/dismissed permission
 * prompt — that is an ordinary outcome the caller shows as "off", not an
 * error.
 */
export async function subscribeToPush(): Promise<boolean> {
  if (!isPushSupported()) return false
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false

  const registration = await navigator.serviceWorker.ready
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: applicationServerKey(VAPID_PUBLIC_KEY),
  })
  const json = subscription.toJSON() as StoredSubscription
  const next = [...storedSubscriptions().filter((s) => s.endpoint !== json.endpoint), json]
  patchSharedSettings({ pushSubscriptions: next })
  return true
}

/** Unsubscribes this browser and drops it from the shared list. */
export async function unsubscribeFromPush(): Promise<void> {
  const subscription = await currentSubscription()
  if (!subscription) return
  const endpoint = subscription.endpoint
  await subscription.unsubscribe()
  patchSharedSettings({ pushSubscriptions: storedSubscriptions().filter((s) => s.endpoint !== endpoint) })
}
