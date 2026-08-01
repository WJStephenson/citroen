import { useEffect, useRef, useState } from 'react'

const TRIGGER_PX = 72
const MAX_PULL_PX = 120

/**
 * Pull-to-refresh for the standalone PWA.
 *
 * The doc makes manual refresh the primary way to get fresh telemetry, since
 * background polling is throttled to protect the 12V battery. Only engages when
 * the scroller is already at the top, so it never fights normal scrolling.
 *
 * Returns the live pull distance in px for the indicator to render against.
 */
export function usePullToRefresh(onRefresh: () => void | Promise<void>, enabled = true) {
  const [pull, setPull] = useState(0)
  const [armed, setArmed] = useState(false)
  const startY = useRef<number | null>(null)
  const handler = useRef(onRefresh)
  handler.current = onRefresh

  useEffect(() => {
    if (!enabled) return

    const atTop = () => window.scrollY <= 0

    const onTouchStart = (event: TouchEvent) => {
      startY.current = atTop() && event.touches.length === 1 ? (event.touches[0]?.clientY ?? null) : null
    }

    const onTouchMove = (event: TouchEvent) => {
      if (startY.current === null) return
      const y = event.touches[0]?.clientY ?? 0
      const delta = y - startY.current

      if (delta <= 0 || !atTop()) {
        setPull(0)
        setArmed(false)
        return
      }
      // Resistance curve: the pull decelerates as it approaches the maximum.
      const distance = Math.min(MAX_PULL_PX, delta ** 0.85)
      setPull(distance)
      setArmed(distance >= TRIGGER_PX)
    }

    const onTouchEnd = () => {
      if (armed) void handler.current()
      startY.current = null
      setPull(0)
      setArmed(false)
    }

    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: true })
    window.addEventListener('touchend', onTouchEnd)
    window.addEventListener('touchcancel', onTouchEnd)

    return () => {
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', onTouchEnd)
    }
  }, [armed, enabled])

  return { pull, armed, threshold: TRIGGER_PX }
}
