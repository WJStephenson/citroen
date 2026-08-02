import { useEffect, useRef, useState, type ReactNode } from 'react'

interface Tab {
  id: string
  label: string
  icon: ReactNode
  content: ReactNode
}

/**
 * Three swiped-between pages, switched by a floating bottom nav: home (the
 * overview — hero, battery, status), car control (things you do right now —
 * precondition, find the car), and charge management (things you configure —
 * limit, window, history). Each is a full page rather than a shared scroll,
 * so the bar always reflects "where you are" the way a native app's would.
 *
 * Swiping is native horizontal scroll-snap, not custom touch tracking, so it
 * gets vertical-scroll passthrough and rubber-banding for free and can't
 * fight the page's own scroll or the pull-to-refresh gesture.
 */
export function ControlTabs({ tabs }: { tabs: Tab[] }) {
  const [active, setActive] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const panelRefs = useRef<(HTMLDivElement | null)[]>([])

  const goTo = (index: number) => {
    panelRefs.current[index]?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' })
  }

  // Keeps the nav in sync when the active page changes by swipe rather than
  // by tapping a nav item.
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    let frame = 0
    const onScroll = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const width = track.clientWidth
        if (!width) return
        const index = Math.round(track.scrollLeft / width)
        setActive((current) => (current === index ? current : index))
      })
    }
    track.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      track.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [])

  return (
    <div className="tabs">
      <div className="tabs-track" ref={trackRef}>
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            id={`panel-${tab.id}`}
            className="tabs-panel"
            role="tabpanel"
            aria-labelledby={`tab-${tab.id}`}
            ref={(el) => {
              panelRefs.current[index] = el
            }}
          >
            {tab.content}
          </div>
        ))}
      </div>

      {/* Non-blocking wrapper, like .overlay: only the pill itself catches taps. */}
      <div className="bottom-nav">
        <div className="bottom-nav-card" role="tablist" aria-label="App sections">
          {tabs.map((tab, index) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={active === index}
              aria-controls={`panel-${tab.id}`}
              aria-label={tab.label}
              className={`bottom-nav-item ${active === index ? 'is-selected' : ''}`}
              onClick={() => goTo(index)}
            >
              {tab.icon}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
