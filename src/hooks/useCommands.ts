import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type CommandKind, type CommandResult, type VehicleState } from '../api/types'

export interface ActiveCommand {
  kind: CommandKind
  label: string
  startedAt: number
  elapsed: number
}

export interface Toast {
  id: number
  tone: 'ok' | 'error'
  message: string
}

export interface Commands {
  active: ActiveCommand | null
  toasts: Toast[]
  dismissToast: (id: number) => void
  run: (options: {
    kind: CommandKind
    label: string
    /** Applied immediately; rolled back if the bridge rejects the command. */
    optimistic?: Partial<VehicleState>
    send: () => Promise<CommandResult>
  }) => Promise<void>
}

/**
 * Runs vehicle commands with optimistic UI.
 *
 * Stellantis needs 30-90s to deliver an SMS wake-up packet to the car's ECU
 * (§5), so the UI applies the expected result straight away and shows a
 * non-blocking overlay with an elapsed counter. The next successful poll is the
 * source of truth and overwrites whatever we guessed.
 */
export function useCommands(
  patch: (changes: Partial<VehicleState>) => void,
  refresh: (options?: { live?: boolean }) => Promise<void>,
  current: VehicleState | null,
): Commands {
  const [active, setActive] = useState<ActiveCommand | null>(null)
  const [toasts, setToasts] = useState<Toast[]>([])
  const currentRef = useRef(current)
  currentRef.current = current

  // Drives the "42s elapsed" readout on the overlay. Keyed on startedAt, not on
  // `active` itself — the interval mutates `active` every tick, and depending on
  // it would tear down and rebuild the timer once a second.
  const startedAt = active?.startedAt
  useEffect(() => {
    if (startedAt === undefined) return
    const timer = window.setInterval(() => {
      setActive((command) =>
        command ? { ...command, elapsed: Math.round((Date.now() - command.startedAt) / 1000) } : null,
      )
    }, 1000)
    return () => window.clearInterval(timer)
  }, [startedAt])

  const pushToast = useCallback((tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.random()
    setToasts((list) => [...list, { id, tone, message }])
    window.setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), 6000)
  }, [])

  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id))
  }, [])

  const run = useCallback<Commands['run']>(
    async ({ kind, label, optimistic, send }) => {
      // One command at a time: two overlapping wake-ups confuse both the user
      // and the car.
      if (active) return

      const rollback: Partial<VehicleState> = {}
      if (optimistic && currentRef.current) {
        for (const key of Object.keys(optimistic) as (keyof VehicleState)[]) {
          rollback[key] = currentRef.current[key] as never
        }
        patch(optimistic)
      }

      setActive({ kind, label, startedAt: Date.now(), elapsed: 0 })
      try {
        const result = await send()
        pushToast('ok', result.message)
        // The car acts after the acknowledgement, so give it a moment before
        // asking for real state — and read it live, since the bridge's cache
        // will not yet reflect what we just asked for.
        window.setTimeout(() => void refresh({ live: true }), 15_000)
      } catch (caught) {
        if (Object.keys(rollback).length) patch(rollback)
        const error =
          caught instanceof ApiError ? caught : new ApiError('The command failed to send.')
        pushToast(
          'error',
          error.kind === 'timeout'
            ? 'No reply yet — the car may still be waking. Pull to refresh in a minute.'
            : error.message,
        )
      } finally {
        setActive(null)
      }
    },
    [active, patch, pushToast, refresh],
  )

  return { active, toasts, dismissToast, run }
}
