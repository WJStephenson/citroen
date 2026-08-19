import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PinIcon } from './Icons'

/**
 * A still picture of one point on the map, drawn from OpenStreetMap's raster
 * tiles.
 *
 * This used to be an embedded openstreetmap.org iframe (Leaflet's own embed),
 * but that ships its own zoom rocker, a popup, and an attribution bar with
 * outbound links — all built for a page you pan and zoom, not a tile you
 * glance at. Fetching the raw XYZ tiles and laying them out by hand gets the
 * same imagery as a plain, static picture: our own pin, no chrome, nothing
 * clickable.
 *
 * No on-image credit line by request — this is a private, single-user
 * dashboard, never served to anyone else. That is a deliberate call for *this*
 * app, not a pattern to copy somewhere the map is public.
 *
 * Two tiles use it: where the car is now (LocationWidget), and where a past
 * charge began (ChargingHistoryWidget). Nothing about the drawing differs
 * between them except the frame's height, which is `className`'s only job.
 */

const TILE = 256
const ZOOM = 16

function lonToWorldX(lon: number): number {
  return ((lon + 180) / 360) * TILE * 2 ** ZOOM
}

function latToWorldY(lat: number): number {
  const rad = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * TILE * 2 ** ZOOM
}

interface Tile {
  key: string
  src: string
  left: number
  top: number
}

/** Every tile needed to cover a w×h box centred on (lat, lon), positioned in box-local px. */
function tilesFor(lat: number, lon: number, w: number, h: number): Tile[] {
  if (w <= 0 || h <= 0) return []
  const worldTiles = 2 ** ZOOM
  const centreX = lonToWorldX(lon)
  const centreY = latToWorldY(lat)
  const originX = centreX - w / 2
  const originY = centreY - h / 2

  const minTx = Math.floor(originX / TILE)
  const maxTx = Math.floor((originX + w) / TILE)
  const minTy = Math.floor(originY / TILE)
  const maxTy = Math.floor((originY + h) / TILE)

  const tiles: Tile[] = []
  for (let ty = minTy; ty <= maxTy; ty += 1) {
    if (ty < 0 || ty >= worldTiles) continue // no imagery past the poles
    for (let tx = minTx; tx <= maxTx; tx += 1) {
      // Wrap the antimeridian rather than requesting a tile column that isn't there.
      const wrappedTx = ((tx % worldTiles) + worldTiles) % worldTiles
      tiles.push({
        key: `${tx},${ty}`,
        src: `https://tile.openstreetmap.org/${ZOOM}/${wrappedTx}/${ty}.png`,
        left: tx * TILE - originX,
        top: ty * TILE - originY,
      })
    }
  }
  return tiles
}

/** The point, on whichever map service the phone opens for it. */
export function mapsUrl({ lat, lon }: { lat: number; lon: number }): string {
  return `https://www.google.com/maps?q=${lat},${lon}`
}

export function MapTiles({
  lat,
  lon,
  className = '',
}: {
  lat: number
  lon: number
  className?: string
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

  // The tile grid is laid out in real pixels, so it has to know the frame's
  // actual rendered size — which depends on the grid column width, not
  // anything this component controls.
  useLayoutEffect(() => {
    const el = frameRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const { width, height } = entry.contentRect
      setSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const tiles = useMemo(() => tilesFor(lat, lon, size.w, size.h), [lat, lon, size.w, size.h])

  return (
    <div className={`map-frame ${className}`} ref={frameRef}>
      {tiles.map((tile) => (
        <img
          key={tile.key}
          src={tile.src}
          alt=""
          draggable={false}
          className="map-tile"
          style={{ left: tile.left, top: tile.top, width: TILE, height: TILE }}
        />
      ))}
      {size.w > 0 && (
        <span className="map-pin" aria-hidden="true">
          <PinIcon />
        </span>
      )}
    </div>
  )
}
