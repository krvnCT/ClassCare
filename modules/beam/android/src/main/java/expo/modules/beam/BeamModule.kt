package expo.modules.beam

import android.Manifest
import android.content.Context
import android.os.Build
import android.provider.OpenableColumns
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.File

/**
 * Hand files from one phone to another with no internet, no router and no
 * account — the way ShareIt does it.
 *
 * ## The shape of it
 *
 * The teacher's phone serves the assignment over a plain socket ([BeamServer])
 * and shows a QR describing how to reach it. The student's phone reads that,
 * gets onto the right network if it is not already ([WifiJoin]), and pulls the
 * files ([BeamClient]).
 *
 * Which network is the interesting part, and it is decided per share — see
 * `Function("route")`. A hotspot the teacher already has running is used as it
 * stands; otherwise the phone becomes an access point of its own
 * ([WifiDirectHost]); failing that, the Wi-Fi they are both joined to
 * ([LocalNet]). The first version had only the middle one, and the commonest
 * reason it failed was the teacher's hotspot holding the interface it needed —
 * which is to say it refused to work in the one situation where the class was
 * already connected to the teacher's phone.
 *
 * The work itself belongs to [BeamSession], not to this module: a transfer has
 * to outlive the screen that started it, and [BeamService] keeps it going while
 * the app is in the background. This module starts things and listens.
 *
 * No URL. No server anywhere. Nothing leaves the room. On a filtered connection
 * in Turkmenistan that is not a nice-to-have, it is the difference between a
 * feature that works in a classroom and one that does not.
 *
 * ## Both halves live here
 *
 * ClassCare only sends and StudentCare only receives, but the module ships both
 * because the protocol is the contract between them and a protocol maintained
 * in two places is a protocol that drifts. Copy `modules/beam` into StudentCare
 * whole; do not reimplement the receiving side from the docs.
 *
 * ## What it deliberately does not do
 *
 * No resume, no encryption above WPA2, no discovery. The transfer is seconds
 * long over a link this fast, so a student who walks out of range simply taps
 * "try again". WPA2 with a password only the room can see off the teacher's screen is
 * the same protection the room's own Wi-Fi would give, and the token stops a
 * stale code from a previous lesson pulling this one's files.
 */
class BeamModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw MissingContextException()

  /** What this instance put into [BeamSession.emit], so it only clears its own. */
  private var emitter: ((String, Map<String, Any?>) -> Unit)? = null

  override fun definition() = ModuleDefinition {
    Name("Beam")

    // `peer` is the teacher watching students arrive; `progress` is the student
    // watching a file land; `stage` is the student's phone finding the teacher's;
    // `hostStopped` is the teacher pressing Stop on the notification.
    Events("onBeamPeer", "onBeamProgress", "onBeamStage", "onBeamHostStopped")

    OnCreate {
      val send: (String, Map<String, Any?>) -> Unit = { name, body -> sendEvent(name, body) }
      emitter = send
      BeamSession.emit = send
    }

    /*
      Not a stop. A transfer outlives the JavaScript that started it — that is
      the point of [BeamSession] — so a module being torn down only stops
      listening. The notification is how a transfer nobody is watching ends.
    */
    OnDestroy {
      if (BeamSession.emit === emitter) BeamSession.emit = null
      emitter = null
    }

    OnActivityEntersForeground { BeamSession.appVisible = true }
    OnActivityEntersBackground { BeamSession.appVisible = false }

    Function("isAvailable") {
      context.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_WIFI_DIRECT)
    }

    /**
     * How the next share would reach the class: "hotspot", "direct", "lan", or
     * null when no route is open.
     *
     * The ladder, in order, and the order is the whole design:
     *
     *  1. **The phone's own hotspot**, if it is running. The class is already
     *     connected to it, it needs no permission, no Location Services and no
     *     group to come up — and it is precisely the case the app used to
     *     refuse outright, because a running hotspot holds the interface
     *     Wi-Fi Direct wants.
     *  2. **A Wi-Fi Direct group** of our own. The default: it needs no router
     *     and has nobody's client-isolation rules on it.
     *  3. **The Wi-Fi the phone is joined to**, last, because school and café
     *     access points very often block phone-to-phone traffic and do it
     *     silently.
     */
    Function("route") { routeNow() }

    /**
     * What would stop a share right now: "unsupported", "wifiOff",
     * "locationOff", or null.
     *
     * Null whenever *any* route is open — so this is now only ever the answer
     * when there is no network to be had at all. Asked before starting rather
     * than discovered by waiting: each of these used to spend twenty seconds
     * becoming a timeout, and a timeout is the one error message that tells a
     * teacher nothing about what to do next.
     */
    Function("blocker") {
      if (routeNow() != null) null else WifiDirectHost(context).blocker() ?: "unsupported"
    }

    /**
     * Whether this phone joins the teacher's network by itself.
     *
     * Always now: Android 10 and up join as a Wi-Fi Direct client or through
     * the system dialog, and older versions save and join the network the way
     * they still allow. Kept so an app built against the old answer still asks.
     */
    Function("canJoinAutomatically") { true }

    /** The sharing in progress, if any — for a screen rebuilt mid-transfer. */
    Function("hostStatus") { BeamSession.hostStatus() }

    /** The receive in progress, if any — for a screen rebuilt mid-transfer. */
    Function("receiveStatus") { BeamSession.receiveStatus() }

    /**
     * Whether Wi-Fi is switched on.
     *
     * The receiving side's whole precondition. A student whose Wi-Fi is off
     * joins nothing, and the `NetworkRequest` used to express that by sitting
     * there for forty-five seconds and then failing with "could not join" —
     * which reads as the teacher's fault and is one tap from being fixed.
     *
     * No permission needed, and deliberately not part of `blocker`: that one
     * answers a question about *sending*, where a running hotspot is a route
     * rather than a problem. Here it is only ever about joining.
     */
    Function("wifiEnabled") {
      val wifi = context.getSystemService(Context.WIFI_SERVICE) as? android.net.wifi.WifiManager
      wifi?.isWifiEnabled == true
    }

    /**
     * The name a file is actually called, as its provider reports it.
     *
     * Android document URIs carry no name. The one on
     * `content://com.android.providers.media.documents/document/msf%3A1000000033`
     * is `msf:1000000033`, and that is what the picker hands back and what a
     * class of students then saw at the top of their worksheet. The real name
     * lives in the provider's `DISPLAY_NAME` column and has to be asked for.
     *
     * Returns null when the provider will not say, so the caller can keep
     * whatever it already had rather than replacing a poor name with none.
     *
     * Here rather than in a module of its own because this is the only place in
     * the app holding a `ContentResolver`, and `BeamServer` already asks the
     * same provider for the same file's size.
     */
    Function("displayName") { uri: String ->
      runCatching {
        if (!uri.startsWith("content:")) return@runCatching null
        context.contentResolver
          .query(android.net.Uri.parse(uri), arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
          ?.use { cursor ->
            val column = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            if (column >= 0 && cursor.moveToFirst() && !cursor.isNull(column)) {
              cursor.getString(column)?.takeIf { it.isNotBlank() }
            } else {
              null
            }
          }
      }.getOrNull()
    }

    /**
     * Copy a received file somewhere the student can find it without this app.
     *
     * Files land in app storage, which is right — they survive, nothing else on
     * the phone can overwrite them, and they go when the app goes. But a
     * student told to "send me the worksheet" has to be able to reach it from a
     * file manager or a chat app, and app storage is invisible to both.
     *
     * So each file is also copied into `Downloads/<folder>/`. MediaStore on
     * API 29+, which needs no permission at all; the public Downloads directory
     * below that, where `WRITE_EXTERNAL_STORAGE` still applies and is declared
     * with `maxSdkVersion="32"` for exactly this.
     *
     * Returns where it went, for the screen to show. Failure is not fatal and
     * is reported as null: the file is still in the app, and a handout the
     * student can open but not export is far better than a transfer reported
     * as failed.
     */
    AsyncFunction("exportAsync") { path: String, name: String, mime: String, folder: String ->
      Downloads.save(context, File(path), name, mime, folder)
    }

    AsyncFunction("getPermissionsAsync") { promise: Promise ->
      Permissions.getPermissionsWithPermissionsManager(appContext.permissions, promise, *needed())
    }

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, *needed())
    }

    /**
     * Permission to show the transfer's notification, on Android 13 and up.
     *
     * The transfer runs without it — the service does not depend on it — but
     * nobody would see it running, or be able to stop it, once they left the
     * app. Asked when a transfer starts and never required.
     */
    AsyncFunction("requestNotificationsAsync") { promise: Promise ->
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        Permissions.askForPermissionsWithPermissionsManager(
          appContext.permissions,
          promise,
          Manifest.permission.POST_NOTIFICATIONS,
        )
      } else {
        promise.resolve(mapOf("granted" to true, "canAskAgain" to true, "status" to "granted"))
      }
    }

    /* ------------------------------------------------------------- Sending */

    AsyncFunction("startHostAsync") {
      manifest: String, files: List<FileArg>, token: String, notify: NotifyText?, promise: Promise ->
      val title = runCatching { org.json.JSONObject(manifest).optString("t") }.getOrDefault("")
      BeamSession.startSharing(
        context = context,
        manifest = manifest,
        files = files.map { Outgoing(it.uri, it.name, it.mime) },
        token = token,
        title = title,
        text = notify ?: NotifyText(),
      ) { result ->
        result.fold(
          onSuccess = { promise.resolve(it) },
          onFailure = { promise.reject(it.asCoded()) },
        )
      }
    }

    AsyncFunction("stopHostAsync") { BeamSession.stopSharing(context, byUser = false) }

    /* ----------------------------------------------------------- Receiving */

    AsyncFunction("receiveAsync") { options: ReceiveOptions, promise: Promise ->
      // The directory as a path: `expo-file-system` hands back `file://` URIs,
      // which `java.io.File` would take as a relative path — see `localDir`.
      options.directory = localDir(options.directory).path
      BeamSession.receive(context, options, deviceId()) { result ->
        result.fold(
          onSuccess = { delivery ->
            promise.resolve(
              mapOf(
                "manifest" to delivery.manifest,
                "files" to delivery.files.map {
                  mapOf("path" to it.path, "name" to it.name, "size" to it.size)
                },
              ),
            )
          },
          onFailure = { promise.reject(it.asCoded()) },
        )
      }
    }

    AsyncFunction("cancelReceiveAsync") { BeamSession.cancelReceive() }
  }

  /** See `Function("route")` — the ladder, asked without starting anything. */
  private fun routeNow(): String? {
    val net = LocalNet(context)
    if (net.hotspot() != null) return "hotspot"
    if (WifiDirectHost(context).blocker() == null) return "direct"
    if (net.lan() != null) return "lan"
    return null
  }

  /**
   * The directory to write into, given what JavaScript calls a path.
   *
   * `expo-file-system` hands back `file:///data/user/0/…` from `Directory.uri`,
   * and `java.io.File` takes that string as a *relative* path named
   * `file:/data/user/0/…`. It then resolves under the process working
   * directory, which is `/` and is not writable, and every file in the
   * transfer failed with ENOENT — after the sending phone had already reported
   * the whole handout as delivered.
   *
   * Both forms are accepted rather than one demanded, because the caller
   * reasonably thinks of `uri` as the way to name a file in that library.
   */
  private fun localDir(raw: String): File {
    if (!raw.startsWith("file:")) return File(raw)
    val path = runCatching { android.net.Uri.parse(raw).path }.getOrNull()
    return File(path ?: raw.removePrefix("file://"))
  }

  /**
   * This installation, as a name the teacher's tally can count.
   *
   * A random UUID made on first use and kept, deliberately *not* `ANDROID_ID`
   * or anything derived from the hardware. Those identify a person across every
   * app on the phone, which is far more than a count of who has the worksheet
   * needs — and this one means nothing outside the few minutes a teacher is
   * holding a QR code up. It never leaves the room, and the sending phone keeps
   * it no longer than the session.
   */
  private fun deviceId(): String {
    val prefs = context.getSharedPreferences("beam", Context.MODE_PRIVATE)
    prefs.getString(DEVICE_KEY, null)?.let { return it }
    val fresh = java.util.UUID.randomUUID().toString()
    prefs.edit().putString(DEVICE_KEY, fresh).apply()
    return fresh
  }

  /**
   * Wi-Fi Direct used to be gated behind location, because a scan reveals where
   * you are. From Android 13 that job belongs to NEARBY_WIFI_DEVICES, which is
   * narrower and does not read as the app asking to track the teacher.
   */
  private fun needed(): Array<String> =
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      arrayOf(Manifest.permission.NEARBY_WIFI_DEVICES)
    } else {
      arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
    }

  /**
   * Turn what the transfer threw into something the screen can name.
   *
   * The socket code throws plain `IOException`s on purpose — it knows about
   * bytes, not about translated strings — so the mapping to a code the app can
   * branch on lives here. Without it every one of these reached JavaScript as
   * `ERR_BEAM` plus an English sentence, which is not something a Turkmen
   * student's phone can show them.
   */
  private fun Throwable.asCoded(): CodedException = when (this) {
    is CodedException -> this
    is BadTokenException -> BeamBadTokenException()
    is CorruptFileException -> BeamCorruptException(message ?: "")
    is CutOffException -> BeamCutOffException(where)
    is VersionMismatchException -> BeamVersionException()
    is UnreachableException -> BeamUnreachableException()
    else -> BeamFailedException(message ?: javaClass.simpleName)
  }

  companion object {
    private const val DEVICE_KEY = "device"
  }
}

/** A file the teacher is sending. `uri` is `file://` or `content://`. */
class FileArg : Record {
  @Field var uri: String = ""
  @Field var name: String = "file"
  @Field var mime: String = "application/octet-stream"
}

/** Everything the student's phone read off the QR, plus where to put the files. */
class ReceiveOptions : Record {
  /** Null when already on the right network — see `receiveAsync`. */
  @Field var ssid: String? = null
  @Field var passphrase: String? = null
  @Field var host: String = WifiDirectHost.GROUP_OWNER
  @Field var port: Int = 0
  @Field var token: String = ""
  @Field var directory: String = ""
  /** The handout's title, for the notification. */
  @Field var title: String = ""
  /** Each file's size from the code, so the notification can show one bar for all of them. */
  @Field var sizes: List<Double> = emptyList()
  @Field var notify: NotifyText? = null
  /** Opened by tapping "received" when the app was not on screen. */
  @Field var openUrl: String? = null
}

class MissingContextException :
  CodedException("ERR_BEAM_NO_CONTEXT", "The app context is not available.", null)

class BeamUnavailableException :
  CodedException("ERR_BEAM_UNSUPPORTED", "This phone does not support Wi-Fi Direct.", null)

/**
 * The group would not start.
 *
 * `trace` is the sequence of steps that led there, appended to the message
 * because this is the failure that only ever happens on somebody else's phone
 * — and asking a teacher in a classroom to attach a cable and run logcat is
 * not a bug report anyone is going to get.
 */
class BeamGroupException(reason: String, trace: String = "") :
  CodedException("ERR_BEAM_GROUP", if (trace.isEmpty()) reason else "$reason\n$trace", null)

class BeamWifiOffException : CodedException(
  "ERR_BEAM_WIFI_OFF",
  "Wi-Fi is switched off.",
  null,
)

/**
 * Location Services is off at the system level.
 *
 * Not the permission — that is asked for separately and may well be granted.
 * Android will not bring up a Wi-Fi Direct group while the setting is off, and
 * it does so by quietly never producing one rather than by failing.
 */
class BeamLocationOffException : CodedException(
  "ERR_BEAM_LOCATION_OFF",
  "Location Services is switched off.",
  null,
)

class BeamJoinException(reason: String) : CodedException("ERR_BEAM_JOIN", reason, null)

/** The code was for a different transfer — usually a photo of yesterday's. */
class BeamBadTokenException : CodedException(
  "ERR_BEAM_TOKEN",
  "This code is not for this transfer.",
  null,
)

/**
 * A file arrived with a checksum that does not match.
 *
 * Its own code because the remedy is its own: stand closer and scan again.
 * Reported rather than saved — see `BeamClient`, which throws the partial file
 * away before this is raised.
 */
class BeamCorruptException(name: String) : CodedException(
  "ERR_BEAM_CORRUPT",
  if (name.isEmpty()) "A file did not arrive intact." else name,
  null,
)

/**
 * The sending phone stopped partway through.
 *
 * Carries the file it stopped at, because that is the one fact that separates
 * "stand closer" from "the teacher cannot read that file" — and the student is
 * standing next to the teacher and can simply say which it was.
 */
class BeamCutOffException(where: String) : CodedException(
  "ERR_BEAM_CUT_OFF",
  where,
  null,
)

/** The two apps were built from different versions of the protocol. */
class BeamVersionException : CodedException(
  "ERR_BEAM_VERSION",
  "The two apps are different versions.",
  null,
)

class BeamManualJoinException : CodedException(
  "ERR_BEAM_JOIN_MANUAL",
  "This phone is too old to join a network on its own.",
  null,
)

/**
 * Joined, or already on the network, and nothing answered at the teacher's
 * address — their sharing screen closed, or this phone is not on their network.
 */
class BeamUnreachableException : CodedException(
  "ERR_BEAM_UNREACHABLE",
  "The teacher's phone did not answer.",
  null,
)

class BeamFailedException(reason: String) : CodedException("ERR_BEAM", reason, null)
