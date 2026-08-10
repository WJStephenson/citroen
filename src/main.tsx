import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { startSharedSettingsSync } from './api/sharedSettings'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles.css'

// Fire-and-forget: the app renders instantly from whatever was last mirrored
// to localStorage, the same offline-first stance the service worker takes
// with the shell itself, and updates live as fresh shared settings land.
startSharedSettingsSync()

const container = document.getElementById('root')
if (!container) throw new Error('#root missing from index.html')

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
