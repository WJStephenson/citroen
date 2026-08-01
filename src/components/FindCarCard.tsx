import { useEffect, useState } from 'react'
import { flashLights, soundHorn } from '../api/client'
import type { Commands } from '../hooks/useCommands'

/**
 * Find-my-car: flash the lights or sound the horn.
 *
 * Both are rate limited by the bridge, which reports throttling as
 * {"error": "... rate limit exceeded"} under HTTP 200 — handled centrally in
 * api/client.ts.
 *
 * The horn asks for a second tap. In a car park an accidental honk is a real
 * cost, and the command is irreversible once sent; the lights are harmless and
 * fire on the first tap.
 */
export function FindCarCard({ commands }: { commands: Commands }) {
  const [armed, setArmed] = useState(false)
  const disabled = Boolean(commands.active)

  // Don't leave the horn armed indefinitely — a stale confirm state a minute
  // later would fire on a tap the user has forgotten the context for.
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), 4000)
    return () => window.clearTimeout(timer)
  }, [armed])

  const lights = () =>
    void commands.run({
      kind: 'lights',
      label: 'Flashing the lights',
      send: () => flashLights(10),
    })

  const horn = () => {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    void commands.run({
      kind: 'horn',
      label: 'Sounding the horn',
      send: () => soundHorn(1),
    })
  }

  return (
    <section className="card">
      <header className="card-head">
        <div>
          <h2>Find the car</h2>
          <p className="card-sub">Flash the lights or sound the horn</p>
        </div>
      </header>

      <div className="row">
        <button
          type="button"
          className={`button is-wide ${commands.active?.kind === 'lights' ? 'is-busy' : ''}`}
          onClick={lights}
          disabled={disabled}
        >
          Flash lights
        </button>
        <button
          type="button"
          className={`button is-wide ${armed ? 'is-armed' : ''} ${
            commands.active?.kind === 'horn' ? 'is-busy' : ''
          }`}
          onClick={horn}
          disabled={disabled}
        >
          {armed ? 'Tap again to confirm' : 'Sound horn'}
        </button>
      </div>
    </section>
  )
}
