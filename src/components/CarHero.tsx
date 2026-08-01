import carImage from '../assets/ec4.webp'

/**
 * The car itself, above the battery bar.
 *
 * Imported through Vite rather than dropped in public/, so it lands in
 * /assets/ with a content hash — which means the service worker's immutable
 * cache-first rule already covers it and it survives offline launches. A file
 * in public/ would fall through to the network every time.
 *
 * width/height are set so the layout does not shift while it decodes; on a
 * cache-first shell the image can arrive a frame after the text.
 */
export function CarHero() {
  return (
    <div className="car-hero">
      <img
        className="car-hero-img"
        src={carImage}
        width={308}
        height={165}
        alt="Citroën ë-C4"
        decoding="async"
        draggable={false}
      />
    </div>
  )
}
