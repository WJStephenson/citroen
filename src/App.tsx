import { useCallback, useEffect, useMemo, useState } from 'react'
import { BatteryRing } from './components/BatteryRing'
import { ChargeLimitCard } from './components/ChargeLimitCard'
import { CommandOverlay } from './components/CommandOverlay'
import { FindCarCard } from './components/FindCarCard'
import { RefreshIcon, SettingsIcon } from './components/Icons'
import { ChargeWindowCard } from './components/ChargeWindowCard'
import { ChargingHistoryCard } from './components/ChargingHistoryCard'
import { PreconditionCard } from './components/PreconditionCard'
import { SettingsSheet } from './components/SettingsSheet'
import { StatusStrip } from './components/StatusStrip'
import { Toasts } from './components/Toasts'
import { getVin } from './config'
import { useAppLock } from './hooks/useAppLock'
import { useCommands } from './hooks/useCommands'
import { usePullToRefresh } from './hooks/usePullToRefresh'
import { useVehicle } from './hooks/useVehicle'
import { LockScreen } from './lock/LockScreen'
import { applyUpdate, registerServiceWorker } from './sw-register'

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
  const [updateReady, setUpdateReady] = useState(false)
  const [, forceTick] = useState(0)

  // Telemetry only flows once the app is unlocked.
  const vehicle = useVehicle(!lock.locked)
  const commands = useCommands(vehicle.patch, vehicle.refresh, vehicle.state)
  // A deliberate pull is the user asking the car itself, not the bridge cache.
  const liveRefresh = useCallback(() => vehicle.refresh({ live: true }), [vehicle])
  const pull = usePullToRefresh(liveRefresh, !lock.locked && !commands.active)

  useEffect(() => registerServiceWorker(() => setUpdateReady(true)), [])

  // Keeps the "updated N min ago" label honest without re-polling the car.
  useEffect(() => {
    const timer = window.setInterval(() => forceTick((n) => n + 1), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const vinMissing = useMemo(() => !getVin(), [settingsOpen])

  if (lock.locked) return <LockScreen method={lock.method} onUnlock={lock.unlock} />

  const stale = vehicle.fetchedAt !== null && Date.now() - vehicle.fetchedAt.getTime() > 45 * 60_000

  return (
    <div className="app" style={{ transform: pull.pull ? `translateY(${pull.pull}px)` : undefined }}>
      <div
        className={`pull-indicator ${pull.armed ? 'is-armed' : ''}`}
        style={{ opacity: pull.pull / pull.threshold }}
        aria-hidden="true"
      >
        {pull.armed ? 'Release to refresh' : 'Pull to refresh'}
      </div>

      <header className="app-bar">
        <div>
          <h1>ë-C4</h1>
          <p className="app-bar-sub">
            {vehicle.refreshing ? 'Refreshing…' : `Updated ${relativeTime(vehicle.fetchedAt)}`}
          </p>
        </div>
        <div className="app-bar-actions">
          <button
            type="button"
            className={`icon-button ${vehicle.refreshing ? 'is-spinning' : ''}`}
            onClick={() => void liveRefresh()}
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

      {vehicle.error && (
        <div className="banner is-error" role="alert">
          {vehicle.error.message}
        </div>
      )}

      <main className="content">
        {vehicle.loading && !vehicle.state ? (
          <div className="skeleton" aria-label="Loading vehicle state">
            <div className="skeleton-ring" />
            <div className="skeleton-line" />
            <div className="skeleton-line is-short" />
          </div>
        ) : vehicle.state ? (
          <>
            <BatteryRing
              level={vehicle.state.battery}
              range={vehicle.state.range}
              charging={vehicle.state.charging}
              stale={stale}
            />
            {vehicle.state.reportedAt && (
              <p className="reported-at">
                Car last reported {relativeTime(vehicle.state.reportedAt)}
              </p>
            )}
            <StatusStrip state={vehicle.state} />
            <PreconditionCard state={vehicle.state} commands={commands} />
            <ChargeLimitCard commands={commands} />
            <ChargeWindowCard commands={commands} />
            <FindCarCard commands={commands} />
            <ChargingHistoryCard />
          </>
        ) : (
          <div className="empty">
            <p>No vehicle data yet.</p>
            <button type="button" className="button is-primary" onClick={() => void liveRefresh()}>
              Try again
            </button>
          </div>
        )}
      </main>

      {commands.active && <CommandOverlay command={commands.active} />}
      <Toasts toasts={commands.toasts} onDismiss={commands.dismissToast} />

      {settingsOpen && (
        <SettingsSheet onClose={() => setSettingsOpen(false)} onLockChanged={lock.refreshMethod} />
      )}
    </div>
  )
}
