import { useEffect, useState, type CSSProperties } from 'react'
import { MIN_POLL_MINUTES, getPollMinutes, getVin, setPollMinutes, setVin } from '../config'
import { useSheetDismiss } from '../hooks/useSheetDismiss'
import { useTariff } from '../hooks/useTariff'
import { useTheme } from '../hooks/useTheme'
import { useUnits } from '../hooks/useUnits'
import { setTariff } from '../tariff'
import { setTheme } from '../theme'
import { setUnits } from '../units'
import { currentSubscription, isPushSupported, subscribeToPush, unsubscribeFromPush } from '../push'
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
  // Whether *this* browser holds a live push subscription — checked async
  // against the service worker registration, unlike everything else on this
  // sheet, which reads a synchronous snapshot. Starts 'unknown' rather than
  // false so the switch does not flash "off" before that check resolves.
  const [pushState, setPushState] = useState<'unknown' | 'on' | 'off'>('unknown')
  const [pushBusy, setPushBusy] = useState(false)
  // Units, theme and the tariff are applied immediately rather than on Save —
  // the change is visible behind the sheet, so waiting for a reload would feel
  // broken. Only the VIN and the poll interval need the reload Save does.
  const units = useUnits()
  const theme = useTheme()
  const tariff = useTariff()
  const sheet = useSheetDismiss(onClose)

  useEffect(() => {
    if (!isPushSupported()) {
      setPushState('off')
      return
    }
    void currentSubscription().then((sub) => setPushState(sub ? 'on' : 'off'))
  }, [])

  const togglePush = async () => {
    setPushBusy(true)
    try {
      if (pushState === 'on') {
        await unsubscribeFromPush()
        setPushState('off')
        setNotice('Charge-finished notifications turned off on this device.')
      } else {
        const granted = await subscribeToPush()
        setPushState(granted ? 'on' : 'off')
        setNotice(
          granted
            ? 'This device will get a notification when charging finishes.'
            : 'Notification permission was denied — allow it in the browser/OS settings to turn this on.',
        )
      }
    } catch {
      setNotice('Could not reach the push service. Try again in a moment.')
    } finally {
      setPushBusy(false)
    }
  }

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
        ref={sheet.sheetRef}
        className={`sheet ${sheet.dragging ? 'is-dragging' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        style={{ '--sheet-offset': `${sheet.offset}px` } as CSSProperties}
        onClick={(event) => event.stopPropagation()}
        {...sheet.handlers}
      >
        {/* A real handle now — see useSheetDismiss. It used to only look like
            one, and the drag it invited fell through to pull-to-refresh. */}
        <div className="sheet-grip" role="presentation" />
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
        <p className="note">
          Polling below {MIN_POLL_MINUTES} minutes keeps the car's ECUs awake and flattens the 12V
          battery. Pull down on the dashboard whenever you want live state.
        </p>

        <h3>Notifications</h3>
        <div className="unit-row">
          <span>Notify when charging finishes</span>
          <button
            type="button"
            className={`switch ${pushState === 'on' ? 'is-on' : ''}`}
            role="switch"
            aria-checked={pushState === 'on'}
            aria-label="Notify this device when charging finishes"
            onClick={() => void togglePush()}
            disabled={pushBusy || pushState === 'unknown' || !isPushSupported()}
          >
            <span className="switch-thumb" />
          </button>
        </div>
        <p className="note">
          {isPushSupported()
            ? "Runs server-side, independent of this app being open — it'll arrive even if the phone is asleep. Reaches the setpoint on the Charge limit tile, or 100% when charge control isn't configured. Turned on separately per device; a household with several phones can have all of them notified, or just one."
            : 'Push notifications need a browser with service worker + push support, installed as an app rather than a plain browser tab on some platforms (notably iOS: Add to Home Screen first).'}
        </p>

        <h3>Electricity</h3>
        <p className="note">
          The bridge prices every charge at one flat rate, which hides the whole point of
          charging overnight. Enter your tariff and the app works the cost out itself, splitting
          each session across the two rates by the time it spent in each.
        </p>
        <div className="unit-row">
          <span>Use my tariff</span>
          <button
            type="button"
            className={`switch ${tariff.enabled ? 'is-on' : ''}`}
            role="switch"
            aria-checked={tariff.enabled}
            aria-label="Work costs out from my tariff"
            onClick={() => setTariff({ enabled: !tariff.enabled })}
          >
            <span className="switch-thumb" />
          </button>
        </div>

        {tariff.enabled && (
          <>
            <div className="rate-grid">
              <label className="field is-rate">
                <span>Day rate</span>
                <div className="rate-input">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.01}
                    value={tariff.dayRate || ''}
                    placeholder="28.62"
                    onChange={(event) => setTariff({ dayRate: Number(event.target.value) })}
                  />
                  <span className="rate-unit">p/kWh</span>
                </div>
              </label>
              <label className="field is-rate">
                <span>Night rate</span>
                <div className="rate-input">
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step={0.01}
                    value={tariff.nightRate || ''}
                    placeholder="7.50"
                    onChange={(event) => setTariff({ nightRate: Number(event.target.value) })}
                  />
                  <span className="rate-unit">p/kWh</span>
                </div>
              </label>
            </div>

            <div className="rate-grid">
              <label className="field is-rate">
                <span>Night rate from</span>
                <input
                  type="time"
                  className="time-input"
                  value={tariff.nightStart}
                  onChange={(event) => setTariff({ nightStart: event.target.value })}
                />
              </label>
              <label className="field is-rate">
                <span>until</span>
                <input
                  type="time"
                  className="time-input"
                  value={tariff.nightEnd}
                  onChange={(event) => setTariff({ nightEnd: event.target.value })}
                />
              </label>
            </div>
            <p className="note">
              A window that crosses midnight is normal — 00:30 until 07:30 is Economy 7. This is
              your <em>tariff's</em> cheap hours, which is not the same thing as the charging
              window you set on the dashboard: the tariff says what power costs, the window says
              when the car takes it.
            </p>
          </>
        )}

        <h3>Appearance</h3>
        <div className="unit-row">
          <span>Theme</span>
          <div className="segmented is-pair" role="group" aria-label="Theme">
            <button
              type="button"
              className={`segment ${theme === 'dark' ? 'is-selected' : ''}`}
              aria-pressed={theme === 'dark'}
              onClick={() => setTheme('dark')}
            >
              Dark
            </button>
            <button
              type="button"
              className={`segment ${theme === 'light' ? 'is-selected' : ''}`}
              aria-pressed={theme === 'light'}
              onClick={() => setTheme('light')}
            >
              Light
            </button>
          </div>
        </div>

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
        <p className="note">
          Display only — the bridge always reports km and °C, and nothing sent to the car is
          converted.
        </p>

        <h3>App lock</h3>
        <p className="note">
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
