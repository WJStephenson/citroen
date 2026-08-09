package dev.knotworking.citroen.widget

import android.content.Context
import dev.knotworking.citroen.BuildConfig
import dev.knotworking.citroen.R
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI

/**
 * The widget's own line to the car, which is not the app's.
 *
 * Wrapping the PWA in this APK buys one icon and one install; it does not let
 * native code borrow the web app's session. The page runs in Chrome, its
 * Cloudflare Access cookie is Chrome's, and nothing here can read it. So the
 * widget authenticates as a machine, with an Access **service token** — the
 * case the deployment notes describe as suiting `curl` and CI rather than a
 * browser. Two headers, no redirect dance, no login page.
 *
 * That token should be scoped to this one read path in Cloudflare, not to the
 * whole hostname: it sits in an APK on a phone, and the bridge behind it has no
 * authentication of its own. A token that can reach /preconditioning or
 * /lock_door is a car key on the lock screen. See deploy/DEPLOYMENT.md.
 *
 * The read is uncached, and used not to be. `?from_cache=1` was here as a
 * safety story — never wake the car — but no read wakes the car: without the
 * flag the bridge asks Stellantis for the status record they hold, and only
 * `/wakeup` reaches the vehicle (see src/api/client.ts::fetchVehicleState).
 * What the flag actually bought was psa_car_controller's in-memory copy, which
 * nothing refreshes unless the bridge runs with -R. A home-screen widget
 * re-reading that every fifteen minutes is fifteen-minute-fresh proof that
 * nothing has changed, which is how the most glanceable surface in the house
 * came to be the least current.
 */
internal object ChargeRepository {

  private const val TIMEOUT_MS = 20_000

  fun isConfigured(): Boolean =
    BuildConfig.VIN.isNotEmpty() &&
      BuildConfig.CF_ACCESS_CLIENT_ID.isNotEmpty() &&
      BuildConfig.CF_ACCESS_CLIENT_SECRET.isNotEmpty()

  /**
   * A failed refresh keeps the *previous* reading and attaches a reason rather
   * than blanking the tile: yesterday's number under "No connection" is useful,
   * an empty circle is not. `fetchedAt` moves only on success, so the staleness
   * the widget reports stays the age of the data rather than the age of the
   * last attempt.
   */
  fun refresh(context: Context): ChargeReading {
    val previous = ChargeReading.load(context)
    val result = fetch(context, previous)
    ChargeReading.save(context, result)
    return result
  }

  private fun fetch(context: Context, previous: ChargeReading): ChargeReading {
    if (!isConfigured()) return previous.copy(failure = ChargeReading.Failure.NOT_CONFIGURED)

    val url = URI(
      "https://${context.getString(R.string.host)}/api/get_vehicleinfo/${BuildConfig.VIN}",
    ).toURL()

    var connection: HttpURLConnection? = null
    try {
      connection = (url.openConnection() as HttpURLConnection).apply {
        requestMethod = "GET"
        connectTimeout = TIMEOUT_MS
        readTimeout = TIMEOUT_MS
        // A redirect here means Access wants a browser, which the service
        // token should have made unnecessary. Following it would just fetch a
        // login page and call it success.
        instanceFollowRedirects = false
        setRequestProperty("Accept", "application/json")
        setRequestProperty("CF-Access-Client-Id", BuildConfig.CF_ACCESS_CLIENT_ID)
        setRequestProperty("CF-Access-Client-Secret", BuildConfig.CF_ACCESS_CLIENT_SECRET)
      }

      val code = connection.responseCode
      if (code == 401 || code == 403 || code in 300..399) {
        return previous.copy(failure = ChargeReading.Failure.DENIED)
      }
      if (code !in 200..299) {
        return previous.copy(failure = ChargeReading.Failure.BRIDGE)
      }

      val body = connection.inputStream.bufferedReader().use { it.readText() }
      // Access answers an unauthenticated request with its login page — HTML,
      // and sometimes with a 200. The web client guards the same trap; without
      // this it would surface as an unreadable parse failure.
      if (!body.trimStart().startsWith("{")) {
        return previous.copy(failure = ChargeReading.Failure.DENIED)
      }
      return ChargeReading.parse(body, System.currentTimeMillis())
    } catch (_: IOException) {
      return previous.copy(failure = ChargeReading.Failure.OFFLINE)
    } catch (_: Exception) {
      // A malformed payload is the bridge's problem, not the network's, and
      // must not be reported as being offline.
      return previous.copy(failure = ChargeReading.Failure.BRIDGE)
    } finally {
      connection?.disconnect()
    }
  }
}
