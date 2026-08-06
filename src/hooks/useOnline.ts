import { useSyncExternalStore } from 'react'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

const isOnline = () => navigator.onLine !== false

/**
 * Whether this device has a network connection.
 *
 * Worth saying out loud, because the app is useful without one: the dashboard
 * still shows the last reading (see api/snapshot.ts), so the difference
 * between "the bridge is broken" and "you are in a car park" is the difference
 * between something to fix and something to ignore.
 *
 * `navigator.onLine` only knows whether the device has *a* network, not
 * whether the bridge is reachable across it — a captive portal or a downed
 * tunnel both read as online. So this is used to explain a failure the app has
 * already had, never to predict one: requests are attempted regardless, and
 * api/client.ts raises its own 'offline' error kind when a fetch dies with the
 * radio already known to be down.
 */
export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, isOnline, () => true)
}
