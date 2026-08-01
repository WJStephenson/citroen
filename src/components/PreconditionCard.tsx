import { setPreconditioning } from '../api/client'
import type { VehicleState } from '../api/types'
import type { Commands } from '../hooks/useCommands'

interface Props {
  state: VehicleState
  commands: Commands
}

export function PreconditionCard({ state, commands }: Props) {
  const on = state.preconditioning === 'on'
  const busy = commands.active?.kind === 'precondition'
  const disabled = Boolean(commands.active)

  const toggle = () =>
    void commands.run({
      kind: 'precondition',
      label: on ? 'Stopping pre-conditioning' : 'Pre-conditioning the cabin',
      optimistic: { preconditioning: on ? 'off' : 'on' },
      send: () => setPreconditioning(!on),
    })

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Pre-conditioning</h2>
          <p className="card-sub">
            {state.preconditioning === 'unknown'
              ? 'State not reported'
              : on
                ? 'Cabin climate running'
                : 'Cabin climate off'}
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Toggle cabin pre-conditioning"
          className={`switch ${on ? 'is-on' : ''} ${busy ? 'is-busy' : ''}`}
          onClick={toggle}
          disabled={disabled}
        >
          <span className="switch-thumb" />
        </button>
      </header>
      <p className="card-note">
        Takes 30–90s to reach the car — it has to be woken over the cellular network first. The car
        heats to its own fixed target; the bridge exposes no temperature setting.
      </p>
    </section>
  )
}
