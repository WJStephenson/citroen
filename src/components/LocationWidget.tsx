import type { VehicleLocation } from '../api/types'
import { PinIcon } from './Icons'
import { MapTiles, mapsUrl } from './MapTiles'
import { Widget, WidgetNote } from './Widget'

/**
 * Where the car last reported being. psa_car_controller's last_position is a
 * GeoJSON point recorded whenever the car itself last spoke — same staleness
 * caveat as the rest of VehicleState, so this never claims to be live tracking.
 *
 * The map itself is MapTiles, which the charging history's detail panel draws
 * with as well — see the note there for why these are raw OSM tiles rather
 * than an embed.
 */

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
      <MapTiles lat={location.lat} lon={location.lon} />
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
