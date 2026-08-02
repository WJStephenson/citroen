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
    <section className={`card ${on ? 'is-active' : ''}`}>
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
    </section>
  )
}
