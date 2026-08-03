import { useEffect, useState } from 'react'
import { setDoorLock } from '../api/client'
import type { Commands } from '../hooks/useCommands'
import { LockIcon, UnlockIcon } from './Icons'
import { Widget, WidgetNote } from './Widget'

/**
 * Remote lock and unlock, both behind the same tap-twice confirm the horn
 * uses (§ FindCarWidgets) — an accidental unlock leaves the car open, and an
 * accidental lock while someone is still at the door is exactly the kind of
 * mistake a single stray tap should not be able to make.
 *
 * Lock and unlock share one tile rather than getting one each: they are two
 * ends of the same decision, and arming one disarms the other so "tap again"
 * is never ambiguous about which it confirms.
 *
 * `get_vehicleinfo` reports no lock state, so — like Horn and Lights — this is
 * fire-and-forget: the tile has no idea whether the doors are actually locked,
 * only what was last asked for.
 */
function useArmed(ms = 4000) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    if (!armed) return
    const timer = window.setTimeout(() => setArmed(false), ms)
    return () => window.clearTimeout(timer)
  }, [armed, ms])
  return [armed, setArmed] as const
}

export function LockWidget({ commands }: { commands: Commands }) {
  const [lockArmed, setLockArmed] = useArmed()
  const [unlockArmed, setUnlockArmed] = useArmed()
  // Which direction is on the wire — the tile's own kind can't say, since both
  // buttons send the same `lock` command kind.
  const [sending, setSending] = useState<'lock' | 'unlock' | null>(null)

  const busy = commands.active?.kind === 'lock'
  const disabled = Boolean(commands.active)

  const send = (locked: boolean) => {
    setLockArmed(false)
    setUnlockArmed(false)
    setSending(locked ? 'lock' : 'unlock')
    void commands
      .run({
        kind: 'lock',
        label: locked ? 'Locking the doors' : 'Unlocking the doors',
        send: () => setDoorLock(locked),
      })
      .finally(() => setSending(null))
  }

  const pressLock = () => {
    setUnlockArmed(false)
    if (!lockArmed) {
      setLockArmed(true)
      return
    }
    send(true)
  }

  const pressUnlock = () => {
    setLockArmed(false)
    if (!unlockArmed) {
      setUnlockArmed(true)
      return
    }
    send(false)
  }

  const armed = lockArmed || unlockArmed

  return (
    <Widget
      icon={<LockIcon />}
      label="Locks"
      className="widget-action"
      working={busy}
      outcome={commands.outcomeFor('lock')}
    >
      <WidgetNote tone={armed ? 'warn' : undefined}>
        {lockArmed ? 'This will lock the doors' : unlockArmed ? 'This will unlock the doors' : 'Asks twice'}
      </WidgetNote>

      <div className="lock-actions">
        <button
          type="button"
          className={`button ${lockArmed ? 'is-armed' : ''} ${sending === 'lock' ? 'is-busy' : ''}`}
          onClick={pressLock}
          disabled={disabled}
          aria-label={lockArmed ? 'Tap again to lock the doors' : 'Lock the doors'}
        >
          <LockIcon />
          {lockArmed ? 'Tap again' : 'Lock'}
        </button>
        <button
          type="button"
          className={`button ${unlockArmed ? 'is-armed' : ''} ${sending === 'unlock' ? 'is-busy' : ''}`}
          onClick={pressUnlock}
          disabled={disabled}
          aria-label={unlockArmed ? 'Tap again to unlock the doors' : 'Unlock the doors'}
        >
          <UnlockIcon />
          {unlockArmed ? 'Tap again' : 'Unlock'}
        </button>
      </div>
    </Widget>
  )
}
