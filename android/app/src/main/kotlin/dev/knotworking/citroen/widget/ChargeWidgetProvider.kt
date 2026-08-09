package dev.knotworking.citroen.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.widget.RemoteViews
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import dev.knotworking.citroen.R
import java.util.concurrent.TimeUnit

/**
 * The home screen widget: the charge tile, at a glance, without opening
 * anything.
 *
 * It draws from a stored reading and never from the network — the fetch is
 * ChargeWorker's job, and it calls back here when it lands. A widget update can
 * be triggered by the launcher at any moment (a reboot, a resize, a theme
 * change) and none of those are reasons to make an HTTP request, let alone on
 * the main thread, which is all a BroadcastReceiver gets.
 */
class ChargeWidgetProvider : AppWidgetProvider() {

  override fun onUpdate(
    context: Context,
    appWidgetManager: AppWidgetManager,
    appWidgetIds: IntArray,
  ) {
    render(context, appWidgetManager, appWidgetIds)
    schedulePeriodic(context)
    requestRefresh(context)
  }

  override fun onEnabled(context: Context) {
    schedulePeriodic(context)
    requestRefresh(context)
  }

  override fun onDisabled(context: Context) {
    // The last widget is gone, so nothing is left to keep fetching for.
    WorkManager.getInstance(context).cancelUniqueWork(PERIODIC_WORK)
  }

  override fun onReceive(context: Context, intent: Intent) {
    super.onReceive(context, intent)
    if (intent.action == ACTION_REFRESH) requestRefresh(context)
  }

  companion object {
    const val ACTION_REFRESH = "dev.knotworking.citroen.REFRESH"
    private const val PERIODIC_WORK = "charge-refresh-periodic"
    private const val ONE_OFF_WORK = "charge-refresh-now"

    /** Fifteen minutes is WorkManager's floor, and no read reaches the car. */
    private const val REFRESH_MINUTES = 15L

    private val networkRequired = Constraints.Builder()
      .setRequiredNetworkType(NetworkType.CONNECTED)
      .build()

    fun schedulePeriodic(context: Context) {
      WorkManager.getInstance(context).enqueueUniquePeriodicWork(
        PERIODIC_WORK,
        // KEEP: a launcher redraw must not reset the schedule, or a widget on
        // a busy home screen would refresh far more often than it should.
        ExistingPeriodicWorkPolicy.KEEP,
        PeriodicWorkRequestBuilder<ChargeWorker>(REFRESH_MINUTES, TimeUnit.MINUTES)
          .setConstraints(networkRequired)
          .build(),
      )
    }

    fun requestRefresh(context: Context) {
      WorkManager.getInstance(context).enqueueUniqueWork(
        ONE_OFF_WORK,
        ExistingWorkPolicy.REPLACE,
        OneTimeWorkRequestBuilder<ChargeWorker>()
          .setConstraints(networkRequired)
          .build(),
      )
    }

    /** Every widget this app owns, redrawn from whatever is currently stored. */
    fun renderAll(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(ComponentName(context, ChargeWidgetProvider::class.java))
      if (ids.isNotEmpty()) render(context, manager, ids)
    }

    private fun render(context: Context, manager: AppWidgetManager, ids: IntArray) {
      val reading = ChargeReading.load(context)
      val views = RemoteViews(context.packageName, R.layout.widget_charge)

      val colour = context.getColor(levelColour(reading.level))
      views.setImageViewBitmap(
        R.id.ring,
        Ring.draw(
          fraction = reading.level?.let { it / 100f } ?: -1f,
          colour = colour,
          trackColour = context.getColor(R.color.track),
        ),
      )

      views.setTextViewText(
        R.id.level,
        reading.level?.let { "$it%" } ?: context.getString(R.string.no_reading),
      )
      views.setTextColor(
        R.id.level,
        context.getColor(if (reading.hasReading) R.color.text else R.color.muted),
      )
      views.setTextViewText(R.id.note, note(context, reading))

      // The tile opens the app; the mark in the corner asks for a fresh read.
      // Two targets rather than one, because "tap to refresh" and "tap to open"
      // cannot both be the whole tile and a widget that guesses gets it wrong
      // half the time.
      views.setOnClickPendingIntent(R.id.widget_root, openApp(context))
      views.setOnClickPendingIntent(R.id.refresh, refreshNow(context))

      manager.updateAppWidget(ids, views)
    }

    /** The same three bands as StatWidgets.tsx::levelColour. */
    private fun levelColour(level: Int?): Int = when {
      level == null -> R.color.muted
      level <= 10 -> R.color.danger
      level <= 25 -> R.color.warn
      else -> R.color.accent
    }

    /**
     * One line, and it has to carry whichever of four things matters most:
     * that the widget is not set up, that the last refresh failed, that the
     * car is charging, or how far it can go. In that order — a number nobody
     * can trust needs its caveat more than it needs its units.
     */
    private fun note(context: Context, reading: ChargeReading): String {
      reading.failure?.let { failure ->
        val reason = context.getString(
          when (failure) {
            ChargeReading.Failure.NOT_CONFIGURED -> R.string.not_configured
            ChargeReading.Failure.OFFLINE -> R.string.offline
            ChargeReading.Failure.DENIED -> R.string.denied
            ChargeReading.Failure.BRIDGE -> R.string.bridge_error
          },
        )
        // A stale number is worth keeping on screen, but only next to its age.
        return if (reading.hasReading) "$reason · ${age(reading.asOf)}" else reason
      }

      if (!reading.hasReading) return context.getString(R.string.never_fetched)
      if (reading.charging) return context.getString(R.string.charging)
      if (reading.isStale()) return context.getString(R.string.as_of, age(reading.asOf))
      return range(context, reading.rangeKm) ?: context.getString(R.string.no_range)
    }

    private fun range(context: Context, km: Int?): String? {
      if (km == null) return null
      return if (context.resources.getBoolean(R.bool.use_miles)) {
        context.getString(R.string.range_miles, Math.round(km / KM_PER_MILE).toInt())
      } else {
        context.getString(R.string.range_km, km)
      }
    }

    private const val KM_PER_MILE = 1.609344f

    private fun age(since: Long): String {
      val minutes = (System.currentTimeMillis() - since) / 60_000
      return when {
        minutes < 1 -> "just now"
        minutes < 60 -> "${minutes}m ago"
        minutes < 60 * 48 -> "${minutes / 60}h ago"
        else -> "${minutes / (60 * 24)}d ago"
      }
    }

    private fun openApp(context: Context): PendingIntent {
      // The app's own launcher, not a browser intent at the URL: this works
      // whether or not asset links have verified yet, and never risks handing
      // the car to a browser tab.
      val intent = context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?: Intent(Intent.ACTION_VIEW, Uri.parse(context.getString(R.string.start_url)))
      // A PendingIntent starts outside any activity, so it needs its own task.
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      return PendingIntent.getActivity(
        context,
        0,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }

    private fun refreshNow(context: Context): PendingIntent {
      val intent = Intent(context, ChargeWidgetProvider::class.java).setAction(ACTION_REFRESH)
      return PendingIntent.getBroadcast(
        context,
        1,
        intent,
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
      )
    }
  }
}
