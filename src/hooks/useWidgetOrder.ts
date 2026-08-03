import { useCallback, useEffect, useMemo, useState } from 'react'
import { SHARED_SETTINGS_CHANGED, getSharedSettings, patchSharedSettings } from '../api/sharedSettings'

function read(): string[] {
  const raw = getSharedSettings().widgetOrder
  return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : []
}

const sameOrder = (a: string[], b: string[]) => a.length === b.length && a.every((id, i) => id === b[i])

/**
 * The dashboard layout, reconciled against whichever widgets actually exist
 * right now. It is shared across every device controlling this car (see
 * api/sharedSettings.ts): there is one dashboard for the household to agree
 * on, not one per phone.
 *
 * Which widgets exist is not fixed: the 12V tile only appears when the reading
 * is plausible, so a stored order is always a partial, possibly stale list. Two
 * rules keep it honest:
 *
 *   - ids the user no longer has are dropped;
 *   - a widget appearing for the first time lands next to the neighbour it has
 *     in the canonical order, not at the end. Appending would drop a newly
 *     plausible 12V reading below the charging history, which is not a place
 *     the user ever put it.
 */
export function useWidgetOrder(ids: string[]) {
  const [stored, setStored] = useState<string[]>(read)

  // Another device's reorder lands here without a reload. Guarded by value so
  // an unrelated shared-settings change (say, editing the tariff) doesn't
  // requeue an identical order and retrigger the grid's FLIP animation.
  useEffect(() => {
    const onChange = () => {
      const next = read()
      setStored((current) => (sameOrder(current, next) ? current : next))
    }
    window.addEventListener(SHARED_SETTINGS_CHANGED, onChange)
    return () => window.removeEventListener(SHARED_SETTINGS_CHANGED, onChange)
  }, [])

  // ids is rebuilt every render by the caller, so the join is what actually
  // says whether the available set changed.
  const key = ids.join('|')

  const order = useMemo(() => {
    const available = new Set(ids)
    const result = stored.filter((id) => available.has(id))

    ids.forEach((id, index) => {
      if (result.includes(id)) return
      let at = 0
      for (let before = index - 1; before >= 0; before -= 1) {
        const found = result.indexOf(ids[before] as string)
        if (found >= 0) {
          at = found + 1
          break
        }
      }
      result.splice(at, 0, id)
    })

    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, key])

  const save = useCallback((next: string[]) => {
    setStored(next)
    patchSharedSettings({ widgetOrder: next })
  }, [])

  const reset = useCallback(() => {
    setStored([])
    patchSharedSettings({ widgetOrder: [] })
  }, [])

  return { order, save, reset, customised: stored.length > 0 }
}
