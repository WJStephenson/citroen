import { EXPECTED_WAKE_SECONDS } from '../config'
import type { ActiveCommand } from '../hooks/useCommands'

/**
 * Non-blocking progress for in-flight commands (§5: "PWA UI displays
 * non-blocking loading overlays").
 *
 * It reports elapsed seconds against the expected 30-90s wake-up window so a
 * slow response reads as normal rather than broken. The rest of the UI stays
 * scrollable and readable underneath.
 */
export function CommandOverlay({ command }: { command: ActiveCommand }) {
  const progress = Math.min(1, command.elapsed / EXPECTED_WAKE_SECONDS)
  const overdue = command.elapsed > EXPECTED_WAKE_SECONDS

  return (
    <div className="overlay" role="status" aria-live="polite">
      <div className="overlay-card">
        <div className="overlay-text">
          <span className="overlay-label">{command.label}</span>
          <span className="overlay-detail">
            {overdue
              ? `${command.elapsed}s — still waiting on the car`
              : `${command.elapsed}s of up to ${EXPECTED_WAKE_SECONDS}s`}
          </span>
        </div>
        <div className="overlay-bar" aria-hidden="true">
          <div
            className={`overlay-bar-fill ${overdue ? 'is-overdue' : ''}`}
            style={{ transform: `scaleX(${overdue ? 1 : progress})` }}
          />
        </div>
      </div>
    </div>
  )
}
