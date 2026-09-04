package expo.modules.beam

import android.Manifest
import android.content.Context
import android.os.Build
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
 * The teacher's phone becomes a Wi-Fi access point ([WifiDirectHost]) and
 * serves the assignment over a plain socket ([BeamServer]). The QR on their
 * screen carries the network name, the password, the port and a one-use token —
 * everything a student's phone needs to join and ask, and nothing else. The
 * student's phone joins that network ([WifiJoin]) and pulls the files
 * ([BeamClient]).
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
     * What would stop a share right now: "unsupported", "wifiOff",
     * "locationOff", or null.
     *
     * Asked before starting rather than discovered by waiting. Each of these
     * used to spend twenty seconds becoming a timeout, and a timeout is the one
     * error message that tells a teacher nothing about what to do next.
     */
    Function("blocker") { WifiDirectHost(context).blocker() }

    /** False below Android 10: the student has to join the network by hand. */
    Function("canJoinAutomatically") { Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q }

    AsyncFunction("getPermissionsAsync") { promise: Promise ->
      Permissions.getPermissionsWithPermissionsManager(appContext.permissions, promise, *needed())
    }

    AsyncFunction("requestPermissionsAsync") { promise: Promise ->
      Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, *needed())
    }

    /* ------------------------------------------------------------- Sending */

    AsyncFunction("startHostAsync") { manifest: String, files: List<FileArg>, token: String, promise: Promise ->
      stopHost()

      val directHost = WifiDirectHost(context).also { host = it }
      when (directHost.blocker()) {
        "unsupported" -> throw BeamUnavailableException()
        "wifiOff" -> throw BeamWifiOffException()
        "locationOff" -> throw BeamLocationOffException()
      }

      directHost.start(GROUP_TIMEOUT_MS) { result ->
        val group = result.getOrElse {
          stopHost()
          promise.reject(it.asCoded())
          return@start
        }
        try {
          val beam = BeamServer(
            resolver = context.contentResolver,
            manifest = manifest,
            files = files.map { Outgoing(it.uri, it.name, it.mime) },
            token = token,
          ) { event -> sendEvent("onBeamPeer", event) }
          server = beam
          val port = beam.start()
          promise.resolve(
            mapOf(
              "ssid" to group.ssid,
              "passphrase" to group.passphrase,
              "host" to group.host,
              "port" to port,
            ),
          )
        } catch (e: Exception) {
          stopHost()
          promise.reject(e.asCoded())
        }
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
        pull(null, options, promise)
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
          into = File(options.directory),
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

  private fun Throwable.asCoded(): CodedException =
    this as? CodedException ?: BeamFailedException(message ?: javaClass.simpleName)

  companion object {
    /**
     * Bringing a group up is a few seconds on a good phone and slow on a bad
     * one. Generous, because the preflight in `blocker()` now catches the cases
     * that were never going to succeed however long they were given.
     */
    private const val GROUP_TIMEOUT_MS = 30_000L

    /** Includes the student tapping "Connect" in the system dialog. */
    private const val JOIN_TIMEOUT_MS = 45_000
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

class BeamGroupException(reason: String) : CodedException("ERR_BEAM_GROUP", reason, null)

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

class BeamManualJoinException : CodedException(
  "ERR_BEAM_JOIN_MANUAL",
  "This phone is too old to join a network on its own.",
  null,
)

class BeamFailedException(reason: String) : CodedException("ERR_BEAM", reason, null)
