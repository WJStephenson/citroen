import { useState } from 'react'
import { setChargeLimit } from '../api/client'
import type { Commands } from '../hooks/useCommands'

const PRESETS = [60, 80, 90, 100] as const
const LS_LIMIT = 'ec4.chargeLimit'

/**
 * get_vehicleinfo does not report the configured threshold back, so the last
 * value we successfully set is remembered locally and shown as selected. It is
 * a display hint, not authoritative state.
 */
export function ChargeLimitCard({ commands }: { commands: Commands }) {
  const [limit, setLimit] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(LS_LIMIT))
    return Number.isFinite(stored) && stored > 0 ? stored : null
  })

  const busy = commands.active?.kind === 'chargeLimit'
  const disabled = Boolean(commands.active)

  const apply = (value: number) =>
    void commands.run({
      kind: 'chargeLimit',
      label: `Setting charge limit to ${value}%`,
      send: async () => {
        const result = await setChargeLimit(value)
        localStorage.setItem(LS_LIMIT, String(value))
        setLimit(value)
        return result
      },
    })

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Charge limit</h2>
          <p className="card-sub">
            {limit === null ? 'Not set from this app yet' : `Last set to ${limit}%`}
          </p>
        </div>
      </header>
      <div className={`segmented ${busy ? 'is-busy' : ''}`} role="group" aria-label="Charge limit">
        {PRESETS.map((value) => (
          <button
            key={value}
            type="button"
            className={`segment ${limit === value ? 'is-selected' : ''}`}
            aria-pressed={limit === value}
            onClick={() => apply(value)}
            disabled={disabled}
          >
            {value}%
          </button>
        ))}
      </div>
      <p className="card-note">Staying at 80% for daily use is easier on the traction battery.</p>
    </section>
  )
}
