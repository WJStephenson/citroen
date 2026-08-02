import type { CSSProperties, ReactNode } from 'react'

/**
 * The one container every section on the dashboard is built from.
 *
 * The silhouettes are borrowed from Material 3 Expressive's shape set, but each
 * one has to earn its place: the shape says what *kind* of reading the tile
 * holds, so the grid is legible at a glance before a single word is read.
 *
 *   squircle — anything with a control or a long line of text in it. A shaped
 *              tile has no corners to put a slider or a chart in.
 *   circle   — the 12V reading, where the tile's own edge is the dial.
 *   cookie   — cabin temperature. Twelve soft lobes: a comfort number.
 *   clover   — the cabin climate. Four broad petals, the roundest thing here,
 *              for the one tile that is about moving air.
 *   sunny    — the lights. An eight-lobed sun is what a lamp looks like.
 *   boom     — the horn. A fine ripple all the way round, which is what sound
 *              leaving a car actually does.
 *
 * All four lobed shapes come off one polar wave, and all of them are cut with a
 * clipPath in objectBoundingBox units so a single definition scales to any cell
 * size. `clip-path: path()` would be fixed in px and break the moment the grid
 * reflowed.
 *
 * Corner radii carry the rest of it — see the tile signatures in styles.css.
 */

export type WidgetShape = 'squircle' | 'circle' | 'cookie' | 'clover' | 'sunny' | 'boom'

/**
 * r(θ) = base + amplitude·cos(lobes·θ), sampled as a closed polyline.
 *
 * Sampling scales with the lobe count so every shape gets roughly the same
 * number of points per lobe — enough that the curve reads as smooth at the
 * ~180px a tile actually occupies, and no more, since these paths ship in the
 * document.
 */
function lobed(lobes: number, base: number, amplitude: number): string {
  const steps = Math.max(96, lobes * 14)
  const points: string[] = []
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2
    const r = base + amplitude * Math.cos(lobes * angle)
    points.push(`${(0.5 + r * Math.cos(angle)).toFixed(3)},${(0.5 + r * Math.sin(angle)).toFixed(3)}`)
  }
  return `M${points.join('L')}Z`
}

/*
 * Amplitude is what costs usable area: the shape's smallest radius is
 * base - amplitude, and everything in the tile has to fit inside that circle.
 * The deepest shape here, the clover, still leaves a 0.368 radius — 68px on a
 * 184px tile — which comfortably clears the widest thing any of them holds.
 */
const SHAPES: Record<string, string> = {
  cookie: lobed(12, 0.465, 0.034),
  // Broad petals rather than deep ones: past about 0.06 the valleys pinch and
  // the clover stops reading as four soft lobes and starts reading as a
  // rounded diamond.
  clover: lobed(4, 0.455, 0.058),
  // Deeper than the cookie on purpose. Sunny and boom are the only two shapes
  // that sit side by side, so the rays have to be obviously coarser than the
  // horn's ripple or the pair reads as one shape drawn twice.
  sunny: lobed(8, 0.45, 0.062),
  boom: lobed(18, 0.475, 0.022),
}

/**
 * Rendered once, near the top of the app. clipPath references are document-wide,
 * so repeating these per widget would duplicate several hundred points a tile.
 */
export function WidgetShapeDefs() {
  return (
    <svg className="shape-defs" aria-hidden="true" focusable="false">
      <defs>
        {Object.entries(SHAPES).map(([name, path]) => (
          <clipPath key={name} id={`widget-${name}`} clipPathUnits="objectBoundingBox">
            <path d={path} />
          </clipPath>
        ))}
      </defs>
    </svg>
  )
}

export interface FloodProps {
  /**
   * 0–1. A fraction rather than a percentage because the waterline is worked
   * out in px against the tile's own height: mask-position resolves a
   * percentage against the positioning area *minus the image*, which would put
   * the wave up to a wave-height above the line it is supposed to mark.
   */
  fraction: number
  /** The fill colour; also what the submerged copy of the content sits on. */
  color: string
}

export interface ActionProps {
  /** Spoken label — says what pressing the tile does, not what it is called. */
  label: string
  onPress: () => void
  disabled?: boolean
}

interface Props {
  icon: ReactNode
  label: string
  shape?: WidgetShape
  /** A sustained state — pre-conditioning actually running, say. */
  active?: boolean
  /** This tile's own command is in flight. */
  working?: boolean
  /**
   * Makes the whole tile one button.
   *
   * A shaped tile cannot hold a full-width button — the corners it would need
   * are the corners the shape does not have. So the tile becomes the button
   * instead, which is also the more honest read: there is one thing to press
   * and it is the whole thing.
   */
  action?: ActionProps
  /**
   * Fills the widget from the bottom with a wave, and redraws the content in
   * dark ink below the waterline so the numbers are cut by it.
   *
   * The content is rendered a second time to do that, so a widget using flood
   * must be purely presentational — no controls, no state below this point.
   */
  flood?: FloodProps
  className?: string
  style?: CSSProperties
  children?: ReactNode
}

export function Widget({
  icon,
  label,
  shape = 'squircle',
  active = false,
  working = false,
  action,
  flood,
  className = '',
  style,
  children,
}: Props) {
  const face = (
    <div className="widget-face">
      <header className="widget-head">
        <span className="widget-icon" aria-hidden="true">
          {icon}
        </span>
        <h2>{label}</h2>
      </header>
      {/* The label is a corner tag; everything else is one block the tile can
          centre or push to its foot without the label moving with it. */}
      <div className="widget-body">{children}</div>
    </div>
  )

  const rounded = shape !== 'squircle'

  return (
    <section
      className={`widget is-${shape} ${rounded ? 'is-rounded' : ''} ${active ? 'is-active' : ''} ${
        working ? 'is-working' : ''
      } ${className}`
        .replace(/\s+/g, ' ')
        .trim()}
      style={style}
    >
      {face}

      {action && (
        <button
          type="button"
          className="widget-hit"
          aria-label={action.label}
          onClick={action.onPress}
          disabled={action.disabled}
        />
      )}

      {flood && flood.fraction > 0 && (
        <div
          className="widget-flood"
          aria-hidden="true"
          style={{ '--flood-level': flood.fraction, '--flood-color': flood.color } as CSSProperties}
        >
          {face}
        </div>
      )}
    </section>
  )
}

/** The number-and-unit pair every stat widget leads with. */
export function WidgetValue({
  value,
  unit,
  size = 'md',
}: {
  value: ReactNode
  unit?: ReactNode
  size?: 'md' | 'lg'
}) {
  return (
    <p className={`widget-value is-${size}`}>
      {value}
      {unit !== undefined && <span className="widget-unit">{unit}</span>}
    </p>
  )
}

/** The one line of context under the number. */
export function WidgetNote({ children, tone }: { children: ReactNode; tone?: 'warn' }) {
  return <p className={`widget-note ${tone === 'warn' ? 'is-warn' : ''}`}>{children}</p>
}
