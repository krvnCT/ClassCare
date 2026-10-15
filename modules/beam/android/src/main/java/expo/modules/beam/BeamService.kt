package expo.modules.beam

import android.app.Notification
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log

/**
 * Keeps a transfer alive while the app is not on screen.
 *
 * ## Why a service at all
 *
 * The transfer itself never needed the screen: the server and the client are
 * plain threads. What needed the screen was the *process*. An Android app that
 * goes to the background with nothing in the foreground is cached, and since
 * Android 11 a cached process is frozen within seconds — its threads stop
 * mid-write. A teacher who pressed Home to check the time froze every student's
 * download; a student who answered a message lost the worksheet at 80 %.
 *
 * A foreground service is the one thing Android accepts as "this app is doing
 * something the user asked for": the process keeps running, keeps its network
 * through Doze, and the user can see why from the notification — which is also
 * where they can stop it.
 *
 * ## What it owns, and what it does not
 *
 * Nothing about the transfer. [BeamSession] holds the server, the client and
 * the network; this only holds the process up, the CPU awake and the Wi-Fi
 * radio out of power-save while there is work, and draws the notification
 * [BeamSession] describes. Stopping it never stops a transfer — the session
 * stops the service when it has nothing left to do.
 *
 * `connectedDevice` is the type: a transfer to a phone in the same room over a
 * Wi-Fi link we brought up, which is what that type is for. Its prerequisite is
 * `CHANGE_WIFI_STATE`, which this module already declares.
 */
class BeamService : Service() {
  private var wake: PowerManager.WakeLock? = null
  private var wifiLock: WifiManager.WifiLock? = null

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onCreate() {
    super.onCreate()
    holdLocks()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // Always answered with startForeground first, whatever was asked: a service
    // started with `startForegroundService` that does not call it within a few
    // seconds crashes the app — the notification's Stop included.
    goForeground(
      BeamSession.foregroundNotification(applicationContext)
        ?: BeamSession.placeholderNotification(applicationContext),
    )

    if (intent?.action == ACTION_STOP) BeamSession.stopFromNotification(applicationContext)

    // Nothing left to keep alive — the stop above may have ended the last of it.
    if (!BeamSession.busy) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
        stopForeground(STOP_FOREGROUND_REMOVE)
      } else {
        @Suppress("DEPRECATION")
        stopForeground(true)
      }
      stopSelf()
    }

    // Not sticky. A restarted service would come back with no server, no client
    // and no network — an empty notification over nothing.
    return START_NOT_STICKY
  }

  /**
   * Swiped away from recents. The transfer carries on: the notification is how
   * it is stopped, and a teacher who tidied their recent apps mid-lesson did not
   * mean to end the handout.
   */
  override fun onTaskRemoved(rootIntent: Intent?) {
    Log.i(TAG, "task removed; transfer continues")
  }

  override fun onDestroy() {
    releaseLocks()
    super.onDestroy()
  }

  private fun goForeground(notification: Notification) {
    try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        startForeground(
          BeamSession.NOTIFICATION_ID,
          notification,
          ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
        )
      } else {
        startForeground(BeamSession.NOTIFICATION_ID, notification)
      }
    } catch (e: Exception) {
      // Refused — started from the background on a recent Android, or a
      // missing prerequisite on a strange build. The transfer still runs while
      // the app is open; it simply will not survive being left.
      Log.w(TAG, "could not go foreground: ${e.message}")
    }
  }

  /**
   * The CPU, and the Wi-Fi radio at full power.
   *
   * With the screen off the CPU sleeps between interrupts and the Wi-Fi chip
   * drops into power-save, which on some phones is a tenth of the throughput.
   * A worksheet that takes two seconds becomes one that takes a minute, or
   * stalls long enough for the other phone's timeout. Both are released the
   * moment the service goes — this is held only while there is a transfer.
   */
  @Suppress("DEPRECATION")
  private fun holdLocks() {
    runCatching {
      val power = getSystemService(Context.POWER_SERVICE) as PowerManager
      wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "beam:transfer").apply {
        setReferenceCounted(false)
        // A ceiling, so a bug that never stops the service cannot drain the
        // battery overnight. An hour is far longer than any lesson's handout.
        acquire(60 * 60 * 1000L)
      }
    }
    runCatching {
      val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
      // High-perf until Android 14, where it stopped doing anything; low-latency
      // after, which at least holds while the screen is on.
      val mode =
        if (Build.VERSION.SDK_INT >= 34) WifiManager.WIFI_MODE_FULL_LOW_LATENCY
        else WifiManager.WIFI_MODE_FULL_HIGH_PERF
      wifiLock = wifi.createWifiLock(mode, "beam:transfer").apply {
        setReferenceCounted(false)
        acquire()
      }
    }
  }

  private fun releaseLocks() {
    runCatching { if (wake?.isHeld == true) wake?.release() }
    runCatching { if (wifiLock?.isHeld == true) wifiLock?.release() }
    wake = null
    wifiLock = null
  }

  companion object {
    private const val TAG = "Beam"
    const val ACTION_STOP = "expo.modules.beam.STOP"
  }
}
