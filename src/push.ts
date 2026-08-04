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
import { serviceWorkerRegistrationError } from './sw-register'

const VAPID_PUBLIC_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY ?? ''
/** How long to wait for a service worker to report itself active before giving up and saying so. */
const SW_READY_TIMEOUT_MS = 8_000

export const PUSH_SUBSCRIPTIONS_CHANGED = SHARED_SETTINGS_CHANGED

export type PushUnavailableReason =
  | 'insecure-context'
  | 'no-service-worker-api'
  | 'no-push-manager'
  | 'no-vapid-key'
  | 'no-registration'
  | 'not-activating'

/**
 * Distinguishes *why* push is unavailable, rather than a single boolean —
 * "the switch is grey" was reported once with no way to tell, from outside
 * a debugger, whether that meant an unsupported browser, a missing build-time
 * key, or a service worker that registered but never reached "active" (the
 * one case a plain feature-detect can't see: register() succeeding is not
 * activating, and a worker stuck installing looks identical to "supported").
 */
export async function pushUnavailableReason(): Promise<PushUnavailableReason | null> {
  if (!window.isSecureContext) return 'insecure-context'
  if (!('serviceWorker' in navigator)) return 'no-service-worker-api'
  if (!('PushManager' in window)) return 'no-push-manager'
  if (VAPID_PUBLIC_KEY === '') return 'no-vapid-key'

  const registration = await navigator.serviceWorker.getRegistration('/')
  if (!registration) return 'no-registration'

  const ready = await Promise.race([
    navigator.serviceWorker.ready.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), SW_READY_TIMEOUT_MS)),
  ])
  return ready ? null : 'not-activating'
}

const BASE_MESSAGES: Record<PushUnavailableReason, string> = {
  'insecure-context':
    'This page was opened over plain HTTP. Notifications need HTTPS — reopen it from the usual https:// link.',
  'no-service-worker-api': "This browser doesn't support service workers, so push notifications can't work here.",
  'no-push-manager':
    "This browser doesn't support Web Push. On iOS, Add to Home Screen first — Safari only allows push from an installed app, not a browser tab.",
  'no-vapid-key':
    'This build has no VAPID key configured — deploy/charge_notify.py needs setting up server-side, and VITE_VAPID_PUBLIC_KEY needs to be in the build that produced this app. See deploy/DEPLOYMENT.md §2c.',
  'no-registration':
    "The app's service worker isn't registered yet. Close the app fully and reopen it — if this persists after that, the registration is failing rather than racing.",
  'not-activating':
    "The service worker registered but never finished activating. Force-close the app, reopen it, and check for a chrome://serviceworker-internals entry for this site if it happens again — that's not something reopening the app alone can usually fix.",
}

/**
 * The reason, plus the underlying registration error when there is one —
 * "never registered" is the symptom, and the browser's own message about
 * *why* is the only thing that distinguishes a fetch/MIME/scope failure
 * from a worker that simply hasn't been given a chance to register yet.
 */
export function pushUnavailableMessage(reason: PushUnavailableReason): string {
  const base = BASE_MESSAGES[reason]
  if (reason !== 'no-registration') return base
  const detail = serviceWorkerRegistrationError()
  return detail ? `${base} The browser reported: ${detail}` : base
}

export function isPushSupported(): boolean {
  return VAPID_PUBLIC_KEY !== '' && 'serviceWorker' in navigator && 'PushManager' in window
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

/**
 * This browser's live subscription, if it has one — independent of what's
 * in the shared list. Null on a service worker that never activates, same
 * as "no subscription", rather than hanging forever on `.ready` — the
 * caller cannot tell those apart from here, but pushUnavailableReason() can,
 * and is what the Settings sheet uses to explain a stuck switch.
 */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), SW_READY_TIMEOUT_MS)),
  ])
  if (!registration) return null
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
