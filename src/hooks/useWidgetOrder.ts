import { useCallback, useMemo, useState } from 'react'

const LS_ORDER = 'ec4.widgetOrder'

function read(): string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(LS_ORDER) ?? '[]')
    return Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/**
 * The user's widget order, reconciled against whichever widgets actually exist
 * right now.
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
    localStorage.setItem(LS_ORDER, JSON.stringify(next))
  }, [])

  const reset = useCallback(() => {
    setStored([])
    localStorage.removeItem(LS_ORDER)
  }, [])

  return { order, save, reset, customised: stored.length > 0 }
}
