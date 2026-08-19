import { useEffect, useState } from 'react'
import { fetchChargingSessions } from '../api/client'
import { ApiError, type ChargingSession } from '../api/types'
import { locationForSession } from '../chargeLocations'
import { setFreeSession } from '../freeSessions'
import { useChargeLocations } from '../hooks/useChargeLocations'
import { useFreeSessions } from '../hooks/useFreeSessions'
import { useTariff } from '../hooks/useTariff'
import { startOfMonth } from '../periods'
import { costOf, formatMoney, type Tariff } from '../tariff'
import { ChartIcon, PinIcon } from './Icons'
import { MapTiles, mapsUrl } from './MapTiles'
import { Widget, WidgetNote } from './Widget'

/**
 * Charging history: energy added per completed session.
 *
 * Reads /vehicles/chargings, which is psa_car_controller's own database — it
 * never contacts the car, so it is safe to load on mount.
 *
 * Four layers, coarse to fine: the month line answers "what is this car
 * costing me" against the period a bill actually arrives for; the totals strip
 * answers "how much charging is it doing" over the window on screen; the plot
 * answers "and how is that distributed"; the panel under it answers "what
 * happened on that one day" — including *where* it happened, which is the only
 * part of a session the bridge does not record and the app has to have written
 * down itself (see chargeLocations.ts) — but only once a session has been
 * picked. Each one is a step further in, and none of them repeats the one
 * above it.
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
const MIN_BAR = 2 // still a mark, not a hairline, at the widest window
const RADIUS = 4 // rounded data-end, square at the baseline
/** Air either side of a bar, as a fraction of its band — proportional rather
    than a fixed 2 units, so a hundred sessions still leave daylight between
    the bars instead of the gap eating the mark. */
const BAR_GAP_RATIO = 0.18
/** Beyond this many bars the dates are thinned rather than drawn every band. */
const MAX_DATE_LABELS = 6
/** Roughly what "22 Dec" occupies in viewBox units — the clearance one date
    label needs before the next one starts touching it. */
const DATE_LABEL_W = 32

/**
 * How much history the chart and the totals strip cover.
 *
 * Ten sessions is roughly a month of home charging and is what the tile opens
 * on — recent enough that every bar is a drive somebody remembers. The longer
 * windows exist because the shape of a year is a different question from the
 * shape of a month: a battery that is taking less energy per session, or a
 * winter that costs half again as much, is only visible from further back.
 */
const RANGES = [10, 30, 0] as const
type Range = (typeof RANGES)[number]
/** 0 means everything the bridge has — an unknown number of sessions, so it
    cannot be spelled as one. */
const rangeLabel = (range: Range) => (range === 0 ? 'All' : String(range))

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
  /*
   * The selection is held as a session's start time, not as an index into the
   * window: the same session has a different index in every range, and the
   * table draws the list in the opposite order to the chart. Keyed this way,
   * widening the window or switching to the table keeps whatever was picked
   * picked — and it is already the key free sessions are recorded under.
   */
  const [selectedAt, setSelectedAt] = useState<number | null>(null)
  const [range, setRange] = useState<Range>(10)
  const [asTable, setAsTable] = useState(false)
  const tariff = useTariff()
  const chargeLocations = useChargeLocations()
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

  const recent = range === 0 ? sessions : sessions.slice(-range)
  const values = recent.map((s) => s.energy ?? 0)
  const max = niceMax(Math.max(...values))
  const peakIndex = values.indexOf(Math.max(...values))

  const band = (W - PAD.left - PAD.right) / recent.length
  const barWidth = Math.min(MAX_BAR, Math.max(MIN_BAR, band * (1 - BAR_GAP_RATIO * 2)))
  const yFor = (value: number) => BASE_Y - (value / max) * PLOT_H
  const ticks = [0, max / 2, max]

  const selected = recent.findIndex((s) => s.startedAt?.getTime() === selectedAt)
  const active = selected < 0 ? null : recent[selected]
  const total = values.reduce((sum, v) => sum + v, 0)
  // A session nobody could price is not a free charge, so it must not be added
  // in as a zero — it is left out of the total and the label says so. A
  // session marked free *is* known to have cost nothing, so it counts as
  // priced at £0 rather than being left out.
  const costs = recent.map((session) => (isFree(session) ? 0 : priceOf(session, tariff)))
  const priced = costs.filter((cost): cost is number => cost !== null)
  const spend = priced.reduce((sum, cost) => sum + cost, 0)
  const activeFree = active ? isFree(active) : false
  // Where the car was standing for this one. Nothing the bridge knows — it is
  // whatever was written down at the moment the charge began, so a session
  // from before this app started recording has none and says so.
  const activePlace = active ? locationForSession(active, chargeLocations) : null
  // The two-rate split for the selected session, so the panel can show where
  // the money went rather than just how much of it. Not for a free session —
  // there is no split to show.
  const activeCost = active && !activeFree ? costOf(active, tariff) : null

  /*
   * The calendar month, over every session the bridge has rather than the
   * window on screen — it is the one figure here that answers a question posed
   * from outside the app. An electricity bill covers a month, and "what has the
   * car cost me this month" cannot be read off a chart whose window the user
   * chose for a different reason. Month-to-date, like the odometer's periods.
   */
  const monthStart = startOfMonth(new Date())
  const month = sessions.filter((s) => s.startedAt && s.startedAt >= monthStart)
  const monthEnergy = month.reduce((sum, s) => sum + (s.energy ?? 0), 0)
  const monthCosts = month.map((s) => (isFree(s) ? 0 : priceOf(s, tariff)))
  const monthPriced = monthCosts.filter((cost): cost is number => cost !== null)
  const monthSpend = monthPriced.reduce((sum, cost) => sum + cost, 0)

  const select = (session: ChargingSession | undefined) => {
    const key = session?.startedAt?.getTime() ?? null
    setSelectedAt(key === selectedAt ? null : key)
  }

  return (
    <Widget icon={<ChartIcon />} label="Charging history" className="widget-history">
      <div className="widget-aside">
        <div className="segmented is-mini is-triple" role="group" aria-label="How far back to show">
          {RANGES.map((option) => (
            <button
              key={option}
              type="button"
              className={`segment ${range === option ? 'is-selected' : ''}`}
              onClick={() => setRange(option)}
              aria-pressed={range === option}
            >
              {rangeLabel(option)}
            </button>
          ))}
        </div>
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

      {/* "last 30" while the window is genuinely a window, "all 64" once it is
          everything there is — the count is the same either way, but only one
          of the two implies there is more behind it. */}
      <WidgetNote>
        Energy added · {range === 0 ? 'all' : 'last'} {recent.length} session
        {recent.length === 1 ? '' : 's'}
      </WidgetNote>

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

      {month.length > 0 && (
        <p className="history-month">
          <span className="history-month-label">This month</span>
          <span>{monthEnergy.toFixed(1)} kWh</span>
          {monthPriced.length > 0 && (
            <span className="history-month-spend">
              {formatMoney(monthSpend)}
              {monthPriced.length === month.length ? '' : ' so far'}
            </span>
          )}
          <span className="history-month-count">
            {month.length} session{month.length === 1 ? '' : 's'}
          </span>
        </p>
      )}

      {asTable ? (
        <div className="table-wrap">
          <table className="data-table">
            <caption className="visually-hidden">
              Charging sessions, energy added in kWh. Choose a date for that session's detail.
            </caption>
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">kWh</th>
                <th scope="col">SoC</th>
                <th scope="col">Time</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {/* Newest first: a table is read from the top, and the chart's
                  left-to-right time axis has no equivalent here. */}
              {[...recent].reverse().map((session, index) => {
                const cost = isFree(session) ? null : priceOf(session, tariff)
                const picked = session.startedAt?.getTime() === selectedAt
                return (
                  <tr key={`${session.startedAt?.getTime() ?? index}`} className={picked ? 'is-selected' : ''}>
                    <td>
                      {/*
                        The date is the row's own control, so the table has the
                        same reach as the chart — including the free-charge
                        toggle, which lives in the shared detail panel below and
                        used to be reachable only by tapping the right bar.
                      */}
                      <button
                        type="button"
                        className="row-select"
                        aria-pressed={picked}
                        onClick={() => select(session)}
                      >
                        {shortDate(session.startedAt)}
                      </button>
                    </td>
                    <td>{session.energy === null ? '—' : session.energy.toFixed(1)}</td>
                    <td>
                      {session.startLevel === null || session.endLevel === null
                        ? '—'
                        : `${session.startLevel}→${session.endLevel}%`}
                    </td>
                    <td>{duration(session.durationMinutes)}</td>
                    <td>
                      {isFree(session) ? (
                        <span className="is-free">Free</span>
                      ) : cost === null ? (
                        '—'
                      ) : (
                        formatMoney(cost)
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      ) : (
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
          {selected >= 0 && (
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
            const dimmed = selected >= 0 && !isActive
            const free = isFree(session)
            // Label the extreme and the selection only — never every bar.
            const labelled = isActive || (selected < 0 && index === peakIndex)

            return (
              <g key={session.startedAt?.getTime() ?? index}>
                <path
                  d={barPath(x, y, barWidth, height)}
                  className={`chart-bar ${dimmed ? 'is-dimmed' : ''}`}
                />
                {/*
                  A mark, not a recolour — the bar itself keeps meaning
                  magnitude and nothing else. It floats above the bar rather
                  than sitting inside its top corner, because at the widest
                  window a bar is two units across and has no corner to sit
                  in; the value label steps up out of its way when both land
                  on the same bar.
                */}
                {free && (
                  <circle
                    cx={x + barWidth / 2}
                    cy={y - 4.5}
                    r="2.5"
                    className="chart-free-dot"
                  />
                )}
                {labelled && (
                  <text
                    x={x + barWidth / 2}
                    y={y - (free ? 11 : 5)}
                    className="chart-value"
                    textAnchor="middle"
                  >
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
                  onClick={() => select(session)}
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
            /*
             * Thin the date labels so they never collide, however wide the
             * window is. Two rules, because there are two ways they can touch:
             * the axis carries at most MAX_DATE_LABELS of them and never two
             * closer together than one label is wide; and the selected bar is
             * always labelled — picking a bar must not leave it the only
             * unnamed thing on the chart — so a scheduled label standing where
             * the selected one wants to be gives way to it rather than being
             * overprinted by it.
             */
            const spacing = Math.max(
              Math.ceil(DATE_LABEL_W / band),
              Math.ceil(recent.length / MAX_DATE_LABELS),
            )
            if (index !== selected) {
              if (index % spacing !== 0) return null
              if (selected >= 0 && Math.abs(index - selected) < Math.ceil(DATE_LABEL_W / band)) {
                return null
              }
            }
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
      )}

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
            {/*
              And where it happened, which is the question the figures above
              cannot answer: 40 kWh at home and 40 kWh at a motorway services
              are the same session on this chart and nothing alike in life.

              The slot is the same size whether or not there is a position for
              it, so moving from one session to the next never reflows the page
              — the same fixed floor .history-detail already stands on. A
              session with nothing recorded says so rather than being left
              looking like a map that failed to load.
            */}
            <div className="history-map">
              {activePlace ? (
                <>
                  <MapTiles
                    lat={activePlace.lat}
                    lon={activePlace.lon}
                    className="is-compact"
                  />
                  <p className="history-map-note">
                    <span>
                      {activePlace.lat.toFixed(4)}, {activePlace.lon.toFixed(4)}
                    </span>
                    <a
                      className="button is-small"
                      href={mapsUrl(activePlace)}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open in Maps
                    </a>
                  </p>
                </>
              ) : (
                <p className="history-map-empty">
                  <PinIcon />
                  <span>No location recorded for this charge</span>
                </p>
              )}
            </div>
          </>
        ) : (
          <span className="chart-hint">
            {asTable
              ? 'Choose a date for the detail of that session'
              : 'Tap a bar for the detail of that session'}
          </span>
        )}
      </div>
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
