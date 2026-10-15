package expo.modules.beam

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.exception.CodedException
import java.io.File
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import javax.net.SocketFactory

/**
 * The transfer, owned by the process rather than by the screen.
 *
 * ## Why this moved out of the module
 *
 * The server, the client and the Wi-Fi they run over used to be fields on
 * [BeamModule], which lives and dies with the JavaScript runtime. That was fine
 * while a transfer only had to last as long as a screen — and it is not fine
 * now that it has to outlast the app being left: the module can be torn down
 * and rebuilt underneath a transfer that is still running.
 *
 * So the work lives here, for as long as the process does, and [BeamService]
 * keeps the process alive while there is any. The module is a window onto it:
 * it starts things, and it listens. A module that comes back after the screen
 * was rebuilt asks [hostStatus] or [receiveStatus] and finds the transfer
 * exactly where it left it.
 *
 * ## The notification is the transfer's other screen
 *
 * Built here because only here is the state that goes in it. Throttled, because
 * the server reports every half-megabyte for every student at once and a
 * notification redrawn thirty times a second is one Android starts dropping.
 */
object BeamSession {
  private const val TAG = "Beam"

  const val NOTIFICATION_ID = 4201
  private const val RESULT_ID = 4202
  private const val CHANNEL_PROGRESS = "beam-transfer"
  private const val CHANNEL_RESULT = "beam-result"

  /** How long to try a Wi-Fi Direct join before offering the system's dialog. */
  private const val P2P_TIMEOUT_MS = 20_000L

  /** Includes the student tapping "Connect" in the system dialog. */
  private const val DIALOG_TIMEOUT_MS = 45_000

  /** Android 9 and below: join the old way, by saving the network. */
  private const val LEGACY_TIMEOUT_MS = 30_000L

  /** Bringing a group up is seconds on a good phone and slow on a bad one. */
  private const val GROUP_TIMEOUT_MS = 30_000L

  private const val NOTIFY_EVERY_MS = 500L

  /**
   * Where events go. Set by whichever [BeamModule] is alive, cleared when it
   * goes; events with nobody listening are simply not sent.
   */
  @Volatile var emit: ((String, Map<String, Any?>) -> Unit)? = null

  /** Whether the app is on screen — decides if a finished transfer notifies. */
  @Volatile var appVisible = true

  private val main = Handler(Looper.getMainLooper())

  /** Socket reads that block for thirty seconds must not hold anybody else up. */
  private val work = Executors.newSingleThreadExecutor()

  private val lock = Any()

  /* ------------------------------------------------------------- State */

  private class Sharing(val title: String, val text: NotifyText) {
    val startedAt = System.currentTimeMillis()
    val busy = AtomicInteger(0)
    @Volatile var received = 0
  }

  private class Receiving(
    val title: String,
    val sizes: List<Long>,
    val text: NotifyText,
    val openUrl: String?,
  ) {
    @Volatile var stage = "joining"
    @Volatile var file = 0
    @Volatile var fileBytes = 0L
    @Volatile var socket: Socket? = null
    @Volatile var cancelled = false
    /** This receive's network, so a late failure cannot release the next one's. */
    @Volatile var joiner: Joiner? = null
    /**
     * Ends this receive as cancelled. Needed because a join that is released
     * stops calling back — a cancel during "connecting to the teacher" would
     * otherwise leave the receive waiting on an answer that never comes.
     */
    @Volatile var abort: (() -> Unit)? = null

    val total: Long get() = sizes.sum()

    /** Everything finished plus this file's share, of everything promised. */
    fun overall(): Long = sizes.take(file).sum() + fileBytes
  }

  private var host: WifiDirectHost? = null
  private var server: BeamServer? = null
  @Volatile private var sharing: Sharing? = null

  @Volatile private var receiving: Receiving? = null

  /**
   * Bumped by every start and every stop of sharing.
   *
   * Bringing a group up takes seconds, and the teacher can leave — or try
   * again — in the middle of it. A start that finishes after that must not
   * put a server up for a screen that is gone.
   */
  private var shareGeneration = 0

  private var serviceUp = false
  private var updatePending = false

  /** True while there is anything for the service to keep alive. */
  val busy: Boolean get() = sharing != null || receiving != null

  /* ----------------------------------------------------------- Sending */

  /**
   * Bring up the route and the server, then answer with how to reach them.
   *
   * The ladder — hotspot, a Wi-Fi Direct group of our own, the joined Wi-Fi —
   * is the one `BeamModule.route` describes; it moved here unchanged.
   */
  fun startSharing(
    context: Context,
    manifest: String,
    files: List<Outgoing>,
    token: String,
    title: String,
    text: NotifyText,
    done: (Result<Map<String, Any>>) -> Unit,
  ) {
    stopSharing(context, byUser = false)
    val generation = synchronized(lock) { ++shareGeneration }

    /*
      The service first, before the seconds a group takes to come up.

      Android only lets an app start a foreground service while it is on
      screen. Starting it once the group was ready meant a teacher who pressed
      Home during those seconds got a share that the next freeze would stop.
    */
    val state = Sharing(title, text)
    synchronized(lock) { sharing = state }
    startService(context)

    val failed: (Throwable) -> Unit = { failure ->
      synchronized(lock) { if (sharing === state) sharing = null }
      refreshService(context)
      done(Result.failure(failure))
    }

    val net = LocalNet(context)

    val hotspot = net.hotspot()
    if (hotspot != null) {
      serve(context, state, manifest, files, token, null, null, hotspot.address, "hotspot", done)
      return
    }

    val directHost = WifiDirectHost(context)
    val blocked = directHost.blocker()
    if (blocked != null) {
      val lan = net.lan()
      if (lan != null) {
        serve(context, state, manifest, files, token, null, null, lan.address, "lan", done)
        return
      }
      failed(
        when (blocked) {
          "wifiOff" -> BeamWifiOffException()
          "locationOff" -> BeamLocationOffException()
          else -> BeamUnavailableException()
        },
      )
      return
    }

    synchronized(lock) { host = directHost }
    directHost.start(GROUP_TIMEOUT_MS) { result ->
      if (synchronized(lock) { generation != shareGeneration }) {
        directHost.stop()
        // Not `failed`: whoever bumped the generation owns the state now.
        done(Result.failure(BeamCancelledException()))
        return@start
      }
      result.fold(
        onSuccess = { group ->
          serve(
            context, state, manifest, files, token,
            group.ssid, group.passphrase, group.host, "direct", done,
          )
        },
        onFailure = { failure ->
          // The state of the phone can change in thirty seconds: a teacher who
          // switched their hotspot on while watching the spinner should get a
          // transfer rather than the error they were trying to fix.
          val fallback = net.existing()
          directHost.stop()
          synchronized(lock) { if (host === directHost) host = null }
          if (fallback == null) {
            failed(failure)
            return@fold
          }
          val route = if (fallback.route == Route.HOTSPOT) "hotspot" else "lan"
          serve(context, state, manifest, files, token, null, null, fallback.address, route, done)
        },
      )
    }
  }

  private fun serve(
    context: Context,
    state: Sharing,
    manifest: String,
    files: List<Outgoing>,
    token: String,
    ssid: String?,
    passphrase: String?,
    address: String,
    route: String,
    done: (Result<Map<String, Any>>) -> Unit,
  ) {
    try {
      val beam = BeamServer(
        resolver = context.contentResolver,
        manifest = manifest,
        files = files,
        token = token,
      ) { event -> onPeer(context, state, event) }
      val port = beam.start()
      synchronized(lock) {
        server = beam
        sharing = state
      }
      scheduleUpdate(context)
      done(
        Result.success(
          mapOf(
            "ssid" to (ssid ?: ""),
            "passphrase" to (passphrase ?: ""),
            "host" to address,
            "port" to port,
            "route" to route,
          ),
        ),
      )
    } catch (e: Exception) {
      stopSharing(context, byUser = false)
      done(Result.failure(e))
    }
  }

  /**
   * Count students in and out, then pass the event on.
   *
   * Counted here as well as on the screen, because the notification has to say
   * it when there is no screen. `begun` on a failure says whether the student
   * had got as far as being counted in — a phone that fails the handshake was
   * never "receiving" and must not take the count below zero.
   */
  private fun onPeer(context: Context, state: Sharing, event: Map<String, Any?>) {
    when (event["kind"]) {
      "started" -> state.busy.incrementAndGet()
      "done" -> {
        state.busy.updateAndGet { maxOf(0, it - 1) }
        state.received = (event["total"] as? Int) ?: state.received
      }
      "failed" -> if (event["begun"] == true) state.busy.updateAndGet { maxOf(0, it - 1) }
    }
    emit?.invoke("onBeamPeer", event)
    scheduleUpdate(context)
  }

  /**
   * Take the server and the group down.
   *
   * `byUser` is the Stop button on the notification: the screen did not ask
   * for this, so it is told — otherwise it would go on showing a code that
   * nothing answers.
   */
  fun stopSharing(context: Context, byUser: Boolean) {
    val (stoppedServer, stoppedHost, state) = synchronized(lock) {
      shareGeneration += 1
      val s = Triple(server, host, sharing)
      server = null
      host = null
      sharing = null
      s
    }
    stoppedServer?.stop()
    stoppedHost?.stop()
    if (byUser && state != null) {
      emit?.invoke("onBeamHostStopped", mapOf("received" to state.received))
    }
    refreshService(context)
  }

  fun hostStatus(): Map<String, Any?>? = sharing?.let {
    mapOf("title" to it.title, "received" to it.received, "busy" to it.busy.get())
  }

  /* --------------------------------------------------------- Receiving */

  /**
   * Get onto the teacher's network, pull everything, and answer once.
   *
   * ## The ladder, for a code that names a network
   *
   *  1. **Wi-Fi Direct, joined with the code's name and password** (Android
   *     10+). No dialog, nothing to type, and the student's own Wi-Fi stays
   *     connected beside it. This is what "scan and it just arrives" needs.
   *  2. **The system's own join dialog**, if that fails — one tap on
   *     "Connect". Some builds will not join a group as a Wi-Fi Direct client
   *     at all, and they all honour this.
   *  3. **On Android 9 and below**, the network is saved and joined the old
   *     way, which those versions still allow. Nobody types a password.
   *
   * Only when every one of those fails does the student see the network
   * written out to join by hand.
   */
  fun receive(
    context: Context,
    options: ReceiveOptions,
    device: String,
    done: (Result<Delivery>) -> Unit,
  ) {
    cancelReceive()

    val text = options.notify ?: NotifyText()
    val state = Receiving(
      title = options.title,
      sizes = options.sizes.map { it.toLong() },
      text = text,
      openUrl = options.openUrl,
    )
    synchronized(lock) { receiving = state }
    startService(context)

    var finished = false
    fun finish(result: Result<Delivery>) {
      if (finished) return
      finished = true
      state.abort = null
      releaseJoin(state)
      synchronized(lock) { if (receiving === state) receiving = null }
      refreshService(context)
      if (!appVisible) postResult(context, state, result)
      done(result)
    }

    state.abort = { main.post { finish(Result.failure(BeamCancelledException())) } }

    fun pull(factory: SocketFactory?, viaDirect: Boolean) {
      setStage(context, state, "connecting")
      work.execute {
        try {
          val delivery = BeamClient.fetch(
            factory = factory,
            host = options.host,
            port = options.port,
            token = options.token,
            device = device,
            into = File(options.directory),
            onSocket = { socket ->
              state.socket = socket
              if (state.cancelled) runCatching { socket.close() }
            },
          ) { index, received, size ->
            if (state.stage != "downloading") setStage(context, state, "downloading")
            state.file = index
            state.fileBytes = received
            emit?.invoke(
              "onBeamProgress",
              mapOf("file" to index, "received" to received, "size" to size),
            )
            scheduleUpdate(context)
          }
          writeMarker(File(options.directory), delivery)
          main.post { finish(Result.success(delivery)) }
        } catch (e: Exception) {
          if (state.cancelled) {
            main.post { finish(Result.failure(BeamCancelledException())) }
            return@execute
          }
          /*
            Joined over Wi-Fi Direct, and then nothing answered.

            Rare, and seen on builds that route a Wi-Fi Direct client's traffic
            somewhere odd. The system dialog's network is an ordinary Wi-Fi
            network the socket can be pinned to, so try once more that way
            before giving up on a student who did everything right.
          */
          if (viaDirect && e is UnreachableException && !options.ssid.isNullOrEmpty()) {
            main.post {
              Log.i(TAG, "joined over Wi-Fi Direct but unreachable; trying the system dialog")
              releaseJoin(state)
              main.postDelayed({ joinByDialog(context, state, options, ::finish) { pull(it, false) } }, 600)
            }
            return@execute
          }
          main.post { finish(Result.failure(e)) }
        }
      }
    }

    val ssid = options.ssid
    if (ssid.isNullOrEmpty()) {
      /*
        Already on the right network — but say which one. A plain socket goes
        over whatever Android calls the default network, and a phone with mobile
        data keeps that as the default whenever the Wi-Fi it is on has no
        internet, which is exactly what a teacher's hotspot looks like.
      */
      pull(LocalNet(context).wifiNetwork()?.socketFactory, viaDirect = false)
      return
    }
    val passphrase = options.passphrase.orEmpty()

    // Already on the teacher's network — joined by hand. Nothing to join.
    LocalNet(context).wifiNetworkOn(options.host)?.let { network ->
      pull(network.socketFactory, viaDirect = false)
      return
    }

    main.post {
      if (state.cancelled) return@post finish(Result.failure(BeamCancelledException()))

      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
        val legacy = LegacyJoin(context)
        state.joiner = legacy
        setStage(context, state, "joining")
        legacy.join(ssid, passphrase, options.host, LEGACY_TIMEOUT_MS) { result ->
          if (state.cancelled) return@join finish(Result.failure(BeamCancelledException()))
          result.fold(
            onSuccess = { network -> pull(network?.socketFactory, viaDirect = false) },
            onFailure = { finish(Result.failure(BeamManualJoinException())) },
          )
        }
        return@post
      }

      val direct = P2pJoin(context)
      state.joiner = direct
      setStage(context, state, "joining")
      direct.join(ssid, passphrase, P2P_TIMEOUT_MS) { result ->
        if (state.cancelled) return@join finish(Result.failure(BeamCancelledException()))
        if (result.isSuccess) {
          pull(null, viaDirect = true)
          return@join
        }
        Log.i(TAG, "Wi-Fi Direct join failed (${result.exceptionOrNull()?.message}); asking the system")
        releaseJoin(state)
        // A moment for the framework to finish leaving whatever half-joined
        // group that attempt left behind; asking for a network while it is
        // still tearing down is a request that never completes.
        main.postDelayed({ joinByDialog(context, state, options, ::finish) { pull(it, false) } }, 600)
      }
    }
  }

  /** Rung two: the system's "Connect to device" dialog, one tap. */
  private fun joinByDialog(
    context: Context,
    state: Receiving,
    options: ReceiveOptions,
    finish: (Result<Delivery>) -> Unit,
    then: (SocketFactory?) -> Unit,
  ) {
    if (state.cancelled) return finish(Result.failure(BeamCancelledException()))
    val dialog = WifiJoin(context)
    state.joiner = dialog
    setStage(context, state, "approve")
    dialog.join(options.ssid.orEmpty(), options.passphrase.orEmpty(), DIALOG_TIMEOUT_MS) { result ->
      if (state.cancelled) return@join finish(Result.failure(BeamCancelledException()))
      result.fold(
        onSuccess = { network -> then(network.socketFactory) },
        onFailure = { finish(Result.failure(it)) },
      )
    }
  }

  /** Stop a receive in flight: leave the network and break the socket. */
  fun cancelReceive() {
    val state = receiving ?: return
    state.cancelled = true
    runCatching { state.socket?.close() }
    main.post { releaseJoin(state) }
    state.abort?.invoke()
  }

  fun receiveStatus(): Map<String, Any?>? = receiving?.let {
    mapOf(
      "title" to it.title,
      "stage" to it.stage,
      "file" to it.file,
      "files" to it.sizes.size,
      "received" to it.overall(),
      "total" to it.total,
    )
  }

  private fun setStage(context: Context, state: Receiving, stage: String) {
    state.stage = stage
    emit?.invoke("onBeamStage", mapOf("stage" to stage))
    scheduleUpdate(context)
  }

  private fun releaseJoin(state: Receiving) {
    val j = synchronized(lock) {
      val current = state.joiner
      state.joiner = null
      current
    }
    j?.release()
  }

  /**
   * A note beside the files saying what they are.
   *
   * The app writes its own record of a handout once the files are in — but
   * that is JavaScript, and a transfer can now finish while the app's
   * JavaScript is not running. The marker lets the next launch file what
   * arrived instead of leaving it in a folder nothing points at.
   */
  private fun writeMarker(dir: File, delivery: Delivery) {
    runCatching {
      val files = org.json.JSONArray()
      for (f in delivery.files) {
        files.put(org.json.JSONObject().put("path", f.path).put("name", f.name).put("size", f.size))
      }
      val json = org.json.JSONObject().put("manifest", delivery.manifest).put("files", files)
      File(dir, MARKER).writeText(json.toString())
    }.onFailure { Log.w(TAG, "could not write delivery marker: ${it.message}") }
  }

  const val MARKER = ".beam-delivery.json"

  /* ------------------------------------------------------ Notification */

  private fun startService(context: Context) {
    val app = context.applicationContext
    ensureChannels(app, (sharing?.text ?: receiving?.text) ?: NotifyText())
    synchronized(lock) {
      if (serviceUp) {
        scheduleUpdate(app)
        return
      }
      serviceUp = true
    }
    try {
      val intent = Intent(app, BeamService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) app.startForegroundService(intent)
      else app.startService(intent)
    } catch (e: Exception) {
      // Started from the background on a recent Android, which is refused. The
      // transfer still runs while the app is open.
      Log.w(TAG, "could not start the transfer service: ${e.message}")
      synchronized(lock) { serviceUp = false }
    }
  }

  /** Redraw while there is work; take the service down when there is none. */
  private fun refreshService(context: Context) {
    val app = context.applicationContext
    if (busy) {
      scheduleUpdate(app)
      return
    }
    val wasUp = synchronized(lock) {
      val up = serviceUp
      serviceUp = false
      up
    }
    if (wasUp) runCatching { app.stopService(Intent(app, BeamService::class.java)) }
    manager(app)?.cancel(NOTIFICATION_ID)
  }

  private fun scheduleUpdate(context: Context) {
    val app = context.applicationContext
    synchronized(lock) {
      if (updatePending) return
      updatePending = true
    }
    main.postDelayed({
      synchronized(lock) { updatePending = false }
      if (!serviceUp) return@postDelayed
      val notification = foregroundNotification(app) ?: return@postDelayed
      runCatching { manager(app)?.notify(NOTIFICATION_ID, notification) }
    }, NOTIFY_EVERY_MS)
  }

  /**
   * Something to go foreground with when there is nothing left to show.
   *
   * A service started with `startForegroundService` must call `startForeground`
   * however it was asked — including by the notification's own Stop, which
   * arrives just as the work it would have shown has ended.
   */
  fun placeholderNotification(context: Context): Notification {
    ensureChannels(context, NotifyText())
    return builder(context, CHANNEL_PROGRESS).setContentTitle("…").setOngoing(false).build()
  }

  /** What the ongoing notification says right now, or null with nothing running. */
  fun foregroundNotification(context: Context): Notification? {
    sharing?.let { return sharingNotification(context, it) }
    receiving?.let { return receivingNotification(context, it) }
    return null
  }

  private fun sharingNotification(context: Context, s: Sharing): Notification {
    val busyNow = s.busy.get()
    val parts = buildList {
      if (s.received > 0) add(fill(s.text.received, "count" to s.received))
      if (busyNow > 0) add(fill(s.text.receiving, "busy" to busyNow))
    }.filter { it.isNotBlank() }
    val line = if (parts.isEmpty()) s.text.waiting else parts.joinToString(" · ")

    return builder(context, CHANNEL_PROGRESS)
      .setContentTitle(fill(s.text.title, "title" to s.title))
      .setContentText(line)
      .setWhen(s.startedAt)
      .setUsesChronometer(true)
      .setShowWhen(true)
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setContentIntent(openApp(context, null))
      .addAction(stopAction(context, s.text.stop))
      .apply { if (busyNow > 0) setProgress(0, 0, true) }
      .build()
  }

  private fun receivingNotification(context: Context, r: Receiving): Notification {
    val b = builder(context, CHANNEL_PROGRESS)
      .setContentTitle(fill(r.text.title, "title" to r.title))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_PROGRESS)
      .setContentIntent(openApp(context, null))
      .addAction(stopAction(context, r.text.stop))

    val total = r.total
    if (r.stage == "downloading" && total > 0) {
      val percent = ((r.overall() * 100) / total).toInt().coerceIn(0, 100)
      b.setContentText(
        fill(
          r.text.progress,
          "file" to (r.file + 1),
          "files" to r.sizes.size,
          "percent" to percent,
        ),
      )
      b.setProgress(100, percent, false)
    } else {
      b.setContentText(r.text.waiting)
      b.setProgress(0, 0, true)
    }
    return b.build()
  }

  /**
   * Said when a transfer finishes with nobody looking.
   *
   * Not when the app is open: the screen already says it, and a notification
   * on top of the same news is noise.
   */
  private fun postResult(context: Context, r: Receiving, result: Result<Delivery>) {
    val failure = result.exceptionOrNull()
    if (failure is BeamCancelledException || r.cancelled) return
    val app = context.applicationContext
    val n = builder(app, CHANNEL_RESULT)
      .setAutoCancel(true)
      .apply {
        if (failure == null) {
          setContentTitle(fill(r.text.done, "title" to r.title))
          setContentText(r.text.doneText)
          setContentIntent(openApp(app, r.openUrl))
        } else {
          setContentTitle(fill(r.text.failed, "title" to r.title))
          setContentText(r.text.failedText)
          setContentIntent(openApp(app, null))
        }
      }
      .build()
    runCatching { manager(app)?.notify(RESULT_ID, n) }
  }

  @Suppress("DEPRECATION")
  private fun builder(context: Context, channel: String): Notification.Builder {
    val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(context, channel)
    } else {
      Notification.Builder(context).setPriority(
        if (channel == CHANNEL_RESULT) Notification.PRIORITY_DEFAULT else Notification.PRIORITY_LOW,
      )
    }
    b.setSmallIcon(R.drawable.beam_notify)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      // Shown at once rather than after Android's ten-second grace: a transfer
      // that ends in five would otherwise never be seen in the shade at all.
      b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
    }
    return b
  }

  private fun ensureChannels(context: Context, text: NotifyText) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = manager(context) ?: return
    // Low: a progress bar should not ring. Results are default — the student
    // put the phone away and is waiting to hear.
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_PROGRESS, text.channel, NotificationManager.IMPORTANCE_LOW).apply {
        setShowBadge(false)
      },
    )
    nm.createNotificationChannel(
      NotificationChannel(CHANNEL_RESULT, text.channelResult, NotificationManager.IMPORTANCE_DEFAULT),
    )
  }

  private fun openApp(context: Context, url: String?): PendingIntent {
    val intent = if (url.isNullOrBlank()) {
      context.packageManager.getLaunchIntentForPackage(context.packageName)
        ?: Intent().setPackage(context.packageName)
    } else {
      Intent(Intent.ACTION_VIEW, Uri.parse(url)).setPackage(context.packageName)
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    return PendingIntent.getActivity(
      context,
      if (url.isNullOrBlank()) 0 else 2,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
  }

  private fun stopAction(context: Context, label: String): Notification.Action {
    val intent = Intent(context, BeamService::class.java).setAction(BeamService.ACTION_STOP)
    val flags = PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
    val pending = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      PendingIntent.getForegroundService(context, 1, intent, flags)
    } else {
      PendingIntent.getService(context, 1, intent, flags)
    }
    @Suppress("DEPRECATION")
    return Notification.Action.Builder(null as android.graphics.drawable.Icon?, label, pending).build()
  }

  /** The notification's Stop: whichever of the two is running. */
  fun stopFromNotification(context: Context) {
    if (sharing != null) stopSharing(context, byUser = true)
    if (receiving != null) cancelReceive()
  }

  private fun manager(context: Context) =
    context.getSystemService(Context.NOTIFICATION_SERVICE) as? NotificationManager

  private fun fill(template: String, vararg vars: Pair<String, Any>): String {
    var out = template
    for ((key, value) in vars) out = out.replace("{$key}", value.toString())
    return out
  }
}

/** Text for the notification, in the app's language — native has no translations. */
class NotifyText : expo.modules.kotlin.records.Record {
  @expo.modules.kotlin.records.Field var channel: String = "File transfer"
  @expo.modules.kotlin.records.Field var channelResult: String = "Finished transfers"
  /** `{title}` is the handout's title. */
  @expo.modules.kotlin.records.Field var title: String = "{title}"
  /** Before anything is moving: waiting for students, or joining the teacher. */
  @expo.modules.kotlin.records.Field var waiting: String = ""
  /** Sender: `{count}` phones have it. */
  @expo.modules.kotlin.records.Field var received: String = "{count}"
  /** Sender: `{busy}` phones are taking it now. */
  @expo.modules.kotlin.records.Field var receiving: String = "{busy}"
  /** Receiver: `{file}` of `{files}`, `{percent}` overall. */
  @expo.modules.kotlin.records.Field var progress: String = "{percent}%"
  /** The action that stops sharing or cancels receiving. */
  @expo.modules.kotlin.records.Field var stop: String = "Stop"
  @expo.modules.kotlin.records.Field var done: String = "{title}"
  @expo.modules.kotlin.records.Field var doneText: String = ""
  @expo.modules.kotlin.records.Field var failed: String = "{title}"
  @expo.modules.kotlin.records.Field var failedText: String = ""
}

/** Stopped from the notification, or by the screen. */
class BeamCancelledException :
  CodedException("ERR_BEAM_CANCELLED", "The transfer was cancelled.", null)
