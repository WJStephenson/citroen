import { useState } from 'react'
import { MIN_POLL_MINUTES, getPollMinutes, getVin, setPollMinutes, setVin } from '../config'
import { useUnits } from '../hooks/useUnits'
import { setUnits } from '../units'
import {
  clearLock,
  configuredMethod,
  enrolBiometric,
  isBiometricAvailable,
  setPin,
} from '../lock/credentials'

interface Props {
  onClose: () => void
  onLockChanged: () => void
}

export function SettingsSheet({ onClose, onLockChanged }: Props) {
  const [vin, setVinValue] = useState(getVin())
  const [minutes, setMinutes] = useState(getPollMinutes())
  const [method, setMethod] = useState(configuredMethod())
  const [pin, setPinValue] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  // Units are applied immediately rather than on Save — the change is visible
  // behind the sheet, so waiting for a reload would feel broken.
  const units = useUnits()

  const save = () => {
    setVin(vin)
    setPollMinutes(minutes)
    onClose()
    // Config is read at call time, so a reload guarantees every hook agrees.
    window.location.reload()
  }

  const enrol = async () => {
    if (!(await isBiometricAvailable())) {
      setNotice('This device has no platform authenticator. Use a PIN instead.')
      return
    }
    try {
      if (await enrolBiometric()) {
        setMethod(configuredMethod())
        onLockChanged()
        setNotice('Biometric lock enabled.')
      }
    } catch {
      setNotice('Enrolment cancelled.')
    }
  }

  const savePin = async () => {
    if (pin.length < 4) {
      setNotice('Use at least 4 digits.')
      return
    }
    await setPin(pin)
    setPinValue('')
    setMethod(configuredMethod())
    onLockChanged()
    setNotice('PIN lock enabled.')
  }

  const disableLock = () => {
    clearLock()
    setMethod('none')
    onLockChanged()
    setNotice('App lock disabled.')
  }

  return (
    <div className="sheet-backdrop" onClick={onClose} role="presentation">
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sheet-grip" aria-hidden="true" />
        <h2>Settings</h2>

        <label className="field">
          <span>Vehicle VIN</span>
          <input
            value={vin}
            onChange={(event) => setVinValue(event.target.value)}
            placeholder="VR7…"
            autoCapitalize="characters"
            spellCheck={false}
          />
        </label>

        <label className="field">
          <span>Background refresh: every {minutes} min</span>
          <input
            type="range"
            min={MIN_POLL_MINUTES}
            max={120}
            step={5}
            value={minutes}
            onChange={(event) => setMinutes(Number(event.target.value))}
          />
        </label>
        <p className="card-note">
          Polling below {MIN_POLL_MINUTES} minutes keeps the car's ECUs awake and flattens the 12V
          battery. Pull down on the dashboard whenever you want live state.
        </p>

        <h3>Units</h3>
        <div className="unit-row">
          <span>Distance</span>
          <div className="segmented is-pair" role="group" aria-label="Distance unit">
            <button
              type="button"
              className={`segment ${units.distance === 'km' ? 'is-selected' : ''}`}
              aria-pressed={units.distance === 'km'}
              onClick={() => setUnits({ distance: 'km' })}
            >
              km
            </button>
            <button
              type="button"
              className={`segment ${units.distance === 'mi' ? 'is-selected' : ''}`}
              aria-pressed={units.distance === 'mi'}
              onClick={() => setUnits({ distance: 'mi' })}
            >
              miles
            </button>
          </div>
        </div>
        <div className="unit-row">
          <span>Temperature</span>
          <div className="segmented is-pair" role="group" aria-label="Temperature unit">
            <button
              type="button"
              className={`segment ${units.temperature === 'C' ? 'is-selected' : ''}`}
              aria-pressed={units.temperature === 'C'}
              onClick={() => setUnits({ temperature: 'C' })}
            >
              °C
            </button>
            <button
              type="button"
              className={`segment ${units.temperature === 'F' ? 'is-selected' : ''}`}
              aria-pressed={units.temperature === 'F'}
              onClick={() => setUnits({ temperature: 'F' })}
            >
              °F
            </button>
          </div>
        </div>
        <p className="card-note">
          Display only — the bridge always reports km and °C, and nothing sent to the car is
          converted.
        </p>

        <h3>App lock</h3>
        <p className="card-note">
          Currently: {method === 'none' ? 'off' : method === 'pin' ? 'PIN' : 'biometric'}. This locks
          the app on this phone only — the tunnel itself is protected by Cloudflare Access.
        </p>
        <div className="row">
          <button type="button" className="button" onClick={enrol}>
            Use biometrics
          </button>
          <button type="button" className="button" onClick={disableLock} disabled={method === 'none'}>
            Turn off
          </button>
        </div>
        <div className="row">
          <input
            className="pin-input is-inline"
            type="password"
            inputMode="numeric"
            placeholder="Set a PIN"
            value={pin}
            onChange={(event) => setPinValue(event.target.value)}
          />
          <button type="button" className="button" onClick={savePin} disabled={pin.length === 0}>
            Save PIN
          </button>
        </div>

        {notice && <p className="sheet-notice">{notice}</p>}

        <div className="sheet-actions">
          <button type="button" className="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button is-primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
