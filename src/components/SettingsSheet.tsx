import { useEffect, useState, type CSSProperties } from 'react'
import { MIN_POLL_MINUTES, getPollMinutes, getVin, setPollMinutes, setVin } from '../config'
import { useSheetDismiss } from '../hooks/useSheetDismiss'
import { useTariff } from '../hooks/useTariff'
import { useTheme } from '../hooks/useTheme'
import { useUnits } from '../hooks/useUnits'
import { setTariff } from '../tariff'
import { setTheme } from '../theme'
import { setUnits } from '../units'
import {
  pushUnavailableMessage,
  currentPushEvents,
  pushUnavailableReason,
  setPushEvents,
  NO_PUSH_EVENTS,
  type PushEventKind,
  type PushEvents,
  type PushUnavailableReason,
} from '../push'
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

/** Independent per device, and independent of each other — see push.ts. */
const PUSH_SWITCHES: { kind: PushEventKind; label: string }[] = [
  { kind: 'start', label: 'Notify when charging starts' },
  { kind: 'finish', label: 'Notify when charging finishes' },
]

export function SettingsSheet({ onClose, onLockChanged }: Props) {
  const [vin, setVinValue] = useState(getVin())
  const [minutes, setMinutes] = useState(getPollMinutes())
  const [method, setMethod] = useState(configuredMethod())
  const [pin, setPinValue] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  // Save is a round trip to the store now, not a local write — see save().
  const [saving, setSaving] = useState(false)
  // Which notifications *this* browser is signed up for — checked async
  // against the service worker registration, unlike everything else on this
  // sheet, which reads a synchronous snapshot. Null until that check
  // resolves, rather than both-off, so neither switch flashes "off" first.
  const [pushEvents, setPushEventsState] = useState<PushEvents | null>(null)
  const [pushBusy, setPushBusy] = useState(false)
  // Set only when the switch is stuck off for a reason worth explaining —
  // an unsupported browser, a build with no VAPID key, or (the one a plain
  // feature-detect can't catch) a service worker that registered but never
  // finished activating. Null means "no known reason", not "definitely fine".
  const [pushProblem, setPushProblem] = useState<PushUnavailableReason | null>(null)
  // Units, theme and the tariff are applied immediately rather than on Save —
  // the change is visible behind the sheet, so waiting for a reload would feel
  // broken. Only the VIN and the poll interval need the reload Save does.
  const units = useUnits()
  const theme = useTheme()
  const tariff = useTariff()
  const sheet = useSheetDismiss(onClose)

  useEffect(() => {
    let cancelled = false
    void pushUnavailableReason().then((reason) => {
      if (cancelled) return
      setPushProblem(reason)
      if (reason) {
        setPushEventsState(NO_PUSH_EVENTS)
        return
      }
      void currentPushEvents().then((events) => {
        if (!cancelled) setPushEventsState(events)
      })
    })
    return () => {
      cancelled = true
    }
  }, [])

  const togglePushEvent = async (kind: PushEventKind) => {
    if (!pushEvents) return
    const wanted = { ...pushEvents, [kind]: !pushEvents[kind] }
    setPushBusy(true)
    try {
      const { events: applied, problem } = await setPushEvents(wanted)
      setPushEventsState(applied)
      const label = kind === 'start' ? 'charging starts' : 'charging finishes'
      if (problem === 'denied') {
        setNotice('Notification permission was denied — allow it in the browser/OS settings to turn this on.')
      } else if (problem === 'unsaved') {
        // The switch is set on this phone, and the watcher that does the
        // sending reads the shared list, which never got it. Said plainly
        // rather than confirmed, for the same reason Save refuses to reload
        // past an unreachable store.
        setNotice(
          'Set on this phone, but the settings store could not be reached — nothing will be sent until this saves. Try again when you are back on the network.',
        )
      } else {
        setNotice(
          applied[kind]
            ? `This device will get a notification when ${label}.`
            : `This device will no longer be notified when ${label}.`,
        )
      }
    } catch {
      setNotice('Could not reach the push service. Try again in a moment.')
    } finally {
      setPushBusy(false)
    }
  }

  /*
   * Both writes are awaited before the reload, and this is not a nicety.
   * patchSharedSettings applies the change to the local mirror at once and
   * sends it to the store; reloading in the same breath aborted that request
   * as navigation tore the page down, and the reload's own GET then wrote the
   * server's older blob back over the mirror. The setting closed the sheet
   * looking saved and came back changed — most visibly on the poll interval,
   * which is the one people have a reason to move.
   *
   * A store that cannot be reached is reported rather than reloaded past: the
   * mirror still holds the new value at that point, so reloading would be the
   * one action guaranteed to throw it away.
   */
  const save = async () => {
    setSaving(true)
    const stored = await Promise.all([setVin(vin), setPollMinutes(minutes)])
    setSaving(false)
    if (!stored.every(Boolean)) {
      setNotice('Could not reach the settings store — nothing was saved.')
      return
    }
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
          Background reads ask Stellantis what the car last told them, and never touch the car
          itself — the floor of {MIN_POLL_MINUTES} minutes is there to stay a polite guest on
          their API, not to protect the 12V battery. Only “Wake the car”, offered on the dashboard
          when a reading has gone old, reaches the vehicle.
        </p>

        <h3>Notifications</h3>
        {PUSH_SWITCHES.map(({ kind, label }) => (
          <div className="unit-row" key={kind}>
            <span>{label}</span>
            <button
              type="button"
              className={`switch ${pushEvents?.[kind] ? 'is-on' : ''}`}
              role="switch"
              aria-checked={pushEvents?.[kind] ?? false}
              aria-label={`${label} on this device`}
              onClick={() => void togglePushEvent(kind)}
              disabled={pushBusy || pushEvents === null || pushProblem !== null}
            >
              <span className="switch-thumb" />
            </button>
          </div>
        ))}
        <p className="note">
          {pushProblem
            ? pushUnavailableMessage(pushProblem)
            : "Both run server-side, independent of this app being open — they'll arrive even if the phone is asleep. \"Finishes\" means reaching the setpoint on the Charge limit tile, or 100% when charge control isn't configured. Turned on separately per device; a household with several phones can have all of them notified, or just one."}
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
          <button
            type="button"
            className="button is-primary"
            onClick={() => void save()}
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
