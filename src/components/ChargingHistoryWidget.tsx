import { useEffect, useState } from 'react'
import { fetchChargingSessions } from '../api/client'
import { ApiError, type ChargingSession } from '../api/types'
import { ChartIcon } from './Icons'
import { Widget, WidgetNote } from './Widget'

/**
 * Charging history: energy added per completed session.
 *
 * Reads /vehicles/chargings, which is psa_car_controller's own database — it
 * never contacts the car, so it is safe to load on mount.
 *
 * One series, so no legend: the heading says what is plotted. Values are
 * direct-labelled selectively (the largest session, and whichever is selected);
 * the y-axis carries the rest, and the table view carries all of them.
 *
 * The speed-vs-state-of-charge curve is deliberately NOT here — the bridge
 * records it but exposes no route for it. See the README.
 */

// viewBox units. The height includes the x-axis band so the card never needs
// its own scrollbar to show the dates.
const W = 320
const PLOT_H = 108
const PAD = { top: 16, right: 6, bottom: 20, left: 30 }
const H = PAD.top + PLOT_H + PAD.bottom
const BASE_Y = PAD.top + PLOT_H
const MAX_BAR = 24 // never fill the band; the leftover is air
const BAR_GAP = 2 // surface gap between adjacent bars
const RADIUS = 4 // rounded data-end, square at the baseline

/** Clean axis maximum, so ticks land on round numbers. */
function niceMax(value: number): number {
  if (value <= 0) return 10
  const step = value <= 10 ? 2 : value <= 30 ? 5 : value <= 60 ? 10 : 20
  return Math.ceil(value / step) * step
}

/** Rounded at the top, square where it meets the baseline. */
function barPath(x: number, y: number, width: number, height: number): string {
  const r = Math.min(RADIUS, width / 2, height)
  return [
    `M${x},${y + height}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + width - r}`,
    `Q${x + width},${y} ${x + width},${y + r}`,
    `V${y + height}`,
    'Z',
  ].join(' ')
}

const shortDate = (date: Date | null) =>
  date ? date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '—'

function duration(minutes: number | null): string {
  if (minutes === null || minutes <= 0) return '—'
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

export function ChargingHistoryWidget() {
  const [sessions, setSessions] = useState<ChargingSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)

  const load = () => {
    setError(null)
    fetchChargingSessions()
      .then(setSessions)
      .catch((caught: unknown) =>
        setError(caught instanceof ApiError ? caught.message : 'Could not load charging history.'),
      )
  }

  useEffect(load, [])

  if (error) {
    return (
      <Widget icon={<ChartIcon />} label="Charging history">
        <WidgetNote>{error}</WidgetNote>
        <div className="row">
          <button type="button" className="button" onClick={load}>
            Try again
          </button>
        </div>
      </Widget>
    )
  }

  if (sessions === null) {
    return (
      <Widget icon={<ChartIcon />} label="Charging history">
        <WidgetNote>Loading…</WidgetNote>
        <div className="chart-skeleton" aria-hidden="true" />
      </Widget>
    )
  }

  // The bridge returns [] until it has recorded enough, which is a normal
  // state on a fresh install rather than an error.
  if (sessions.length === 0) {
    return (
      <Widget icon={<ChartIcon />} label="Charging history">
        <WidgetNote>No sessions recorded yet. The first one will appear here once it finishes.</WidgetNote>
      </Widget>
    )
  }

  const recent = sessions.slice(-10)
  const values = recent.map((s) => s.energy ?? 0)
  const max = niceMax(Math.max(...values))
  const peakIndex = values.indexOf(Math.max(...values))

  const band = (W - PAD.left - PAD.right) / recent.length
  const barWidth = Math.min(MAX_BAR, Math.max(6, band - BAR_GAP * 2))
  const yFor = (value: number) => BASE_Y - (value / max) * PLOT_H
  const ticks = [0, max / 2, max]

  const active = selected !== null ? recent[selected] : null
  const total = values.reduce((sum, v) => sum + v, 0)

  return (
    <Widget icon={<ChartIcon />} label="Charging history">
      <div className="widget-aside">
        <WidgetNote>
          Energy added · last {recent.length} session{recent.length === 1 ? '' : 's'}
        </WidgetNote>
        <button
          type="button"
          className="button is-small"
          onClick={() => setAsTable((value) => !value)}
          aria-pressed={asTable}
        >
          {asTable ? 'Chart' : 'Table'}
        </button>
      </div>

      {asTable ? (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="visually-hidden">Charging sessions, energy added in kWh</caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">kWh</th>
                <th scope="col">SoC</th>
                <th scope="col">Time</th>
              </tr>
            </thead>
            <tbody>
              {[...recent].reverse().map((session, index) => (
                <tr key={`${session.startedAt?.getTime() ?? index}`}>
                  <td>{shortDate(session.startedAt)}</td>
                  <td>{session.energy === null ? '—' : session.energy.toFixed(1)}</td>
                  <td>
                    {session.startLevel === null || session.endLevel === null
                      ? '—'
                      : `${session.startLevel}→${session.endLevel}%`}
                  </td>
                  <td>{duration(session.durationMinutes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <svg
            className="chart"
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`Energy added per charging session. ${recent.length} sessions, ${total.toFixed(0)} kWh total, largest ${max} kWh.`}
          >
            {/* Hairline, solid, one step off the surface. */}
            {ticks.map((tick) => (
              <g key={tick}>
                <line
                  x1={PAD.left}
                  x2={W - PAD.right}
                  y1={yFor(tick)}
                  y2={yFor(tick)}
                  className="chart-grid"
                />
                <text x={PAD.left - 6} y={yFor(tick) + 3} className="chart-tick" textAnchor="end">
                  {tick}
                </text>
              </g>
            ))}

            {recent.map((session, index) => {
              const value = session.energy ?? 0
              const x = PAD.left + band * index + (band - barWidth) / 2
              const y = yFor(value)
              const height = Math.max(1, BASE_Y - y)
              const isActive = selected === index
              const dimmed = selected !== null && !isActive
              // Label the extreme and the selection only — never every bar.
              const labelled = isActive || (selected === null && index === peakIndex)

              return (
                <g key={session.startedAt?.getTime() ?? index}>
                  <path
                    d={barPath(x, y, barWidth, height)}
                    className={`chart-bar ${dimmed ? 'is-dimmed' : ''}`}
                  />
                  {labelled && (
                    <text x={x + barWidth / 2} y={y - 5} className="chart-value" textAnchor="middle">
                      {value.toFixed(1)}
                    </text>
                  )}
                  {/* Hit target spans the whole band, well past the 24px minimum. */}
                  <rect
                    x={PAD.left + band * index}
                    y={PAD.top}
                    width={band}
                    height={PLOT_H}
                    fill="transparent"
                    className="chart-hit"
                    onClick={() => setSelected(isActive ? null : index)}
                  />
                </g>
              )
            })}

            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={BASE_Y}
              y2={BASE_Y}
              className="chart-axis"
            />

            {recent.map((session, index) => {
              // Thin the date labels so they never collide.
              const every = recent.length > 6 ? 2 : 1
              if (index % every !== 0 && selected !== index) return null
              return (
                <text
                  key={session.startedAt?.getTime() ?? index}
                  x={PAD.left + band * index + band / 2}
                  y={BASE_Y + 13}
                  className="chart-tick"
                  textAnchor="middle"
                >
                  {shortDate(session.startedAt)}
                </text>
              )
            })}
          </svg>

          <div className="chart-readout">
            {active ? (
              <>
                <strong>{shortDate(active.startedAt)}</strong>
                <span>
                  {active.startLevel !== null && active.endLevel !== null
                    ? `${active.startLevel}→${active.endLevel}%`
                    : '—'}
                </span>
                <span>{duration(active.durationMinutes)}</span>
                {active.mode && <span>{active.mode}</span>}
                {active.price !== null && <span>£{active.price.toFixed(2)}</span>}
              </>
            ) : (
              <span className="chart-hint">
                {total.toFixed(0)} kWh total · tap a bar for detail
              </span>
            )}
          </div>
        </>
      )}
    </Widget>
  )
}
