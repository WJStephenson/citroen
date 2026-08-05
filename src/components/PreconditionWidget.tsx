import { useEffect, useState } from 'react'
import { setPreconditioning } from '../api/client'
import type { VehicleState } from '../api/types'
import type { Commands } from '../hooks/useCommands'
import { ClimateIcon } from './Icons'
import { Widget, WidgetNote } from './Widget'

interface Props {
  state: VehicleState
  commands: Commands
}

/**
 * How long the tile keeps showing what was asked for while the car has yet to
 * say anything. Comfortably past the 30-90s wake-up window (§5) plus the time
 * the air conditioning takes to report itself as running — but bounded, so a
 * request the car quietly dropped cannot leave the tile lying about it forever.
 */
const PENDING_MS = 4 * 60_000

/**
 * How long a first tap stays armed. Long enough to be a deliberate second tap,
 * short enough that a stale confirm state cannot fire on a tap whose context
 * has been forgotten — the same 4s the horn uses.
 */
const ARMED_MS = 4000

export function PreconditionWidget({ state, commands }: Props) {
  const reported = state.preconditioning

  /*
   * What we last asked for, held until the car agrees.
   *
   * Without this the tile flips itself back off a few seconds after being
   * turned on: the post-command refresh lands while the car is still waking, so
   * it reports the old status — or none — and the reported value overwrites the
   * optimistic one. The tile has to stay on for as long as the mode is meant to
   * be running, so the intent outlives that first honest but premature read.
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

  /*
   * Both directions go behind a second tap, unlike the horn where only the loud
   * one does. Pre-conditioning is a tile you press with a phone in a coat
   * pocket, and both mistakes cost something real: starting it drains a parked
   * car's traction battery for half an hour, stopping it throws away the warm
   * cabin you asked for twenty minutes ago and cannot get back before you
   * leave. Neither is an action worth risking on one stray tap.
   */
  const [armed, setArmed] = useState(false)

  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), ARMED_MS)
    return () => window.clearTimeout(timer)
  }, [armed])

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

  const press = () => {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    void toggle()
  }

  return (
    <Widget
      icon={<ClimateIcon />}
      label="Climate"
      shape="clover"
      active={on}
      working={busy}
      outcome={commands.outcomeFor('precondition')}
      className={`widget-action widget-precondition ${armed ? 'is-armed' : ''}`}
      action={{
        label: armed
          ? `Tap again to ${on ? 'stop' : 'start'} cabin pre-conditioning`
          : `${on ? 'Stop' : 'Start'} cabin pre-conditioning`,
        disabled,
        onPress: press,
      }}
    >
      <p className="state-word">
        {busy
          ? on
            ? 'Stopping'
            : 'Starting'
          : armed
            ? 'Tap again'
            : on
              ? 'Running'
              : reported === 'unknown'
                ? 'Not reported'
                : 'Off'}
      </p>

      {/*
        The note carries the affordance. With the switch gone there is nothing
        on the tile that looks pressable, so it has to say so — and once armed,
        say which way the second tap goes rather than just "again".
      */}
      <WidgetNote>
        {armed
          ? on
            ? 'Will turn it off'
            : 'Will warm the cabin'
          : on
            ? 'Tap twice to stop'
            : 'Tap twice to start'}
      </WidgetNote>
    </Widget>
  )
}
