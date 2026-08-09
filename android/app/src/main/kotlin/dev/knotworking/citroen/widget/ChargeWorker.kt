package dev.knotworking.citroen.widget

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The one place a network call happens. A widget provider is a
 * BroadcastReceiver — main thread, seconds to live — so it can only ask for
 * this and redraw when it lands.
 *
 * Never retries. The next run is fifteen minutes away and the car reports on
 * its own schedule regardless, so a backoff would only spend battery racing a
 * number that has not changed. A failure is not dropped either: it is
 * stored alongside the last good reading and drawn on the tile, which is more
 * use than a silent retry nobody can see.
 */
class ChargeWorker(
  context: Context,
  params: WorkerParameters,
) : CoroutineWorker(context, params) {

  override suspend fun doWork(): Result {
    withContext(Dispatchers.IO) { ChargeRepository.refresh(applicationContext) }
    ChargeWidgetProvider.renderAll(applicationContext)
    return Result.success()
  }
}
