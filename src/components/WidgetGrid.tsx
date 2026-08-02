import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { useWidgetOrder } from '../hooks/useWidgetOrder'
import { CheckIcon } from './Icons'
import { WidgetShapeDefs } from './Widget'

export interface WidgetItem {
  id: string
  /** Named for the person moving it, not for the code — it is read aloud. */
  label: string
  /** Half-width tiles are square; full-width ones size to their content. */
  span?: 1 | 2
  node: ReactNode
}

interface Props {
  items: WidgetItem[]
  editing: boolean
  onEditingChange: (editing: boolean) => void
}

const LONG_PRESS_MS = 420
/**
 * Once the grid is already in edit mode a tile picks up almost at once — but
 * not instantly. The grid is taller than the screen, so some hold is what
 * leaves a plain swipe free to scroll the page instead of dragging whatever
 * tile happened to be under the thumb.
 */
const PICK_UP_MS = 150
/** Past this the gesture was a scroll, not a press. */
const CANCEL_PX = 10
const REORDER_COOLDOWN_MS = 130
/** Only the middle of a tile is a drop target, so neighbours can't ping-pong. */
const HIT_INSET = 0.18
/** Drag this close to a viewport edge and the page follows. */
const EDGE_PX = 96
const EDGE_SPEED_PX = 14

/**
 * Document-space geometry. Page coordinates rather than viewport ones, because
 * the page scrolls underneath a drag: in viewport space every box would shift
 * mid-gesture and the maths would have to unpick the scroll offset again.
 */
interface Box {
  left: number
  top: number
  width: number
  height: number
}

interface Drag {
  id: string
  pointerId: number
  /** Where the finger started and is now, both in page coordinates. */
  startX: number
  startY: number
  x: number
  y: number
  /** Where the tile sat when the drag began. */
  origin: Box
  /** Origin minus the tile's current slot — keeps it under the finger after a reorder. */
  fix: { x: number; y: number }
  lastReorder: number
}

/**
 * The dashboard: every section is a tile in a two-column grid, and a long press
 * puts the grid into edit mode where tiles can be dragged into a new order.
 *
 * Reordering is done on the array and animated with FLIP — the tiles stay in
 * normal grid flow, and after each reorder the ones that moved are snapped back
 * to where they were and released, so the browser animates the difference. The
 * alternative, absolutely positioning every tile, would mean reimplementing the
 * grid's own sizing by hand.
 *
 * Hit testing reads offsetLeft/offsetTop rather than getBoundingClientRect,
 * because those are immune to the transforms FLIP is mid-flight with: they
 * report where a tile has landed, not where it is currently being animated
 * from. The grid is the offsetParent (position: relative) and has no border or
 * padding, so its own rect is the origin for all of them.
 */
export function WidgetGrid({ items, editing, onEditingChange }: Props) {
  const ids = items.map((item) => item.id)
  const { order, save, reset, customised } = useWidgetOrder(ids)

  // Live order during a drag. Committed to storage on drop, so a gesture that
  // crosses ten tiles writes to localStorage once rather than ten times.
  const [live, setLive] = useState<string[] | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)

  const resolved = live ?? order
  const byId = new Map(items.map((item) => [item.id, item]))

  const gridRef = useRef<HTMLDivElement>(null)
  const cells = useRef(new Map<string, HTMLDivElement>())
  const boxes = useRef(new Map<string, Box>())
  const press = useRef<{ id: string; pointerId: number; x: number; y: number; timer: number } | null>(null)
  const drag = useRef<Drag | null>(null)

  // Read by window-level listeners, which close over the render they were
  // created in.
  const orderRef = useRef(resolved)
  orderRef.current = resolved
  const liveRef = useRef(live)
  liveRef.current = live

  const measure = useCallback((): Map<string, Box> => {
    const next = new Map<string, Box>()
    const grid = gridRef.current
    if (!grid) return next
    const rect = grid.getBoundingClientRect()
    const originX = rect.left + window.scrollX
    const originY = rect.top + window.scrollY
    for (const [id, el] of cells.current) {
      if (!el.isConnected) {
        cells.current.delete(id)
        continue
      }
      next.set(id, {
        left: originX + el.offsetLeft,
        top: originY + el.offsetTop,
        width: el.offsetWidth,
        height: el.offsetHeight,
      })
    }
    return next
  }, [])

  const paintDrag = useCallback(() => {
    const current = drag.current
    if (!current) return
    const el = cells.current.get(current.id)
    if (!el) return
    const x = current.x - current.startX + current.fix.x
    const y = current.y - current.startY + current.fix.y
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.04)`
  }, [])

  /* FLIP. Runs whenever the order changes: invert every tile that moved back to
     where it was, flush, then release so the transition plays it forward. */
  const orderKey = resolved.join('|')
  useLayoutEffect(() => {
    const before = boxes.current
    const after = measure()
    boxes.current = after

    const current = drag.current
    if (current) {
      const slot = after.get(current.id)
      if (slot) {
        current.fix = { x: current.origin.left - slot.left, y: current.origin.top - slot.top }
      }
      paintDrag()
    }

    if (before.size === 0) return

    const moved: HTMLDivElement[] = []
    for (const [id, box] of after) {
      if (id === current?.id) continue
      const was = before.get(id)
      if (!was) continue
      const dx = was.left - box.left
      const dy = was.top - box.top
      if (dx === 0 && dy === 0) continue
      const el = cells.current.get(id)
      if (!el) continue
      el.style.transition = 'none'
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
      moved.push(el)
    }
    if (moved.length === 0) return

    // Force the inverted transforms to be computed before releasing them;
    // without the flush both style changes collapse into one and nothing
    // animates.
    void gridRef.current?.offsetHeight
    for (const el of moved) {
      el.style.transition = ''
      el.style.transform = ''
    }
  }, [orderKey, measure, paintDrag])

  const moveTo = useCallback((id: string, index: number) => {
    const list = orderRef.current
    const from = list.indexOf(id)
    const to = Math.min(list.length - 1, Math.max(0, index))
    if (from < 0 || from === to) return null
    const next = [...list]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved as string)
    return next
  }, [])

  const beginDrag = useCallback(
    (id: string, pointerId: number, clientX: number, clientY: number) => {
      // Data may have changed the layout since the last measure; start from
      // what is actually on screen.
      boxes.current = measure()
      const origin = boxes.current.get(id)
      if (!origin) return

      drag.current = {
        id,
        pointerId,
        startX: clientX + window.scrollX,
        startY: clientY + window.scrollY,
        x: clientX + window.scrollX,
        y: clientY + window.scrollY,
        origin,
        fix: { x: 0, y: 0 },
        lastReorder: 0,
      }

      const el = cells.current.get(id)
      if (el) el.style.transition = 'none'
      navigator.vibrate?.(14)
      onEditingChange(true)
      setDragId(id)
      paintDrag()
    },
    [measure, onEditingChange, paintDrag],
  )

  const cancelPress = useCallback(() => {
    if (!press.current) return
    window.clearTimeout(press.current.timer)
    press.current = null
  }, [])

  /* Stable, so React never detaches a tile's ref mid-drag. The id travels on a
     data attribute because the cleanup call arrives with null and no context;
     stale entries are swept in measure() by their isConnected flag. */
  const setCell = useCallback((el: HTMLDivElement | null) => {
    const id = el?.dataset.widgetId
    if (el && id) cells.current.set(id, el)
  }, [])

  const onCellPointerDown = (event: ReactPointerEvent<HTMLDivElement>, id: string) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    if (drag.current) return

    const { pointerId, clientX, clientY } = event
    cancelPress()
    press.current = {
      id,
      pointerId,
      x: clientX,
      y: clientY,
      timer: window.setTimeout(
        () => {
          press.current = null
          beginDrag(id, pointerId, clientX, clientY)
        },
        editing ? PICK_UP_MS : LONG_PRESS_MS,
      ),
    }
  }

  const onCellPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const waiting = press.current
    if (!waiting || event.pointerId !== waiting.pointerId) return
    if (Math.hypot(event.clientX - waiting.x, event.clientY - waiting.y) > CANCEL_PX) cancelPress()
  }

  /* Everything below only exists while a tile is actually in hand. */
  useEffect(() => {
    if (!dragId) return

    const hitTest = (x: number, y: number): string | null => {
      for (const [id, box] of measure()) {
        const insetX = box.width * HIT_INSET
        const insetY = box.height * HIT_INSET
        if (
          x >= box.left + insetX &&
          x <= box.left + box.width - insetX &&
          y >= box.top + insetY &&
          y <= box.top + box.height - insetY
        ) {
          return id
        }
      }
      return null
    }

    const considerReorder = () => {
      const current = drag.current
      if (!current) return
      const now = performance.now()
      if (now - current.lastReorder < REORDER_COOLDOWN_MS) return
      const over = hitTest(current.x, current.y)
      if (!over || over === current.id) return
      const next = moveTo(current.id, orderRef.current.indexOf(over))
      if (!next) return
      current.lastReorder = now
      setLive(next)
    }

    const onMove = (event: PointerEvent) => {
      const current = drag.current
      if (!current || event.pointerId !== current.pointerId) return
      current.x = event.clientX + window.scrollX
      current.y = event.clientY + window.scrollY
      paintDrag()
      considerReorder()
    }

    const onEnd = (event: PointerEvent) => {
      const current = drag.current
      if (!current || event.pointerId !== current.pointerId) return
      const el = cells.current.get(current.id)
      drag.current = null
      if (el) {
        // Back to the stylesheet's transition, so the tile settles into its
        // slot rather than snapping.
        el.style.transition = ''
        el.style.transform = ''
      }
      const committed = liveRef.current
      if (committed) save(committed)
      setLive(null)
      setDragId(null)
    }

    // The page must not scroll under a drag; touch-action can't help here
    // because it is latched when the gesture began, long before the press
    // became a drag.
    const blockScroll = (event: TouchEvent) => event.preventDefault()

    let frame = requestAnimationFrame(function tick() {
      const current = drag.current
      if (current) {
        const viewportY = current.y - window.scrollY
        let step = 0
        if (viewportY < EDGE_PX) step = -EDGE_SPEED_PX * (1 - viewportY / EDGE_PX)
        else if (viewportY > window.innerHeight - EDGE_PX) {
          step = EDGE_SPEED_PX * (1 - (window.innerHeight - viewportY) / EDGE_PX)
        }
        if (step !== 0) {
          const from = window.scrollY
          window.scrollBy(0, step)
          // The finger stayed put, so the tile's page position moves with the
          // scroll rather than against it.
          current.y += window.scrollY - from
          paintDrag()
          considerReorder()
        }
      }
      frame = requestAnimationFrame(tick)
    })

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    window.addEventListener('touchmove', blockScroll, { passive: false })

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
      window.removeEventListener('touchmove', blockScroll)
    }
  }, [dragId, measure, moveTo, paintDrag, save])

  useEffect(() => {
    if (!editing) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onEditingChange(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing, onEditingChange])

  /*
   * While rearranging, a tile is a thing you move, not a thing you operate.
   * `inert` is what makes that true for the keyboard as well as the finger:
   * the charge-limit slider inside a tile is focusable and answers to the arrow
   * keys, which are also how a tile is moved without a touchscreen.
   */
  useEffect(() => {
    for (const el of cells.current.values()) {
      const widget = el.firstElementChild
      if (widget instanceof HTMLElement) widget.toggleAttribute('inert', editing)
    }
  }, [editing, orderKey])

  useEffect(() => cancelPress, [cancelPress])

  const onCellKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>, id: string) => {
    if (!editing) return
    // Up and down are two across in a two-column grid; a full-width tile makes
    // that approximate, which is why the tiles keep animating to show where
    // they actually went.
    const step =
      event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : event.key === 'ArrowUp' ? -2 : event.key === 'ArrowDown' ? 2 : 0
    if (step === 0) return
    event.preventDefault()
    const next = moveTo(id, orderRef.current.indexOf(id) + step)
    if (next) save(next)
  }

  return (
    <div className="grid-region">
      <WidgetShapeDefs />

      <div
        ref={gridRef}
        className={`widget-grid ${editing ? 'is-editing' : ''}`}
        onClickCapture={(event) => {
          // A long press ends in a click on whatever was under the finger.
          if (editing) event.stopPropagation()
        }}
      >
        {resolved.map((id, index) => {
          const item = byId.get(id)
          if (!item) return null
          const span = item.span ?? 1
          return (
            <div
              key={id}
              ref={setCell}
              data-widget-id={id}
              className={`widget-cell ${span === 2 ? 'is-wide' : 'is-square'} ${
                dragId === id ? 'is-dragging' : ''
              }`}
              style={{ '--stagger': index } as CSSProperties}
              onPointerDown={(event) => onCellPointerDown(event, id)}
              onPointerMove={onCellPointerMove}
              onPointerUp={cancelPress}
              onPointerCancel={cancelPress}
              onContextMenu={(event) => {
                if (editing || press.current) event.preventDefault()
              }}
              onKeyDown={(event) => onCellKeyDown(event, id)}
              {...(editing
                ? {
                    tabIndex: 0,
                    role: 'button',
                    'aria-label': `${item.label}, position ${index + 1} of ${resolved.length}. Use the arrow keys to move it.`,
                  }
                : {})}
            >
              {item.node}
            </div>
          )
        })}
      </div>

      {editing && (
        <div className="edit-bar">
          <p className="edit-bar-hint">Drag to reorder</p>
          <div className="edit-bar-actions">
            {customised && (
              <button type="button" className="button is-small" onClick={reset}>
                Reset order
              </button>
            )}
            <button
              type="button"
              className="button is-primary is-small"
              onClick={() => onEditingChange(false)}
            >
              <CheckIcon />
              Done
            </button>
          </div>
        </div>
      )}

      <p className="visually-hidden" role="status">
        {editing ? 'Rearranging the dashboard.' : ''}
      </p>
    </div>
  )
}
