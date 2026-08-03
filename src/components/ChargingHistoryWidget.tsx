import { useEffect, useState } from 'react'
import { fetchChargingSessions } from '../api/client'
import { ApiError, type ChargingSession } from '../api/types'
import { setFreeSession } from '../freeSessions'
import { useFreeSessions } from '../hooks/useFreeSessions'
import { useTariff } from '../hooks/useTariff'
import { costOf, formatMoney, type Tariff } from '../tariff'
import { ChartIcon } from './Icons'
import { Widget, WidgetNote } from './Widget'

/**
 * Charging history: energy added per completed session.
 *
 * Reads /vehicles/chargings, which is psa_car_controller's own database — it
 * never contacts the car, so it is safe to load on mount.
 *
 * Three layers, coarse to fine: the totals strip answers "how much charging is
 * this car doing" without reading the plot at all; the plot answers "and how is
 * that distributed"; the panel under it answers "what happened on that one
 * day", but only once a bar has been picked. Each one is a step further in, and
 * none of them repeats the one above it.
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

/**
 * What a session cost: worked out from the tariff when one is configured, and
 * otherwise whatever the bridge said. The bridge's figure is a single flat rate
 * applied to everything, so it is the fallback rather than the source of truth.
 */
function priceOf(session: ChargingSession, tariff: Tariff): number | null {
  return costOf(session, tariff)?.total ?? session.price
}

export function ChargingHistoryWidget() {
  const [sessions, setSessions] = useState<ChargingSession[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [asTable, setAsTable] = useState(false)
  const tariff = useTariff()
  const freeStarts = useFreeSessions()
  const freeSet = new Set(freeStarts)
  const isFree = (session: ChargingSession) =>
    session.startedAt !== null && freeSet.has(session.startedAt.getTime())

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
      <Widget icon={<ChartIcon />} label="Charging history" className="widget-history">
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
      <Widget icon={<ChartIcon />} label="Charging history" className="widget-history">
        <WidgetNote>Loading…</WidgetNote>
        <div className="chart-skeleton" aria-hidden="true" />
      </Widget>
    )
  }

  // The bridge returns [] until it has recorded enough, which is a normal
  // state on a fresh install rather than an error.
  if (sessions.length === 0) {
    return (
      <Widget icon={<ChartIcon />} label="Charging history" className="widget-history">
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
  // A session nobody could price is not a free charge, so it must not be added
  // in as a zero — it is left out of the total and the label says so. A
  // session marked free *is* known to have cost nothing, so it counts as
  // priced at £0 rather than being left out.
  const costs = recent.map((session) => (isFree(session) ? 0 : priceOf(session, tariff)))
  const priced = costs.filter((cost): cost is number => cost !== null)
  const spend = priced.reduce((sum, cost) => sum + cost, 0)
  const activeFree = active ? isFree(active) : false
  // The two-rate split for the selected session, so the panel can show where
  // the money went rather than just how much of it. Not for a free session —
  // there is no split to show.
  const activeCost = active && !activeFree ? costOf(active, tariff) : null

  return (
    <Widget icon={<ChartIcon />} label="Charging history" className="widget-history">
      <div className="widget-aside">
        <WidgetNote>
          Energy added · last {recent.length} session{recent.length === 1 ? '' : 's'}
        </WidgetNote>
        <div className="segmented is-mini" role="group" aria-label="How to show the history">
          <button
            type="button"
            className={`segment ${asTable ? '' : 'is-selected'}`}
            onClick={() => setAsTable(false)}
            aria-pressed={!asTable}
          >
            Chart
          </button>
          <button
            type="button"
            className={`segment ${asTable ? 'is-selected' : ''}`}
            onClick={() => setAsTable(true)}
            aria-pressed={asTable}
          >
            Table
          </button>
        </div>
      </div>

      {/* The headline figures, sunk into their own panels so they read as a
          summary of the plot rather than as its first row of labels. */}
      <div className="history-stats">
        <Stat value={total < 100 ? total.toFixed(1) : total.toFixed(0)} unit="kWh" label="Total" />
        <Stat value={(total / recent.length).toFixed(1)} unit="kWh" label="Average" />
        {/* Currency leads its number, so it is part of the value rather than a
            trailing unit. */}
        <Stat
          value={priced.length === 0 ? '—' : formatMoney(spend)}
          label={priced.length === recent.length ? 'Spend' : 'Spend (partial)'}
        />
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
            <defs>
              {/*
                One hue, fading toward the baseline — a bar is denser where it
                is anchored and lighter where it ends, which lets the tops read
                against the surface without the mark shouting. In user space,
                not per bar: a short bar must not get the whole ramp squeezed
                into it, or height would stop being the only thing encoding
                magnitude.
              */}
              <linearGradient
                id="history-bar"
                gradientUnits="userSpaceOnUse"
                x1="0"
                y1={PAD.top}
                x2="0"
                y2={BASE_Y}
              >
                <stop offset="0" stopColor="var(--series)" />
                <stop offset="1" stopColor="var(--series-deep)" />
              </linearGradient>
            </defs>

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

            {/* The selection, as a lit band behind the bar rather than as a
                recolouring of it — the mark keeps meaning magnitude and nothing
                else, and the band is what says "this one". */}
            {selected !== null && (
              <rect
                className="chart-slot"
                x={PAD.left + band * selected}
                y={PAD.top}
                width={band}
                height={PLOT_H}
                rx="6"
              />
            )}

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
                  {/* A mark, not a recolour — the bar itself keeps meaning
                      magnitude and nothing else. */}
                  {isFree(session) && (
                    <circle cx={x + barWidth - 3} cy={y + 4} r="2.5" className="chart-free-dot" />
                  )}
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
                  className={`chart-tick ${selected === index ? 'is-active' : ''}`}
                  textAnchor="middle"
                >
                  {shortDate(session.startedAt)}
                </text>
              )
            })}
          </svg>

          <div className={`history-detail ${active ? '' : 'is-empty'}`}>
            {active ? (
              <>
                <div className="history-detail-head">
                  <div className="history-detail-title">
                    <p className="history-detail-date">{shortDate(active.startedAt)}</p>
                    {/* Free charging (a workplace charger, say) has no tariff
                        cost, so it is a fact recorded about the session rather
                        than something worked out from it — a toggle, not a
                        derived figure. */}
                    {active.startedAt && (
                      <button
                        type="button"
                        className={`free-toggle ${activeFree ? 'is-on' : ''}`}
                        aria-pressed={activeFree}
                        onClick={() => setFreeSession(active.startedAt as Date, !activeFree)}
                      >
                        {activeFree ? 'Free charge' : 'Mark as free'}
                      </button>
                    )}
                  </div>
                  <p className="history-detail-energy">
                    {active.energy === null ? '—' : active.energy.toFixed(1)}
                    <span>kWh</span>
                  </p>
                </div>

                {/* Where in the battery this charge happened, not just how big
                    it was — 20→80% and 60→100% are the same kWh and very
                    different events. */}
                {active.startLevel !== null && active.endLevel !== null && (
                  <div className="history-soc">
                    <span>{active.startLevel}%</span>
                    <div
                      className="soc-bar"
                      role="img"
                      aria-label={`Charged from ${active.startLevel} to ${active.endLevel} percent`}
                    >
                      <div
                        className="soc-bar-fill"
                        style={{
                          left: `${active.startLevel}%`,
                          width: `${Math.max(2, active.endLevel - active.startLevel)}%`,
                        }}
                      />
                    </div>
                    <span>{active.endLevel}%</span>
                  </div>
                )}

                <div className="history-detail-meta">
                  <span>{duration(active.durationMinutes)}</span>
                  {active.mode && <span>{active.mode}</span>}
                  {activeFree ? (
                    <span className="is-free">Free</span>
                  ) : (
                    priceOf(active, tariff) !== null && (
                      <span>{formatMoney(priceOf(active, tariff) as number)}</span>
                    )
                  )}
                </div>

                {/*
                  Where the money went, but only when the session actually
                  straddled the two rates — on a charge that sat entirely inside
                  the cheap window this would just be the energy figure written
                  out a second time.
                */}
                {activeCost && activeCost.nightKwh >= 0.05 && activeCost.dayKwh >= 0.05 && (
                  <p className="history-split">
                    <span className="is-night">{activeCost.nightKwh.toFixed(1)} kWh</span> at{' '}
                    {tariff.nightRate.toFixed(2)}p · {activeCost.dayKwh.toFixed(1)} kWh at{' '}
                    {tariff.dayRate.toFixed(2)}p
                  </p>
                )}
              </>
            ) : (
              <span className="chart-hint">Tap a bar for the detail of that session</span>
            )}
          </div>
        </>
      )}
    </Widget>
  )
}

/** One headline figure from the plotted window. */
function Stat({ value, unit, label }: { value: string; unit?: string; label: string }) {
  return (
    <div className="history-stat">
      <p className="history-stat-value">
        {value}
        {unit && <span>{unit}</span>}
      </p>
      <p className="history-stat-label">{label}</p>
    </div>
  )
}
