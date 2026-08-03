import { useEffect, useState } from 'react'
import { setPreconditioning } from '../api/client'
import type { VehicleState } from '../api/types'
import type { Commands } from '../hooks/useCommands'
import { ClimateIcon } from './Icons'
import { Widget } from './Widget'

interface Props {
  state: VehicleState
  commands: Commands
}

/**
 * How long the switch keeps showing what was asked for while the car has yet to
 * say anything. Comfortably past the 30-90s wake-up window (§5) plus the time
 * the air conditioning takes to report itself as running — but bounded, so a
 * request the car quietly dropped cannot leave the toggle lying about it
 * forever.
 */
const PENDING_MS = 4 * 60_000

export function PreconditionWidget({ state, commands }: Props) {
  const reported = state.preconditioning

  /*
   * What we last asked for, held until the car agrees.
   *
   * Without this the toggle flips itself back off a few seconds after being
   * turned on: the post-command refresh lands while the car is still waking, so
   * it reports the old status — or none — and the reported value overwrites the
   * optimistic one. The switch has to stay on for as long as the mode is meant
   * to be running, so the intent outlives that first honest but premature read.
   */
  const [intent, setIntent] = useState<{ value: 'on' | 'off'; at: number } | null>(null)

  useEffect(() => {
    if (!intent) return
    // The car has confirmed it — from here the reported state is the truth.
    if (reported === intent.value) {
      setIntent(null)
      return
    }
    const remaining = intent.at + PENDING_MS - Date.now()
    if (remaining <= 0) {
      setIntent(null)
      return
    }
    const timer = window.setTimeout(() => setIntent(null), remaining)
    return () => window.clearTimeout(timer)
  }, [intent, reported])

  const on = intent ? intent.value === 'on' : reported === 'on'
  const busy = commands.active?.kind === 'precondition'
  const disabled = Boolean(commands.active)

  const toggle = async () => {
    const next = on ? 'off' : 'on'
    setIntent({ value: next, at: Date.now() })
    const sent = await commands.run({
      kind: 'precondition',
      label: on ? 'Stopping pre-conditioning' : 'Pre-conditioning the cabin',
      optimistic: { preconditioning: next },
      send: () => setPreconditioning(!on),
    })
    // Nothing was asked of the car, so there is nothing to wait for it to
    // confirm — fall straight back to whatever it last reported.
    if (!sent) setIntent(null)
  }

  return (
    <Widget
      icon={<ClimateIcon />}
      label="Climate"
      shape="clover"
      active={on}
      working={busy}
      outcome={commands.outcomeFor('precondition')}
      className="widget-precondition"
    >
      <p className="state-word">
        {on ? 'Running' : reported === 'unknown' ? 'Not reported' : 'Off'}
      </p>

      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Toggle cabin pre-conditioning"
        className={`switch ${on ? 'is-on' : ''}`}
        onClick={() => void toggle()}
        disabled={disabled}
      >
        <span className="switch-thumb" />
      </button>
    </Widget>
  )
}
