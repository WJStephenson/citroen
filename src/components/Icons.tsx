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
