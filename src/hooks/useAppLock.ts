import { useCallback, useEffect, useRef, useState } from 'react'
import { LOCK_GRACE_MS } from '../config'
import { configuredMethod, type LockMethod } from '../lock/credentials'

export interface AppLock {
  method: LockMethod
  locked: boolean
  unlock: () => void
  /** Re-read enrolment after the user sets up or removes a lock in Settings. */
  refreshMethod: () => void
}

/**
 * Locks the UI on cold start, and again whenever the app has been backgrounded
 * for longer than the grace period (design doc §3.3: verification "on app
 * foregrounding"). A short glance at a notification should not force a re-scan.
 */
export function useAppLock(): AppLock {
  const [method, setMethod] = useState<LockMethod>(() => configuredMethod())
  const [locked, setLocked] = useState(() => configuredMethod() !== 'none')
  const hiddenSince = useRef<number | null>(null)

  const unlock = useCallback(() => setLocked(false), [])
  const refreshMethod = useCallback(() => {
    const next = configuredMethod()
    setMethod(next)
    if (next === 'none') setLocked(false)
  }, [])

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenSince.current = Date.now()
        return
      }
      const away = hiddenSince.current ? Date.now() - hiddenSince.current : 0
      hiddenSince.current = null
      if (method !== 'none' && away > LOCK_GRACE_MS) setLocked(true)
    }

    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [method])

  return { method, locked: method !== 'none' && locked, unlock, refreshMethod }
}
