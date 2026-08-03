import { useCallback, useEffect, useRef, useState } from 'react'

/** Past this the sheet is going, however slowly the finger was moving. */
const DISMISS_PX = 96
/** Or past this speed, however short the drag — a flick should throw it away. */
const FLICK_PX_PER_MS = 0.5
/** Below this the gesture has not committed to being a drag yet. */
const SLOP_PX = 4

/**
 * Drag a bottom sheet down to close it.
 *
 * The grip at the top of the sheet has always looked like a handle. It was not
 * one — nothing was listening — so a downward drag fell through to the window,
 * where pull-to-refresh picked it up and hauled the dashboard down behind the
 * backdrop. That is the bug this fixes; App gating the pull while the sheet is
 * open is the other half of it.
 *
 * A drag starts from the grip always, and from the sheet's body only when it is
 * scrolled to the top — otherwise closing the sheet and scrolling its content
 * would be the same gesture, and the one you got would depend on where the
 * finger happened to land.
 *
 * touchmove is registered non-passive so the drag can preventDefault: the sheet
 * cannot carry `touch-action: none` (its body has to scroll), and without this
 * the page rubber-bands underneath the drag on iOS.
 */
export function useSheetDismiss(onClose: () => void) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const [offset, setOffset] = useState(0)
  const [dragging, setDragging] = useState(false)

  const drag = useRef<{
    pointerId: number
    startY: number
    /** Set once the finger has passed the slop and the gesture is ours. */
    live: boolean
    lastY: number
    lastAt: number
    velocity: number
  } | null>(null)

  const close = useRef(onClose)
  close.current = onClose

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (drag.current) return

    const sheet = sheetRef.current
    const fromGrip = (event.target as HTMLElement).closest('.sheet-grip') !== null
    if (!fromGrip && (sheet?.scrollTop ?? 0) > 0) return

    // Never steal the gesture from something being operated: a range slider is
    // dragged, and a text field wants its own caret handling.
    if ((event.target as HTMLElement).closest('input, button, select, textarea')) return

    drag.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      live: false,
      lastY: event.clientY,
      lastAt: event.timeStamp,
      velocity: 0,
    }
  }, [])

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return

    const travelled = event.clientY - current.startY

    if (!current.live) {
      // Upward, or still inside the slop: leave it alone. An upward drag at the
      // top of the sheet is someone trying to scroll content that is already at
      // its top, which must stay a scroll.
      if (travelled < SLOP_PX) return
      current.live = true
      event.currentTarget.setPointerCapture(event.pointerId)
      setDragging(true)
    }

    const elapsed = event.timeStamp - current.lastAt
    if (elapsed > 0) current.velocity = (event.clientY - current.lastY) / elapsed
    current.lastY = event.clientY
    current.lastAt = event.timeStamp

    // Resistance above the resting position, so the sheet cannot be dragged up
    // off the bottom of the screen.
    setOffset(travelled > 0 ? travelled : travelled / 4)
  }, [])

  const onPointerEnd = useCallback((event: React.PointerEvent<HTMLElement>) => {
    const current = drag.current
    if (!current || event.pointerId !== current.pointerId) return
    drag.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!current.live) return

    setDragging(false)
    const travelled = event.clientY - current.startY
    if (travelled > DISMISS_PX || current.velocity > FLICK_PX_PER_MS) {
      // Left where it is; the backdrop's own exit carries it the rest of the
      // way, and resetting to 0 first would snap it back up before it went.
      close.current()
      return
    }
    setOffset(0)
  }, [])

  /* Hold the page still under a live drag. Registered here rather than as a
     React prop because React attaches its listeners passively, and a passive
     listener cannot preventDefault. */
  useEffect(() => {
    const sheet = sheetRef.current
    if (!sheet) return
    const block = (event: TouchEvent) => {
      if (drag.current?.live) event.preventDefault()
    }
    sheet.addEventListener('touchmove', block, { passive: false })
    return () => sheet.removeEventListener('touchmove', block)
  }, [])

  return {
    sheetRef,
    offset,
    dragging,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
    },
  }
}
