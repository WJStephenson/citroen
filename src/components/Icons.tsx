/**
 * Inline SVG icons.
 *
 * These replace the text glyphs ⟳ and ⚙, which sat off-centre and rendered at
 * unpredictable sizes: a glyph is positioned on the text baseline with
 * font-specific side bearings, so no amount of centring on the button fixes it,
 * and its apparent size depends on the font that happens to resolve. An SVG has
 * no baseline and a known viewBox, so it centres exactly and scales predictably.
 */

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
}

/* Widget headers carry a lighter stroke than the 44px app-bar buttons: at 15px
   a 2px stroke fills in and the glyph reads as a blob. */
const light = { ...base, strokeWidth: 1.6 }

export function RefreshIcon() {
  return (
    <svg {...base}>
      {/*
        The arc sweeps 315° and then runs a short line to (20,8), which is
        exactly the arrowhead's corner — otherwise the head floats detached
        from the end of the arc.
      */}
      <path d="M20 12a8 8 0 1 1-2.34-5.66L20 8" />
      <path d="M20 3.5V8h-4.5" />
    </svg>
  )
}

export function SettingsIcon() {
  return (
    <svg {...base}>
      <line x1="4" y1="8" x2="20" y2="8" />
      <circle cx="15" cy="8" r="2.4" />
      <line x1="4" y1="16" x2="20" y2="16" />
      <circle cx="9" cy="16" r="2.4" />
    </svg>
  )
}

/** Rearrange: four tiles, one lifted out of the grid. */
export function LayoutIcon() {
  return (
    <svg {...base} strokeWidth={1.8}>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="14.5" y="2.5" width="7" height="7" rx="2" />
    </svg>
  )
}

export function CheckIcon() {
  return (
    <svg {...base}>
      <path d="M5 12.5 10 17.5 19 7" />
    </svg>
  )
}

/* Two separate strokes rather than one path with a jump in it: they are drawn
   on in turn when a command fails, and a single path would draw the invisible
   move between the arms as if it were part of the mark. */
export function CrossIcon() {
  return (
    <svg {...base}>
      <line x1="6.5" y1="6.5" x2="17.5" y2="17.5" />
      <line x1="17.5" y1="6.5" x2="6.5" y2="17.5" />
    </svg>
  )
}

export function BoltIcon() {
  return (
    <svg {...light}>
      <path d="M13 3 5 13.5h5.5L10 21l8-10.5h-5.5L13 3Z" />
    </svg>
  )
}

/** Range: a road running to the horizon. */
export function RangeIcon() {
  return (
    <svg {...light}>
      <path d="M4 20 9.5 4M20 20 14.5 4" />
      <path d="M12 6v2M12 12v2M12 18v2" />
    </svg>
  )
}

export function PlugIcon() {
  return (
    <svg {...light}>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-6 6 6 6 0 0 1-6-6V8Z" />
      <path d="M12 17v4" />
    </svg>
  )
}

export function ThermometerIcon() {
  return (
    <svg {...light}>
      <path d="M14 14.5V5a2 2 0 1 0-4 0v9.5a4 4 0 1 0 4 0Z" />
      <circle cx="12" cy="17.5" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  )
}

/** Odometer: a trip counter's needle at rest. */
export function OdometerIcon() {
  return (
    <svg {...light}>
      <path d="M4.2 17.5a9 9 0 1 1 15.6 0" />
      <path d="M12 13.5 16 9.5" />
      <circle cx="12" cy="14" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

export function BatteryIcon() {
  return (
    <svg {...light}>
      <rect x="2.5" y="7" width="16" height="10" rx="2.5" />
      <path d="M21.5 10.5v3" />
      <path d="M6.5 12h4M8.5 10v4" />
      <path d="M13 12h2.5" />
    </svg>
  )
}

/** Pre-conditioning: air moving through the cabin. */
export function ClimateIcon() {
  return (
    <svg {...light}>
      <path d="M3 8h11a3 3 0 1 0-3-3" />
      <path d="M3 12.5h14.5a3 3 0 1 1-3 3" />
      <path d="M3 17h7" />
    </svg>
  )
}

/** A headlamp throwing a beam. */
export function LightsIcon() {
  return (
    <svg {...light}>
      <path d="M3 5h3a7 7 0 0 1 0 14H3Z" />
      <path d="M15.5 8.5h5.5M16.5 12h4.5M15.5 15.5h5.5" />
    </svg>
  )
}

/** The horn: a cone and the noise coming out of it. */
export function HornIcon() {
  return (
    <svg {...light}>
      <path d="M3 9.5h3.5L11 6v12L6.5 14.5H3Z" />
      <path d="M14.5 9.5a4 4 0 0 1 0 5" />
      <path d="M17.5 7a8 8 0 0 1 0 10" />
    </svg>
  )
}

/** A closed padlock. */
export function LockIcon() {
  return (
    <svg {...light}>
      <rect x="5" y="11" width="14" height="9" rx="2.2" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  )
}

/** A padlock with its shackle swung open. */
export function UnlockIcon() {
  return (
    <svg {...light}>
      <rect x="5" y="11" width="14" height="9" rx="2.2" />
      <path d="M8 11V8a4 4 0 0 1 7.5-2.2" />
    </svg>
  )
}

/** Charge limit: a battery filled to a chosen mark. */
export function LimitIcon() {
  return (
    <svg {...light}>
      <rect x="2.5" y="7" width="16" height="10" rx="2.5" />
      <path d="M21.5 10.5v3" />
      <path d="M5.5 10h5.5v4H5.5z" fill="currentColor" stroke="none" />
      <path d="M13.5 5.5v13" />
    </svg>
  )
}

export function ClockIcon() {
  return (
    <svg {...light}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  )
}

/** A pin dropped on a map. */
export function PinIcon() {
  return (
    <svg {...light}>
      <path d="M12 21.5c4-4.2 7-8 7-11.5a7 7 0 1 0-14 0c0 3.5 3 7.3 7 11.5Z" />
      <circle cx="12" cy="10" r="2.4" />
    </svg>
  )
}

export function ChartIcon() {
  return (
    <svg {...light}>
      <path d="M4 20V4" />
      <path d="M4 20h16" />
      <path d="M8.5 20v-6M13 20v-9.5M17.5 20V7" />
    </svg>
  )
}
