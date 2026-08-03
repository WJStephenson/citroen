import type { VehicleLocation } from '../api/types'
import { PinIcon } from './Icons'
import { Widget, WidgetNote } from './Widget'

/**
 * Where the car last reported being. psa_car_controller's last_position is a
 * GeoJSON point recorded whenever the car itself last spoke — same staleness
 * caveat as the rest of VehicleState, so this never claims to be live tracking.
 *
 * The embed is plain OpenStreetMap, not a JS mapping library: one iframe, no
 * API key, no tile-loading code to own. It only needs to answer "roughly
 * where", not to be interactive — panning/zooming inside a dashboard tile
 * would fight the page's own scroll.
 */

const SPAN_LON = 0.006
const SPAN_LAT = 0.004

function embedSrc({ lat, lon }: VehicleLocation): string {
  const bbox = [lon - SPAN_LON, lat - SPAN_LAT, lon + SPAN_LON, lat + SPAN_LAT].join(',')
  return `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&marker=${lat},${lon}&layer=mapnik`
}

function mapsUrl({ lat, lon }: VehicleLocation): string {
  return `https://www.google.com/maps?q=${lat},${lon}`
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const headingLabel = (heading: number) => COMPASS[Math.round((heading % 360) / 45) % 8]

export function LocationWidget({ location }: { location: VehicleLocation | null }) {
  if (!location) {
    return (
      <Widget icon={<PinIcon />} label="Location" className="widget-location">
        <WidgetNote>Location not reported</WidgetNote>
      </Widget>
    )
  }

  return (
    <Widget icon={<PinIcon />} label="Location" className="widget-location">
      <div className="map-frame">
        <iframe
          title="Vehicle location"
          src={embedSrc(location)}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </div>
      <div className="widget-aside">
        <WidgetNote>
          {location.lat.toFixed(4)}, {location.lon.toFixed(4)}
          {location.heading !== null && ` · facing ${headingLabel(location.heading)}`}
        </WidgetNote>
        <a
          className="button is-small"
          href={mapsUrl(location)}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open in Maps
        </a>
      </div>
    </Widget>
  )
}
