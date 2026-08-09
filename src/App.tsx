import { useCallback, useEffect, useState } from 'react'
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
import { RefreshConfirmModal } from './components/RefreshConfirmModal'
import { SettingsSheet } from './components/SettingsSheet'
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
import { getVin } from './config'
import { useAppLock } from './hooks/useAppLock'
import { useBatteryHealth } from './hooks/useBatteryHealth'
import { useCommands } from './hooks/useCommands'
import { useOnline } from './hooks/useOnline'
import { useVehicle } from './hooks/useVehicle'
import { LockScreen } from './lock/LockScreen'
import { applyUpdate, registerServiceWorker } from './sw-register'
import { isPlausibleAuxVoltage } from './units'

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
  const [confirmRefreshOpen, setConfirmRefreshOpen] = useState(false)
  const [, forceTick] = useState(0)

  // Telemetry only flows once the app is unlocked.
  const vehicle = useVehicle(!lock.locked)
  const soh = useBatteryHealth(!lock.locked)
  const online = useOnline()
  const commands = useCommands(vehicle.patch, vehicle.refresh, vehicle.state)
  // A deliberate refresh is the user asking the car itself, not the bridge cache.
  const liveRefresh = useCallback(() => vehicle.refresh({ live: true }), [vehicle])

  useEffect(() => registerServiceWorker(() => setUpdateReady(true)), [])

  // Keeps the "updated N min ago" label honest without re-polling the car.
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

  const stale = vehicle.fetchedAt !== null && Date.now() - vehicle.fetchedAt.getTime() > 45 * 60_000

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
          <p className="app-bar-sub">
            {vehicle.refreshing ? 'Refreshing…' : `Updated ${relativeTime(vehicle.fetchedAt)}`}
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
          <button
            type="button"
            className={`icon-button ${vehicle.refreshing ? 'is-spinning' : ''}`}
            onClick={() => setConfirmRefreshOpen(true)}
            disabled={vehicle.refreshing}
            aria-label="Refresh vehicle state from the car"
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

      <main className="content">
        {vehicle.loading && !state ? (
          <div className="skeleton" aria-label="Loading vehicle state">
            <div className="skeleton-car" />
            <div className="skeleton-bar" />
          </div>
        ) : state ? (
          <>
            <CarHero />
            {state.reportedAt && (
              <p className="reported-at">Car last reported {relativeTime(state.reportedAt)}</p>
            )}
            <WidgetGrid
              items={widgets}
              editing={editingLayout}
              onEditingChange={setEditingLayout}
            />
          </>
        ) : (
          <div className="empty">
            <p>No vehicle data yet.</p>
            <button type="button" className="button is-primary" onClick={() => setConfirmRefreshOpen(true)}>
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

      {confirmRefreshOpen && (
        <RefreshConfirmModal
          onCancel={() => setConfirmRefreshOpen(false)}
          onConfirm={() => {
            setConfirmRefreshOpen(false)
            void liveRefresh()
          }}
        />
      )}
    </div>
  )
}
