import { useCallback, useEffect, useRef, useState } from 'react'
import { SHARED_SETTINGS_CHANGED } from './api/sharedSettings'
import { ChargeLimitWidget } from './components/ChargeLimitWidget'
import { ChargeWindowWidget } from './components/ChargeWindowWidget'
import { ChargingHistoryWidget } from './components/ChargingHistoryWidget'
import { CarHero } from './components/CarHero'
import { CommandOverlay } from './components/CommandOverlay'
import { HornWidget, LightsWidget } from './components/FindCarWidgets'
import { LayoutIcon, RefreshIcon, SettingsIcon } from './components/Icons'
import { LocationWidget } from './components/LocationWidget'
import { LockWidget } from './components/LockWidget'
import { PreconditionWidget } from './components/PreconditionWidget'
import { SettingsSheet } from './components/SettingsSheet'
import { WakeConfirmModal } from './components/WakeConfirmModal'
import {
  AuxWidget,
  CabinWidget,
  ChargeStateWidget,
  ChargeWidget,
  EfficiencyWidget,
  HealthWidget,
  OdometerWidget,
} from './components/StatWidgets'
import { WidgetGrid, type WidgetItem } from './components/WidgetGrid'
import { wakeVehicle } from './api/client'
import { EXPECTED_WAKE_SECONDS, STALE_AFTER_MINUTES, getVin } from './config'
import { useAppLock } from './hooks/useAppLock'
import { useBatteryHealth } from './hooks/useBatteryHealth'
import { useCommands } from './hooks/useCommands'
import { useOnline } from './hooks/useOnline'
import { useVehicle } from './hooks/useVehicle'
import { LockScreen } from './lock/LockScreen'
import { applyUpdate, registerServiceWorker } from './sw-register'
import { isPlausibleAuxVoltage } from './units'

/**
 * How long to keep saying "waiting" after a wake-up is acknowledged, before
 * concluding the car did not answer it. Comfortably past the 30-90s the ECUs
 * take, and past the follow-up read that goes out at the end of that window.
 */
const WAKE_PATIENCE_MS = (EXPECTED_WAKE_SECONDS + 90) * 1000

/** "4 min ago" — the age of the data matters more than the clock time here. */
function relativeTime(date: Date | null): string {
  if (!date) return 'never'
  const seconds = Math.round((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

export default function App() {
  const lock = useAppLock()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [editingLayout, setEditingLayout] = useState(false)
  const [updateReady, setUpdateReady] = useState(false)
  const [confirmWakeOpen, setConfirmWakeOpen] = useState(false)
  const [, forceTick] = useState(0)

  // Telemetry only flows once the app is unlocked.
  const vehicle = useVehicle(!lock.locked)
  const soh = useBatteryHealth(!lock.locked)
  const online = useOnline()
  const commands = useCommands(vehicle.patch, vehicle.refresh, vehicle.state)

  /**
   * A wake-up in flight, and the reading it is trying to replace.
   *
   * `beating` is the car's timestamp at the moment the wake was sent, not our
   * clock: the two are not comparable. The car reports to Stellantis *before*
   * the acknowledgement finishes reaching us, and its clock is not ours
   * anyway, so "is the reading newer than when I pressed the button" is a
   * question that answers no to a wake-up that worked perfectly. "Is the
   * reading a different one from the reading I was looking at" does not care
   * about either clock.
   */
  const [waking, setWaking] = useState<{ at: number; beating: number | null } | null>(null)
  // Read through a ref so the callback does not have to be rebuilt on every
  // poll — the same reason useCommands keeps one.
  const stateRef = useRef(vehicle.state)
  stateRef.current = vehicle.state

  /*
   * The only call in the app that reaches the car. It goes through useCommands
   * like any other command — overlay, elapsed counter, rate-limit reporting —
   * and waits the full wake window before reading back, because the reading is
   * the entire point of having sent it.
   */
  const wake = useCallback(async () => {
    const beating = stateRef.current?.reportedAt?.getTime() ?? null
    const sent = await commands.run({
      kind: 'wake',
      label: 'Waking the car',
      send: wakeVehicle,
      settleMs: (EXPECTED_WAKE_SECONDS + 15) * 1000,
    })
    if (sent) setWaking({ at: Date.now(), beating })
  }, [commands])

  useEffect(() => registerServiceWorker(() => setUpdateReady(true)), [])

  /*
   * A wake-up is acknowledged in seconds and answered in up to ninety, so the
   * dashboard holds "waiting" for the gap rather than dropping straight back
   * to the stale notice that prompted it. Two things end the wait: a reading
   * newer than the request, which is the wake having worked, and a ceiling,
   * which is it having not. Both restore the button — but only once there is
   * something for pressing it again to mean.
   */
  const carReportedAt = vehicle.state?.reportedAt?.getTime() ?? null
  useEffect(() => {
    if (waking === null) return
    if (carReportedAt !== null && carReportedAt !== waking.beating) {
      setWaking(null)
      return
    }
    const timer = window.setTimeout(
      () => setWaking(null),
      Math.max(0, waking.at + WAKE_PATIENCE_MS - Date.now()),
    )
    return () => window.clearTimeout(timer)
  }, [waking, carReportedAt])

  // Keeps the "reported N min ago" label honest without re-reading anything.
  useEffect(() => {
    const timer = window.setInterval(() => forceTick((n) => n + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  // Live rather than recomputed on a dependency, because the VIN can arrive
  // asynchronously from the settings store on a device's very first load —
  // see api/sharedSettings.ts.
  const [vinMissing, setVinMissing] = useState(() => !getVin())
  useEffect(() => {
    const onChange = () => setVinMissing(!getVin())
    window.addEventListener(SHARED_SETTINGS_CHANGED, onChange)
    return () => window.removeEventListener(SHARED_SETTINGS_CHANGED, onChange)
  }, [])

  if (lock.locked) return <LockScreen method={lock.method} onUnlock={lock.unlock} />

  /*
   * Staleness is the car's silence, not ours.
   *
   * This used to be measured on `fetchedAt` — when the app last managed to
   * read — which is a fact about the app and is nearly always a few minutes
   * old by construction. It therefore said "fresh" all day while the numbers
   * underneath it aged, which is the only way a dashboard can be wrong without
   * ever displaying a wrong number. `reportedAt` is the car's own timestamp on
   * the reading, so this now asks the question the tiles are actually
   * qualified by: how long since the car last said anything.
   *
   * A car that reports no timestamp at all cannot be judged, and is not
   * accused — see the notice below, which says that instead of guessing.
   */
  const wakeOutcome = commands.outcomeFor('wake')
  const reportedAt = vehicle.state?.reportedAt ?? null
  const reportedAgeMs = reportedAt === null ? null : Date.now() - reportedAt.getTime()
  const stale = reportedAgeMs !== null && reportedAgeMs > STALE_AFTER_MINUTES * 60_000

  /*
   * Whether ⟳ should offer a wake-up instead of a read. Only when the car is
   * demonstrably quiet — a car that reports no timestamp at all is not
   * evidence of anything, and treating it as stale would turn the refresh
   * button into a wake-up button permanently, on a payload shape that may
   * simply not carry `updated_at`.
   */
  const needsWake = stale && waking === null

  /*
   * The canonical layout, which is also the fallback order and the order a
   * newly available tile is slotted back into. Charge leads because it is the
   * question the app exists to answer; the tiles you configure once and forget
   * sit under the ones you read every day.
   *
   * Two tiles are conditional, and both are placed at the end of a run of
   * half-width ones for the same reason: each flips the parity of its run, and
   * the grid never backfills a hole (see styles.css), so a missing tile has to
   * leave its gap at a break in meaning rather than mid-grid.
   *
   *   battery health — the bridge only has a figure once the car has sent one,
   *                    and the route is outside the design doc's scope. Its
   *                    gap falls between what you read about the car and where
   *                    the car is.
   *   12V            — see isPlausibleAuxVoltage. A number that never changes,
   *                    driving a low-voltage warning that can never fire, is
   *                    worse than showing nothing: it looks like reassurance.
   *                    Its gap falls beside the charge limit, at the break
   *                    between what you read and what you schedule.
   */
  const state = vehicle.state
  const widgets: WidgetItem[] = state
    ? [
        { id: 'charge', label: 'Charge', span: 2, node: <ChargeWidget state={state} stale={stale} /> },
        { id: 'chargeState', label: 'Charge state', node: <ChargeStateWidget state={state} /> },
        {
          id: 'precondition',
          label: 'Climate',
          node: <PreconditionWidget state={state} commands={commands} />,
        },
        { id: 'cabin', label: 'Cabin temperature', node: <CabinWidget celsius={state.cabinTemp} /> },
        { id: 'odometer', label: 'Odometer', node: <OdometerWidget km={state.odometer} /> },
        // Beside the odometer: the same trips answer both, and one tap on
        // either loads them for the other (see hooks/useTrips).
        { id: 'efficiency', label: 'Efficiency', node: <EfficiencyWidget /> },
        ...(soh !== null
          ? [{ id: 'health', label: 'Battery health', node: <HealthWidget soh={soh} /> }]
          : []),
        {
          id: 'location',
          label: 'Location',
          span: 2,
          node: <LocationWidget location={state.location} />,
        },
        { id: 'lights', label: 'Lights', node: <LightsWidget commands={commands} /> },
        { id: 'horn', label: 'Horn', node: <HornWidget commands={commands} /> },
        { id: 'lock', label: 'Locks', node: <LockWidget commands={commands} /> },
        {
          id: 'chargeLimit',
          label: 'Charge limit',
          node: <ChargeLimitWidget commands={commands} state={state} />,
        },
        ...(isPlausibleAuxVoltage(state.auxVoltage)
          ? [{ id: 'aux', label: '12V battery', node: <AuxWidget volts={state.auxVoltage} /> }]
          : []),
        {
          id: 'chargeWindow',
          label: 'Charging window',
          span: 2,
          node: <ChargeWindowWidget commands={commands} state={state} />,
        },
        { id: 'history', label: 'Charging history', span: 2, node: <ChargingHistoryWidget /> },
      ]
    : []

  return (
    <div className={`app ${editingLayout ? 'is-editing-layout' : ''}`}>
      <header className="app-bar">
        <div>
          <h1>ë-C4</h1>
          {/*
            The car's clock, not ours. "Updated 2 min ago" was true of the
            request and false of everything it described; this line is the one
            caveat every number on the screen inherits, so it states the age of
            the data rather than the age of the fetch. Our own read time only
            appears when the car has never given a timestamp to report, and in
            the offline banner, where the question really is when this device
            last managed to get through.
          */}
          <p className={`app-bar-sub ${stale ? 'is-stale' : ''}`}>
            {waking !== null
              ? 'Waking — the car answers within about 90 seconds'
              : vehicle.refreshing
                ? 'Refreshing…'
                : reportedAt
                  ? `Car reported ${relativeTime(reportedAt)}`
                  : `Read ${relativeTime(vehicle.fetchedAt)}`}
          </p>
        </div>
        <div className="app-bar-actions">
          {state && (
            <button
              type="button"
              className={`icon-button ${editingLayout ? 'is-selected' : ''}`}
              onClick={() => setEditingLayout((open) => !open)}
              aria-pressed={editingLayout}
              aria-label="Rearrange the dashboard"
            >
              <LayoutIcon />
            </button>
          )}
          {/*
            One button for "get me something newer", which is two different
            acts depending on what is wrong. Normally it re-reads: free,
            instant, no confirmation, because it never touches the car. Once
            the car has gone quiet past STALE_AFTER_MINUTES, re-reading
            provably cannot help — the record it reads is the one already on
            screen — and the only thing that can is a wake-up, so the button
            offers that instead and says what it costs first.
          */}
          <button
            type="button"
            className={`icon-button ${vehicle.refreshing ? 'is-spinning' : ''}`}
            onClick={() => (needsWake ? setConfirmWakeOpen(true) : void vehicle.refresh())}
            disabled={vehicle.refreshing || commands.active !== null}
            aria-label={needsWake ? 'Wake the car for a fresh reading' : 'Re-read vehicle state'}
          >
            <RefreshIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Settings"
          >
            <SettingsIcon />
          </button>
        </div>
      </header>

      {updateReady && (
        <button type="button" className="banner is-info" onClick={applyUpdate}>
          A new version is ready — tap to reload
        </button>
      )}

      {vinMissing && (
        <button type="button" className="banner is-warn" onClick={() => setSettingsOpen(true)}>
          No VIN configured — open Settings to add one
        </button>
      )}

      {/*
        Offline outranks whatever error the last attempt produced: with a
        stored reading on screen the app is still doing its job, and the
        bridge's own errors are only worth showing when the device could
        actually have reached it.
        Amber rather than the accent, though it is not a fault and there is
        nothing here to fix. Its job is to qualify every number below it — they
        are all as old as the label says — and in this app green means a thing
        is good, while amber is what "true, with a caveat" already looks like
        on the low-12V and charge-fault notes.
      */}
      {!online ? (
        <div className="banner is-warn" role="status">
          {vehicle.fetchedAt
            ? `Offline — showing the last reading, from ${relativeTime(vehicle.fetchedAt)}`
            : 'Offline — nothing has been read from the car on this device yet'}
        </div>
      ) : (
        vehicle.error && (
          <div className="banner is-error" role="alert">
            {vehicle.error.message}
          </div>
        )
      )}

      {/*
        Every other command reports on the tile that sent it. A wake-up is sent
        from the app bar, which has no room for a reason, so its failures come
        out here — and they have to land somewhere visible: the two ways a wake
        fails are the bridge's rate limit and a car that will not answer, and
        both look exactly like nothing happening.
      */}
      {wakeOutcome?.tone === 'error' && (
        <div className="banner is-error" role="alert">
          {wakeOutcome.message}
        </div>
      )}

      <main className="content">
        {vehicle.loading && !state ? (
          <div className="skeleton" aria-label="Loading vehicle state">
            <div className="skeleton-car" />
            <div className="skeleton-bar" />
          </div>
        ) : state ? (
          <>
            <CarHero />
            <WidgetGrid
              items={widgets}
              editing={editingLayout}
              onEditingChange={setEditingLayout}
            />
          </>
        ) : (
          <div className="empty">
            <p>No vehicle data yet.</p>
            <button type="button" className="button is-primary" onClick={() => void vehicle.refresh()}>
              Try again
            </button>
          </div>
        )}
      </main>

      {commands.active && <CommandOverlay command={commands.active} />}

      {/* Command results are drawn on the tile that raised them, which says
          nothing to a screen reader — so they are announced once, here. */}
      <p className="visually-hidden" role="status">
        {commands.outcome && !commands.outcome.leaving ? commands.outcome.message : ''}
      </p>

      {settingsOpen && (
        <SettingsSheet onClose={() => setSettingsOpen(false)} onLockChanged={lock.refreshMethod} />
      )}

      {confirmWakeOpen && (
        <WakeConfirmModal
          reportedAgo={reportedAt ? relativeTime(reportedAt) : 'nothing this device has seen'}
          onCancel={() => setConfirmWakeOpen(false)}
          onReadOnly={() => {
            setConfirmWakeOpen(false)
            void vehicle.refresh()
          }}
          onConfirm={() => {
            setConfirmWakeOpen(false)
            void wake()
          }}
        />
      )}
    </div>
  )
}
