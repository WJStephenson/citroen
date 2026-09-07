import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { TripPositions } from '../api/types'
import { PinIcon } from './Icons'

const TILE = 256
const MIN_ZOOM = 3
const MAX_ZOOM = 16
const PADDING = 28

function lonToWorldX(lon: number, zoom: number): number {
  return ((lon + 180) / 360) * TILE * 2 ** zoom
}

function latToWorldY(lat: number, zoom: number): number {
  const rad = (lat * Math.PI) / 180
  return ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * TILE * 2 ** zoom
}

interface Tile {
  key: string
  src: string
  left: number
  top: number
}

interface Bounds {
  minLat: number
  maxLat: number
  minLon: number
  maxLon: number
}

function computeBounds(positions: TripPositions): Bounds | null {
  const lats = positions.lat
  const lons = positions.long
  if (lats.length === 0 || lons.length === 0) return null

  let minLat = lats[0] as number
  let maxLat = lats[0] as number
  let minLon = lons[0] as number
  let maxLon = lons[0] as number

  for (let i = 1; i < lats.length; i++) {
    const lat = lats[i] as number
    const lon = lons[i] as number
    if (lat < minLat) minLat = lat
    if (lat > maxLat) maxLat = lat
    if (lon < minLon) minLon = lon
    if (lon > maxLon) maxLon = lon
  }

  // If all points are identical, create a slight box
  if (minLat === maxLat && minLon === maxLon) {
    minLat -= 0.003
    maxLat += 0.003
    minLon -= 0.003
    maxLon += 0.003
  }

  return { minLat, maxLat, minLon, maxLon }
}

function findBestZoom(bounds: Bounds, w: number, h: number): number {
  const availW = Math.max(w - PADDING * 2, 60)
  const availH = Math.max(h - PADDING * 2, 60)

  for (let z = MAX_ZOOM; z >= MIN_ZOOM; z--) {
    const xSpan = Math.abs(lonToWorldX(bounds.maxLon, z) - lonToWorldX(bounds.minLon, z))
    const ySpan = Math.abs(latToWorldY(bounds.minLat, z) - latToWorldY(bounds.maxLat, z))
    if (xSpan <= availW && ySpan <= availH) {
      return z
    }
  }
  return MIN_ZOOM
}

export function TripMap({
  positions,
  className = '',
}: {
  positions: TripPositions | null
  className?: string
}) {
  const frameRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })

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

  const bounds = useMemo(
    () => (positions ? computeBounds(positions) : null),
    [positions],
  )

  const mapData = useMemo(() => {
    if (!bounds || !positions || size.w <= 0 || size.h <= 0) return null

    const zoom = findBestZoom(bounds, size.w, size.h)
    const centreLat = (bounds.minLat + bounds.maxLat) / 2
    const centreLon = (bounds.minLon + bounds.maxLon) / 2

    const originX = lonToWorldX(centreLon, zoom) - size.w / 2
    const originY = latToWorldY(centreLat, zoom) - size.h / 2

    // Tiles
    const worldTiles = 2 ** zoom
    const minTx = Math.floor(originX / TILE)
    const maxTx = Math.floor((originX + size.w) / TILE)
    const minTy = Math.floor(originY / TILE)
    const maxTy = Math.floor((originY + size.h) / TILE)

    const tiles: Tile[] = []
    for (let ty = minTy; ty <= maxTy; ty++) {
      if (ty < 0 || ty >= worldTiles) continue
      for (let tx = minTx; tx <= maxTx; tx++) {
        const wrappedTx = ((tx % worldTiles) + worldTiles) % worldTiles
        tiles.push({
          key: `${tx},${ty}`,
          src: `https://tile.openstreetmap.org/${zoom}/${wrappedTx}/${ty}.png`,
          left: tx * TILE - originX,
          top: ty * TILE - originY,
        })
      }
    }

    // SVG Points
    const lats = positions.lat
    const lons = positions.long
    const pts: { x: number; y: number }[] = []
    for (let i = 0; i < lats.length; i++) {
      const lat = lats[i] as number
      const lon = lons[i] as number
      pts.push({
        x: lonToWorldX(lon, zoom) - originX,
        y: latToWorldY(lat, zoom) - originY,
      })
    }

    const pathD =
      pts.length > 0
        ? pts.reduce((acc, pt, idx) => `${acc} ${idx === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`, '')
        : ''

    const start = pts[0]
    const finish = pts[pts.length - 1]

    return {
      tiles,
      pts,
      pathD,
      start,
      finish,
      startCoord: { lat: lats[0], lon: lons[0] },
      finishCoord: { lat: lats[lats.length - 1], lon: lons[lons.length - 1] },
    }
  }, [bounds, positions, size.w, size.h])

  if (!positions || positions.lat.length === 0) {
    return (
      <div className={`trip-map-frame is-empty ${className}`}>
        <PinIcon />
        <p>No GPS coordinates recorded for this trip</p>
      </div>
    )
  }

  const externalMapUrl =
    mapData && mapData.startCoord && mapData.finishCoord
      ? `https://www.google.com/maps/dir/?api=1&origin=${mapData.startCoord.lat},${mapData.startCoord.lon}&destination=${mapData.finishCoord.lat},${mapData.finishCoord.lon}`
      : undefined

  return (
    <div className={`trip-map-container ${className}`}>
      <div className="trip-map-frame" ref={frameRef}>
        {mapData?.tiles.map((tile) => (
          <img
            key={tile.key}
            src={tile.src}
            alt=""
            draggable={false}
            className="map-tile"
            style={{ left: tile.left, top: tile.top, width: TILE, height: TILE }}
          />
        ))}

        {mapData && (
          <svg
            className="trip-map-svg"
            viewBox={`0 0 ${size.w} ${size.h}`}
            aria-hidden="true"
          >
            {/* Outline path for high contrast on both light and dark tiles */}
            <path
              d={mapData.pathD}
              fill="none"
              stroke="rgba(0, 0, 0, 0.45)"
              strokeWidth="5.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* Main accent track line */}
            <path
              d={mapData.pathD}
              fill="none"
              stroke="var(--accent)"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {/* Start marker (green dot) */}
            {mapData.start && (
              <circle
                cx={mapData.start.x}
                cy={mapData.start.y}
                r="5"
                fill="#10b981"
                stroke="#ffffff"
                strokeWidth="2"
              />
            )}
            {/* Finish marker (red/coral dot) */}
            {mapData.finish && (
              <circle
                cx={mapData.finish.x}
                cy={mapData.finish.y}
                r="5.5"
                fill="#ef4444"
                stroke="#ffffff"
                strokeWidth="2"
              />
            )}
          </svg>
        )}
      </div>

      <div className="trip-map-footer">
        <div className="trip-map-legend">
          <span className="legend-item">
            <span className="legend-dot is-start" /> Start
          </span>
          <span className="legend-item">
            <span className="legend-dot is-finish" /> Finish
          </span>
        </div>
        {externalMapUrl && (
          <a
            className="button is-small"
            href={externalMapUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open in Maps
          </a>
        )}
      </div>
    </div>
  )
}
