package dev.knotworking.citroen.widget

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF

/**
 * The charge ring, drawn rather than assembled from progress drawables: it
 * wants a round cap, a track behind it, and a colour that changes with the
 * level, and a Canvas gets all three in a dozen lines.
 *
 * Sweeping from twelve o'clock, clockwise, because that is where the web app's
 * dial starts. Drawn at a fixed size and scaled by the ImageView, so a widget
 * resized on the home screen costs nothing to redraw.
 */
internal object Ring {

  private const val SIZE = 360f
  private const val STROKE = 26f

  fun draw(fraction: Float, colour: Int, trackColour: Int): Bitmap {
    val bitmap = Bitmap.createBitmap(SIZE.toInt(), SIZE.toInt(), Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val inset = STROKE / 2f + 2f
    val box = RectF(inset, inset, SIZE - inset, SIZE - inset)

    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.STROKE
      strokeWidth = STROKE
      strokeCap = Paint.Cap.ROUND
    }

    paint.color = trackColour
    canvas.drawArc(box, 0f, 360f, false, paint)

    val clamped = fraction.coerceIn(0f, 1f)
    if (clamped > 0f) {
      paint.color = colour
      // A round cap on a zero-length arc still paints a dot, which is the
      // right thing to show for a car with 1% in it — but not for one with
      // nothing read at all, which is why the caller passes a negative
      // fraction for "no reading" and gets only the track.
      canvas.drawArc(box, -90f, 360f * clamped, false, paint)
    }
    return bitmap
  }
}
