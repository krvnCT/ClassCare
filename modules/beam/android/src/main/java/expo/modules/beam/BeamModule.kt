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
import java.util.concurrent.Executors

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
 * long over a link this fast, so a student who walks out of range simply scans
 * again. WPA2 with a password only the room can see off the teacher's screen is
 * the same protection the room's own Wi-Fi would give, and the token stops a
 * stale code from a previous lesson pulling this one's files.
 */
class BeamModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw MissingContextException()

  /**
   * One thread, because a phone is either sending or receiving and never both,
   * and because a socket read that blocks for thirty seconds must not be
   * holding the queue Expo runs every other module's calls on.
   */
  private val work = Executors.newSingleThreadExecutor()

  private var host: WifiDirectHost? = null
  private var server: BeamServer? = null
  private var join: WifiJoin? = null

  override fun definition() = ModuleDefinition {
    Name("Beam")

    // `peer` is the teacher watching students arrive; `progress` is the student
    // watching a file land. A phone only ever emits one of the two.
    Events("onBeamPeer", "onBeamProgress")

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

    /** False below Android 10: the student has to join the network by hand. */
    Function("canJoinAutomatically") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q }

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

    /* ------------------------------------------------------------- Sending */

    AsyncFunction("startHostAsync") { manifest: String, files: List<FileArg>, token: String, promise: Promise ->
      stopHost()

      val outgoing = files.map { Outgoing(it.uri, it.name, it.mime) }
      val net = LocalNet(context)

      // 1. The hotspot. Nothing to bring up, nothing to ask for, and the class
      //    is already on it.
      val hotspot = net.hotspot()
      if (hotspot != null) {
        serve(manifest, outgoing, token, null, null, hotspot.address, "hotspot", promise)
        return@AsyncFunction
      }

      // 2. A group of our own — unless something stops it, in which case fall
      //    to the joined Wi-Fi before reporting a failure. A room with working
      //    Wi-Fi does not need to hear about Location Services.
      val directHost = WifiDirectHost(context).also { host = it }
      val blocked = directHost.blocker()
      if (blocked != null) {
        val lan = net.lan()
        if (lan != null) {
          host = null
          serve(manifest, outgoing, token, null, null, lan.address, "lan", promise)
          return@AsyncFunction
        }
        when (blocked) {
          "wifiOff" -> throw BeamWifiOffException()
          "locationOff" -> throw BeamLocationOffException()
          else -> throw BeamUnavailableException()
        }
      }

      directHost.start(GROUP_TIMEOUT_MS) { result ->
        result.fold(
          onSuccess = { group ->
            serve(
              manifest, outgoing, token,
              group.ssid, group.passphrase, group.host, "direct", promise,
            )
          },
          onFailure = { failure ->
            /*
              The group did not come up. Before reporting that, look again for
              a network that already exists — the state of the phone can have
              changed in the thirty seconds we spent waiting, and a teacher who
              switched their hotspot on while watching the spinner should get a
              transfer rather than the error they were trying to fix.
            */
            val fallback = net.existing()
            if (fallback == null) {
              stopHost()
              promise.reject(failure.asCoded())
              return@fold
            }
            host?.stop()
            host = null
            val route = if (fallback.route == Route.HOTSPOT) "hotspot" else "lan"
            serve(manifest, outgoing, token, null, null, fallback.address, route, promise)
          },
        )
      }
    }

    AsyncFunction("stopHostAsync") { stopHost() }

    /* ----------------------------------------------------------- Receiving */

    AsyncFunction("receiveAsync") { options: ReceiveOptions, promise: Promise ->
      releaseJoin()
      val joiner = WifiJoin(context).also { join = it }

      // No network name in the payload means the student is already on the
      // right network — either they joined by hand on an old phone, or teacher
      // and student happen to share a working LAN. Skip straight to the socket.
      val ssid = options.ssid
      if (ssid.isNullOrEmpty()) {
        /*
          Already on the right network — but say which one.

          A plain socket goes over whatever Android calls the default network,
          and a phone with mobile data keeps that as the default whenever the
          Wi-Fi it is on has no internet. Both of the routes that land here —
          the teacher's hotspot and a shared classroom network — look exactly
          like that, so the teacher's address went out the cellular interface
          and failed instantly as unreachable.
        */
        pull(LocalNet(context).wifiNetwork()?.socketFactory, options, promise)
        return@AsyncFunction
      }

      joiner.join(ssid, options.passphrase.orEmpty(), JOIN_TIMEOUT_MS) { result ->
        val network = result.getOrElse {
          releaseJoin()
          promise.reject(it.asCoded())
          return@join
        }
        pull(network.socketFactory, options, promise)
      }
    }

    AsyncFunction("cancelReceiveAsync") { releaseJoin() }

    OnDestroy {
      stopHost()
      releaseJoin()
      work.shutdownNow()
    }
  }

  private fun pull(
    factory: javax.net.SocketFactory?,
    options: ReceiveOptions,
    promise: Promise,
  ) {
    work.execute {
      try {
        val delivery = BeamClient.fetch(
          factory = factory,
          host = options.host,
          port = options.port,
          token = options.token,
          device = deviceId(),
          into = localDir(options.directory),
        ) { index, received, size ->
          sendEvent(
            "onBeamProgress",
            mapOf("file" to index, "received" to received, "size" to size),
          )
        }
        promise.resolve(
          mapOf(
            "manifest" to delivery.manifest,
            "files" to delivery.files.map {
              mapOf("path" to it.path, "name" to it.name, "size" to it.size)
            },
          ),
        )
      } catch (e: Exception) {
        promise.reject(e.asCoded())
      } finally {
        // Leave the group either way. Staying on a network with no internet is
        // how a student ends up thinking their phone is broken.
        releaseJoin()
      }
    }
  }

  /**
   * Bind the socket and answer the promise.
   *
   * Shared by all three routes, because from here down they are the same thing:
   * a server on a port, and a QR describing how to reach it. `ssid` and
   * `passphrase` are only present on the Direct route — on the other two the
   * student is already on the network, or joins it the way they always do, and
   * putting a password in the code for a network they are on would be noise.
   */
  private fun serve(
    manifest: String,
    files: List<Outgoing>,
    token: String,
    ssid: String?,
    passphrase: String?,
    address: String,
    route: String,
    promise: Promise,
  ) {
    try {
      val beam = BeamServer(
        resolver = context.contentResolver,
        manifest = manifest,
        files = files,
        token = token,
      ) { event -> sendEvent("onBeamPeer", event) }
      server = beam
      val port = beam.start()
      promise.resolve(
        mapOf(
          "ssid" to (ssid ?: ""),
          "passphrase" to (passphrase ?: ""),
          "host" to address,
          "port" to port,
          "route" to route,
        ),
      )
    } catch (e: Exception) {
      stopHost()
      promise.reject(e.asCoded())
    }
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

  private fun stopHost() {
    server?.stop()
    server = null
    host?.stop()
    host = null
  }

  private fun releaseJoin() {
    join?.release()
    join = null
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
    else -> BeamFailedException(message ?: javaClass.simpleName)
  }

  companion object {
    /**
     * Bringing a group up is a few seconds on a good phone and slow on a bad
     * one. Generous, because the preflight in `blocker()` now catches the cases
     * that were never going to succeed however long they were given.
     */
    private const val GROUP_TIMEOUT_MS = 30_000L

    /** Includes the student tapping "Connect" in the system dialog. */
    private const val JOIN_TIMEOUT_MS = 45_000

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

class BeamFailedException(reason: String) : CodedException("ERR_BEAM", reason, null)
