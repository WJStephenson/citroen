import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { verifyBiometric, verifyPin, type LockMethod } from './credentials'

interface Props {
  method: LockMethod
  onUnlock: () => void
}

export function LockScreen({ method, onUnlock }: Props) {
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)

  const promptBiometric = useCallback(async () => {
    setChecking(true)
    setError(null)
    try {
      if (await verifyBiometric()) onUnlock()
      else setError('Verification failed.')
    } catch {
      // Also fires when the user simply cancels the system sheet.
      setError('Verification cancelled.')
    } finally {
      setChecking(false)
    }
  }, [onUnlock])

  // Present the system biometric sheet as soon as the lock screen appears.
  useEffect(() => {
    if (method === 'biometric') void promptBiometric()
  }, [method, promptBiometric])

  const submitPin = async (event: FormEvent) => {
    event.preventDefault()
    setChecking(true)
    if (await verifyPin(pin)) {
      onUnlock()
    } else {
      setError('Incorrect PIN.')
      setPin('')
    }
    setChecking(false)
  }

  return (
    <div className="lock">
      <div className="lock-mark" aria-hidden="true">
        ⚡
      </div>
      <h1 className="lock-title">ë-C4</h1>

      {method === 'biometric' ? (
        <>
          <p className="lock-sub">Verify to continue</p>
          <button type="button" className="button is-primary" onClick={promptBiometric} disabled={checking}>
            {checking ? 'Waiting…' : 'Unlock'}
          </button>
        </>
      ) : (
        <form className="lock-form" onSubmit={submitPin}>
          <label className="lock-sub" htmlFor="pin">
            Enter PIN
          </label>
          <input
            id="pin"
            className="pin-input"
            type="password"
            inputMode="numeric"
            autoComplete="off"
            autoFocus
            value={pin}
            onChange={(event) => setPin(event.target.value)}
          />
          <button type="submit" className="button is-primary" disabled={checking || pin.length === 0}>
            Unlock
          </button>
        </form>
      )}

      {error && <p className="lock-error">{error}</p>}
    </div>
  )
}
