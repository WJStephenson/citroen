import { useEffect, useState } from 'react'
import { flashLights, soundHorn } from '../api/client'
import type { Commands } from '../hooks/useCommands'
import { HornIcon, LightsIcon } from './Icons'
import { Widget, WidgetNote } from './Widget'

/**
 * Finding the car in a car park is two separate decisions, so it is two tiles.
 * The lights are harmless and fire on the first tap; the horn is not, and an
 * accidental honk is a real cost you cannot take back. Sitting them side by
 * side under one heading made the safe action and the loud one look like the
 * same kind of thing.
 *
 * Both are rate limited by the bridge, which reports throttling as
 * {"error": "... rate limit exceeded"} under HTTP 200 — handled centrally in
 * api/client.ts.
 */

export function LightsWidget({ commands }: { commands: Commands }) {
  const busy = commands.active?.kind === 'lights'

  return (
    <Widget
      icon={<LightsIcon />}
      label="Lights"
      shape="sunny"
      className="widget-action"
      working={busy}
      action={{
        label: 'Flash the lights for 10 seconds',
        disabled: Boolean(commands.active),
        onPress: () =>
          void commands.run({
            kind: 'lights',
            label: 'Flashing the lights',
            send: () => flashLights(10),
          }),
      }}
    >
      <p className="state-word">{busy ? 'Flashing' : 'Flash'}</p>
      <WidgetNote>For 10 seconds</WidgetNote>
    </Widget>
  )
}

export function HornWidget({ commands }: { commands: Commands }) {
  const [armed, setArmed] = useState(false)
  const busy = commands.active?.kind === 'horn'

  // Don't leave the horn armed indefinitely — a stale confirm state a minute
  // later would fire on a tap the user has forgotten the context for.
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(timer)
  }, [armed])

  const press = () => {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    void commands.run({ kind: 'horn', label: 'Sounding the horn', send: () => soundHorn(1) })
  }

  return (
    <Widget
      icon={<HornIcon />}
      label="Horn"
      shape="boom"
      className={`widget-action ${armed ? 'is-armed' : ''}`}
      working={busy}
      action={{
        label: armed ? 'Tap again to sound the horn' : 'Sound the horn',
        disabled: Boolean(commands.active),
        onPress: press,
      }}
    >
      <p className={`state-word ${armed ? 'is-warn' : ''}`}>
        {busy ? 'Sounding' : armed ? 'Tap again' : 'Sound'}
      </p>
      <WidgetNote tone={armed ? 'warn' : undefined}>
        {armed ? 'This will honk' : 'Asks twice'}
      </WidgetNote>
    </Widget>
  )
}
