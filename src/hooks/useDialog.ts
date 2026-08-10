import { useEffect, useRef, type RefObject } from 'react'

/**
 * Makes a dialog behave like one it claims to be.
 *
 * Both sheets in this app carry `role="dialog"` / `alertdialog` and
 * `aria-modal="true"`, which is a promise to assistive tech that the rest of
 * the page is not there. Nothing was keeping it: focus stayed on the ⟳ or the
 * ⚙ behind the backdrop, so a screen reader landed its user outside a document
 * it had just been told to ignore, Tab walked straight back out into it, and
 * Escape — the one key everybody tries on a dialog, and the key the dashboard
 * already answers to when rearranging tiles — did nothing at all.
 *
 * Three things, then: focus in on open, focus back where it came from on
 * close, and the two keys that operate a dialog.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The dialog element itself must be focusable — `tabIndex={-1}` — because that
 * is what receives focus on open.
 *
 * Deliberately not the first control inside it: the Settings sheet opens on a
 * text field, and focusing that would throw the phone's keyboard up over the
 * sheet before anyone had read its first line.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return

    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.focus({ preventScroll: true })

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        // Stopped here rather than allowed to carry on: the grid's own Escape
        // handler would otherwise drop out of layout editing at the same time,
        // which is not what dismissing a sheet on top of it asked for.
        event.stopPropagation()
        close.current()
        return
      }
      if (event.key !== 'Tab') return

      // Re-read on every press: the Settings sheet grows and shrinks as the
      // tariff switch is thrown, so its last tab stop is not a fixed thing.
      const stops = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      )
      const first = stops[0]
      const last = stops[stops.length - 1]
      if (!first || !last) {
        event.preventDefault()
        dialog.focus({ preventScroll: true })
        return
      }

      // The dialog itself holds focus until the first Tab, so shift-Tab from
      // there wraps to the end the same way it does from the first control.
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }

    // Capture, so the keys are answered before anything inside the sheet — or
    // behind it — gets a say.
    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      // Where the sheet was opened from, which after a dismiss is the only
      // sensible place for the caret to be. Skipped if that element has since
      // gone from the page, since focusing a detached node moves focus to the
      // body and loses the reader's place entirely.
      if (returnTo?.isConnected) returnTo.focus({ preventScroll: true })
    }
  }, [ref])
}
