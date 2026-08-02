import { setPreconditioning } from '../api/client'
import type { VehicleState } from '../api/types'
import type { Commands } from '../hooks/useCommands'
import { ClimateIcon } from './Icons'
import { Widget } from './Widget'

interface Props {
  state: VehicleState
  commands: Commands
}

export function PreconditionWidget({ state, commands }: Props) {
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
    <Widget
      icon={<ClimateIcon />}
      label="Climate"
      shape="clover"
      active={on}
      working={busy}
      className="widget-precondition"
    >
      <p className="state-word">
        {state.preconditioning === 'unknown' ? 'Not reported' : on ? 'Running' : 'Off'}
      </p>

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
    </Widget>
  )
}
