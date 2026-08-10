import { Component, type ErrorInfo, type ReactNode } from 'react'
import { clearSnapshot } from '../api/snapshot'

/**
 * The last thing between a render-time throw and a blank screen.
 *
 * This app is built to be answerable when nothing else is: the shell comes off
 * disk, the last reading comes out of localStorage, and the whole point is that
 * standing in an underground car park still gets you the charge. A React error
 * unmounts the entire tree, which turns all of that into white — and on a
 * cache-first PWA that white page comes back on every launch, because the shell
 * it is serving is the one that crashes.
 *
 * So a crash gets a way out rather than a void: what went wrong, a reload, and
 * — one level down — the option to drop the stored reading, since a snapshot
 * written by an older build is the one input here that can crash every render
 * on its own and that reloading alone will never clear.
 */

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // There is no error reporting service behind this app and there should not
    // be — it is one car and one household. The console is what a phone
    // attached to a laptop can actually read.
    console.error('Unhandled error', error, info.componentStack)
  }

  private readonly reload = () => window.location.reload()

  private readonly reset = () => {
    try {
      // Only the reading, never the settings: the VIN and the tariff are shared
      // state that other devices are holding too, and throwing them away here
      // would be a fix that spreads.
      clearSnapshot()
    } catch {
      // Nothing stored means nothing to blame; the reload is the fix either way.
    }
    window.location.reload()
  }

  override render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="app">
        <header className="app-bar">
          <div>
            <h1>ë-C4</h1>
            <p className="app-bar-sub is-stale">Something went wrong</p>
          </div>
        </header>
        <div className="banner is-error" role="alert">
          {error.message || 'The app stopped unexpectedly.'}
        </div>
        <main className="content">
          <div className="empty">
            <p>Nothing was sent to the car — this went wrong on the phone.</p>
            <button type="button" className="button is-primary" onClick={this.reload}>
              Reload
            </button>
            <button type="button" className="button is-quiet" onClick={this.reset}>
              Reload without the stored reading
            </button>
          </div>
        </main>
      </div>
    )
  }
}
