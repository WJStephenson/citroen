package dev.knotworking.citroen.widget

import android.content.Context
import org.json.JSONObject
import java.time.OffsetDateTime

/**
 * What the widget knows about the car, and how long it has known it.
 *
 * `fetchedAt` is when *we* asked, `reportedAt` is when the car last said
 * anything — the same two clocks the web app keeps apart, and for the same
 * reason: a successful fetch of a stale cache is not a fresh reading, and the
 * widget has to be able to say which it is holding.
 *
 * `failure` is not an alternative to a reading, it sits alongside one: a
 * refresh that fails should leave yesterday's number on the home screen with a
 * word about why it is old, not blank the widget. Losing the last good reading
 * is the one thing a glanceable surface must not do.
 */
internal data class ChargeReading(
  val level: Int?,
  val rangeKm: Int?,
  val charging: Boolean,
  val reportedAt: Long?,
  val fetchedAt: Long,
  val failure: Failure?,
) {
  enum class Failure { NOT_CONFIGURED, OFFLINE, DENIED, BRIDGE }

  val hasReading: Boolean get() = level != null

  /** The web app calls a reading stale at 45 minutes (App.tsx); so does this. */
  fun isStale(now: Long = System.currentTimeMillis()): Boolean =
    now - fetchedAt > STALE_AFTER_MS

  companion object {
    const val STALE_AFTER_MS = 45L * 60_000

    val EMPTY = ChargeReading(null, null, false, null, 0, null)

    private const val PREFS = "charge_widget"

    /**
     * The same shape `normalise()` reads in src/api/client.ts, and the same
     * two quirks: a car with an engine as well as a battery reports several
     * energy entries, and the charging status is one of a small set of
     * spellings that mean "energy is going in".
     */
    fun parse(body: String, fetchedAt: Long): ChargeReading {
      val root = JSONObject(body)
      val energies = root.optJSONArray("energy")
      var energy: JSONObject? = null
      if (energies != null) {
        for (i in 0 until energies.length()) {
          val entry = energies.optJSONObject(i) ?: continue
          if (energy == null) energy = entry
          if (entry.optString("type").equals("Electric", ignoreCase = true)) {
            energy = entry
            break
          }
        }
      }

      val level = energy?.takeIf { it.has("level") }?.optDouble("level")
        ?.takeIf { !it.isNaN() }?.let { Math.round(it).toInt() }
      val range = energy?.takeIf { it.has("autonomy") }?.optDouble("autonomy")
        ?.takeIf { !it.isNaN() }?.let { Math.round(it).toInt() }

      val charging = energy?.optJSONObject("charging")
      val status = charging?.optString("status").orEmpty().lowercase()
      val isCharging = status == "inprogress" || status == "charging" || status == "quickcharge"

      return ChargeReading(
        level = level,
        rangeKm = range,
        charging = isCharging,
        reportedAt = parseInstant(energy?.optString("updated_at")),
        fetchedAt = fetchedAt,
        failure = null,
      )
    }

    /**
     * The bridge sends `2026-08-09T15:27:30.874724Z`, but a different firmware
     * can send an offset instead of a Z — OffsetDateTime takes both, where
     * Instant.parse insists on Z and would throw on the other.
     */
    private fun parseInstant(value: String?): Long? {
      if (value.isNullOrEmpty()) return null
      return runCatching { OffsetDateTime.parse(value).toInstant().toEpochMilli() }.getOrNull()
    }

    fun load(context: Context): ChargeReading {
      val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
      if (!prefs.contains("fetchedAt")) return EMPTY
      return ChargeReading(
        level = prefs.getInt("level", -1).takeIf { it >= 0 },
        rangeKm = prefs.getInt("rangeKm", -1).takeIf { it >= 0 },
        charging = prefs.getBoolean("charging", false),
        reportedAt = prefs.getLong("reportedAt", 0).takeIf { it > 0 },
        fetchedAt = prefs.getLong("fetchedAt", 0),
        failure = prefs.getString("failure", null)?.let {
          runCatching { Failure.valueOf(it) }.getOrNull()
        },
      )
    }

    fun save(context: Context, reading: ChargeReading) {
      context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply {
        putInt("level", reading.level ?: -1)
        putInt("rangeKm", reading.rangeKm ?: -1)
        putBoolean("charging", reading.charging)
        putLong("reportedAt", reading.reportedAt ?: 0)
        putLong("fetchedAt", reading.fetchedAt)
        putString("failure", reading.failure?.name)
        apply()
      }
    }
  }
}
