import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, type CommandKind, type CommandResult, type VehicleState } from '../api/types'

export interface ActiveCommand {
  kind: CommandKind
  label: string
  startedAt: number
  elapsed: number
}

/** How a finished command is reported — on the tile that started it. */
export interface CommandOutcome {
  /** Changes on every result, so a tile can restart its animation. */
  id: number
  kind: CommandKind
  tone: 'ok' | 'error'
  message: string
  /** Set shortly before the outcome is dropped, so the tile can fade it out. */
  leaving: boolean
}

/*
 * How long a result stays on its tile. A failure carries a reason worth
 * reading; a success is only ever confirming something you just did yourself,
 * and lingering on it would keep the tile's own reading covered up.
 */
const OUTCOME_MS: Record<CommandOutcome['tone'], number> = { ok: 2600, error: 6500 }
/** Must match the .widget-outcome fade in styles.css. */
const EXIT_MS = 320

export interface Commands {
  active: ActiveCommand | null
  outcome: CommandOutcome | null
  /**
   * The pending result for one tile. A tile that owns several command kinds —
   * the charging window sends three — passes all of them.
   */
  outcomeFor: (...kinds: CommandKind[]) => CommandOutcome | null
  run: (options: {
    kind: CommandKind
    label: string
    /** Applied immediately; rolled back if the bridge rejects the command. */
    optimistic?: Partial<VehicleState>
    send: () => Promise<CommandResult>
  }) => Promise<boolean>
}

/**
 * Runs vehicle commands with optimistic UI.
 *
 * Stellantis needs 30-90s to deliver an SMS wake-up packet to the car's ECU
 * (§5), so the UI applies the expected result straight away and shows a
 * non-blocking overlay with an elapsed counter. The next successful poll is the
 * source of truth and overwrites whatever we guessed.
 *
 * Results are reported on the tile the command came from rather than in a
 * corner of the screen: `active.kind` says which tile is working and `outcome`
 * says how it finished. A message that appears where you pressed does not need
 * to name what it is talking about, which is most of what a toast was for.
 */
export function useCommands(
  patch: (changes: Partial<VehicleState>) => void,
  refresh: (options?: { live?: boolean }) => Promise<void>,
  current: VehicleState | null,
): Commands {
  const [active, setActive] = useState<ActiveCommand | null>(null)
  const [outcome, setOutcome] = useState<CommandOutcome | null>(null)
  const currentRef = useRef(current)
  currentRef.current = current
  const outcomeTimers = useRef<number[]>([])
  const nextOutcomeId = useRef(0)

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

  const clearOutcomeTimers = useCallback(() => {
    for (const timer of outcomeTimers.current) window.clearTimeout(timer)
    outcomeTimers.current.length = 0
  }, [])

  /*
   * The fade-out is driven from here rather than by a CSS animation that ends
   * in `forwards`: the global prefers-reduced-motion rule collapses every
   * animation to 0.01ms, which would land such an animation on its hidden end
   * state instantly and mean the confirmation was never seen at all.
   */
  const report = useCallback(
    (kind: CommandKind, tone: CommandOutcome['tone'], message: string) => {
      clearOutcomeTimers()
      const id = (nextOutcomeId.current += 1)
      const ttl = OUTCOME_MS[tone]
      setOutcome({ id, kind, tone, message, leaving: false })
      outcomeTimers.current.push(
        window.setTimeout(
          () => setOutcome((shown) => (shown?.id === id ? { ...shown, leaving: true } : shown)),
          ttl - EXIT_MS,
        ),
        window.setTimeout(() => setOutcome((shown) => (shown?.id === id ? null : shown)), ttl),
      )
    },
    [clearOutcomeTimers],
  )

  useEffect(() => clearOutcomeTimers, [clearOutcomeTimers])

  const outcomeFor = useCallback<Commands['outcomeFor']>(
    (...kinds) => (outcome && kinds.includes(outcome.kind) ? outcome : null),
    [outcome],
  )

  const run = useCallback<Commands['run']>(
    async ({ kind, label, optimistic, send }) => {
      // One command at a time: two overlapping wake-ups confuse both the user
      // and the car.
      if (active) return false

      const rollback: Partial<VehicleState> = {}
      if (optimistic && currentRef.current) {
        for (const key of Object.keys(optimistic) as (keyof VehicleState)[]) {
          rollback[key] = currentRef.current[key] as never
        }
        patch(optimistic)
      }

      // A result still on screen from the last command would otherwise sit over
      // the tile that is about to start working.
      clearOutcomeTimers()
      setOutcome(null)
      setActive({ kind, label, startedAt: Date.now(), elapsed: 0 })
      try {
        const result = await send()
        report(kind, 'ok', result.message)
        // The car acts after the acknowledgement, so give it a moment before
        // asking for real state — and read it live, since the bridge's cache
        // will not yet reflect what we just asked for.
        window.setTimeout(() => void refresh({ live: true }), 15_000)
        return true
      } catch (caught) {
        if (Object.keys(rollback).length) patch(rollback)
        const error =
          caught instanceof ApiError ? caught : new ApiError('The command failed to send.')
        report(
          kind,
          'error',
          error.kind === 'timeout'
            ? 'No reply yet — the car may still be waking. Pull to refresh in a minute.'
            : error.message,
        )
        return false
      } finally {
        setActive(null)
      }
    },
    [active, clearOutcomeTimers, patch, refresh, report],
  )

  return { active, outcome, outcomeFor, run }
}
