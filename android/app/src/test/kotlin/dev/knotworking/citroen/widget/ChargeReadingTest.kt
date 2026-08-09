package dev.knotworking.citroen.widget

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The payload reader, which is the only part of the widget with anything to
 * get wrong that a screenshot would not show. It runs off the JVM because
 * parse() touches no Android class — everything that does is in the provider.
 *
 * The shapes here are the ones src/api/client.ts::normalise defends against,
 * because the widget is reading the same bridge and will meet the same ones.
 */
class ChargeReadingTest {

  private val now = 1_770_000_000_000L

  @Test
  fun `reads a live payload`() {
    val reading = ChargeReading.parse(
      """
      {"vin": "VR3UKZKXZMJ000000",
       "energy": [{"type": "Electric", "level": 62.0, "autonomy": 214,
                   "updated_at": "2026-08-09T06:51:47.546303Z",
                   "charging": {"status": "InProgress", "charging_mode": "Slow"}}]}
      """.trimIndent(),
      now,
    )
    assertEquals(62, reading.level)
    assertEquals(214, reading.rangeKm)
    assertTrue(reading.charging)
    assertNotNull(reading.reportedAt)
    assertNull(reading.failure)
  }

  /** A car with a tank as well as a battery lists several energy entries. */
  @Test
  fun `picks the electric entry whatever its position`() {
    val reading = ChargeReading.parse(
      """
      {"energy": [{"type": "Fuel", "level": 80},
                  {"type": "Electric", "level": 41, "autonomy": 150,
                   "charging": {"status": "Stopped"}}]}
      """.trimIndent(),
      now,
    )
    assertEquals(41, reading.level)
    assertFalse(reading.charging)
  }

  /**
   * The bridge sends Z, but a different firmware can send an offset —
   * Instant.parse would throw on the second, which is why this reads it as an
   * OffsetDateTime.
   */
  @Test
  fun `accepts both an offset and a Z`() {
    val z = ChargeReading.parse(
      """{"energy":[{"type":"Electric","level":50,"updated_at":"2026-08-09T15:00:00Z"}]}""",
      now,
    )
    val offset = ChargeReading.parse(
      """{"energy":[{"type":"Electric","level":50,"updated_at":"2026-08-09T15:00:00+01:00"}]}""",
      now,
    )
    assertNotNull(z.reportedAt)
    assertNotNull(offset.reportedAt)
    assertEquals(z.reportedAt, offset.reportedAt?.plus(60 * 60_000))
  }

  /** A deep-asleep car sends almost nothing. That is a reading with holes. */
  @Test
  fun `survives a sparse payload`() {
    val reading = ChargeReading.parse("""{"vin":"X","energy":[{"type":"Electric"}]}""", now)
    assertNull(reading.level)
    assertNull(reading.rangeKm)
    assertFalse(reading.hasReading)
  }

  @Test
  fun `counts a rapid charge as charging`() {
    val reading = ChargeReading.parse(
      """{"energy":[{"type":"Electric","level":50,"charging":{"status":"QuickCharge"}}]}""",
      now,
    )
    assertTrue(reading.charging)
  }

  @Test
  fun `an unreadable date is no date rather than an exception`() {
    val reading = ChargeReading.parse(
      """{"energy":[{"type":"Electric","level":50,"updated_at":"not a date"}]}""",
      now,
    )
    assertEquals(50, reading.level)
    assertNull(reading.reportedAt)
  }

  /** The same two hours App.tsx calls stale. */
  @Test
  fun `goes stale at two hours`() {
    val reading = ChargeReading.parse("""{"energy":[{"type":"Electric","level":50}]}""", now)
    assertFalse(reading.isStale(now + 119 * 60_000))
    assertTrue(reading.isStale(now + 121 * 60_000))
  }

  /**
   * The bug this widget shipped with: a reading fetched a second ago, of a car
   * that last spoke yesterday, reported itself fresh. Staleness is the age of
   * the data, so a successful fetch cannot launder an old number.
   */
  @Test
  fun `a fresh fetch of an old reading is still stale`() {
    val reading = ChargeReading.parse(
      """{"energy":[{"type":"Electric","level":50,"updated_at":"2026-08-09T06:00:00Z"}]}""",
      fetchedAt = 1_770_000_000_000L,
    )
    val threeHoursAfterTheCarSpoke = reading.reportedAt!! + 3 * 60 * 60_000
    assertTrue(reading.isStale(threeHoursAfterTheCarSpoke))
  }

  /** With no timestamp from the car, our own read time is all there is. */
  @Test
  fun `falls back to the fetch time when the car gave no clock`() {
    val reading = ChargeReading.parse("""{"energy":[{"type":"Electric","level":50}]}""", now)
    assertNull(reading.reportedAt)
    assertEquals(now, reading.asOf)
  }
}
