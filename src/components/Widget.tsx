import type { CSSProperties, ReactNode } from 'react'
import type { CommandOutcome } from '../hooks/useCommands'
import { CheckIcon, CrossIcon } from './Icons'

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
 * How far the outermost point of a lobed shape sits from the tile's centre, as
 * a fraction of the tile's width.
 *
 * A clip-path in objectBoundingBox units is *not* clamped to the box, but the
 * tile's background is — so a lobe tip that reaches past 0.5 has nothing
 * painted under it and comes out sliced square rather than pointed. The clover
 * and the sunny reached 0.513 and 0.512, which chopped a flat edge onto the tip
 * pointing at each of the four compass points, ~3px of it on a 228px tile.
 *
 * Held just inside 0.5 rather than exactly on it, so antialiasing has a pixel
 * to work with. Normalising every shape to the same figure is also what makes
 * the lobed tiles read as one size in the grid, rather than each being as big
 * as its own amplitude happened to make it.
 */
const OUTER = 0.497

/**
 * r(θ) = base + amplitude·cos(lobes·θ), sampled as a closed polyline, then
 * scaled to fit the tile — see OUTER. base and amplitude below are therefore
 * about the *proportions* of a shape, how deep its lobes are against its body;
 * the overall size is not theirs to set.
 *
 * Sampling scales with the lobe count so every shape gets roughly the same
 * number of points per lobe — enough that the curve reads as smooth at the
 * ~180px a tile actually occupies, and no more, since these paths ship in the
 * document.
 */
function lobed(lobes: number, base: number, amplitude: number): string {
  const fit = OUTER / (base + amplitude)
  const radius = base * fit
  const swing = amplitude * fit
  const steps = Math.max(96, lobes * 14)
  const points: string[] = []
  for (let i = 0; i < steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2
    const r = radius + swing * Math.cos(lobes * angle)
    points.push(`${(0.5 + r * Math.cos(angle)).toFixed(3)},${(0.5 + r * Math.sin(angle)).toFixed(3)}`)
  }
  return `M${points.join('L')}Z`
}

/*
 * Amplitude is what costs usable area: the shape's smallest radius is
 * base - amplitude once fitted, and everything in the tile has to sit inside
 * that circle. The deepest shape here, the clover, still leaves a 0.385 radius
 * — 71px on a 184px tile — which comfortably clears the widest thing any of
 * them holds.
 */
const SHAPES: Partial<Record<WidgetShape, string>> = {
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
  /** This tile's own command is in flight — draws the travelling ring. */
  working?: boolean
  /** How this tile's last command finished. Shown over its face, then dropped. */
  outcome?: CommandOutcome | null
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
  outcome = null,
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

      {/*
        A light travelling round the tile's own edge while its command is in
        flight, drawn two ways because the tiles have two kinds of edge.

        A lobed tile already owns its outline as a path, so the ring is that
        same path stroked, and the light is a gap in its dash pattern running
        along it — a band of even width that follows every lobe. A box tile has
        no path, so there the ring is a mask cut from the element's own border,
        and the light is a conic gradient turning behind it.
      */}
      {working &&
        (SHAPES[shape] ? (
          <svg
            className="widget-trace"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            aria-hidden="true"
            focusable="false"
          >
            {/* pathLength normalises every shape to the same 100 units, so one
                dash pattern gives the same-looking comet on all of them however
                much outline the lobes actually add. */}
            <path d={SHAPES[shape]} pathLength={100} />
          </svg>
        ) : (
          <span className="widget-ring" aria-hidden="true">
            <span className="widget-ring-sweep" />
          </span>
        ))}

      {/*
        The result, over the tile that asked for it. Announced once, centrally,
        in App — so this copy is hidden from assistive tech rather than read out
        a second time — and inert, so a tap during it still reaches the tile.
      */}
      {outcome && (
        <div
          key={outcome.id}
          className={`widget-outcome is-${outcome.tone} ${outcome.leaving ? 'is-leaving' : ''}`}
          aria-hidden="true"
        >
          <span className="widget-outcome-mark">
            {outcome.tone === 'ok' ? <CheckIcon /> : <CrossIcon />}
          </span>
          <p className="widget-outcome-text">{outcome.message}</p>
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
