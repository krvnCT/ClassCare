package expo.modules.beam

import android.content.Context
import android.location.LocationManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.net.wifi.WifiManager
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.net.Inet4Address
import java.net.NetworkInterface
import androidx.annotation.RequiresApi
import kotlin.random.Random

/** The group a teacher just created, as the QR needs to describe it. */
data class Group(val ssid: String, val passphrase: String, val host: String)

/**
 * The teacher becomes a Wi-Fi access point.
 *
 * ## Why Wi-Fi Direct and not the classroom's own Wi-Fi
 *
 * Because the classroom's own Wi-Fi is the thing that fails. Most school and
 * public access points have client isolation switched on, which blocks
 * phone-to-phone traffic outright — so a transfer over the room's network dies
 * in exactly the room it was built for, and dies silently. Plenty of rooms have
 * no Wi-Fi at all.
 *
 * `createGroup()` sidesteps all of it. The teacher's phone becomes a group
 * owner, which is a real WPA2 access point with a name and a password, and it
 * needs no router, no internet and nobody's permission. This is what ShareIt
 * and every app like it does.
 *
 * The useful property, and the reason this is preferred over `startLocalOnly`
 * `Hotspot`: a Wi-Fi Direct group is joinable by *legacy* clients. The student
 * does not need Wi-Fi Direct, or an understanding of it, or a peer handshake —
 * their phone joins `DIRECT-xy-Android` the way it would join a café. So the QR
 * only has to carry a network name and a password, and the receiving side is
 * ordinary Wi-Fi code.
 *
 * ## Why it polls
 *
 * `createGroup` reports that the *request* was accepted, not that the group
 * exists. The name and passphrase only appear once the framework has brought
 * the interface up, and the broadcast that announces it does not fire reliably
 * across OEM builds. Asking every half second until the answer is there is
 * duller than a receiver and it works on phones the receiver does not.
 */
class WifiDirectHost(context: Context) {
  private val manager = context.applicationContext
    .getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
  private val app = context.applicationContext
  private val main = Handler(Looper.getMainLooper())

  private var channel: WifiP2pManager.Channel? = null

  val available: Boolean get() = manager != null

  /**
   * What is standing in the way, before anything is attempted.
   *
   * Every one of these used to surface as "Wi-Fi Direct did not come up in
   * time" twenty seconds later, which tells the teacher nothing they can act
   * on. They are all one tap away from being fixed, and none of them are the
   * app's to fix silently.
   *
   * Location is the surprising one. Wi-Fi Direct brings up an access point,
   * and Android treats that as location-adjacent: with Location Services
   * switched *off* at the system level, `createGroup` reports success and the
   * group never appears — no error, no callback, nothing. Holding the
   * permission is not the same as the setting being on.
   */
  fun blocker(): String? {
    if (manager == null) return "unsupported"
    val wifi = app.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    if (wifi?.isWifiEnabled != true) return "wifiOff"
    if (hotspotOn()) return "hotspotOn"
    if (!locationOn()) return "locationOff"
    return null
  }

  /**
   * Whether the phone's own hotspot is running.
   *
   * This is the one that actually happened, on a Xiaomi running Android 16, and
   * nothing in the app or the framework said so. A Wi-Fi chipset hands out a
   * fixed, small number of interfaces; with the hotspot holding the AP slot
   * there is none left for Wi-Fi Direct. The system log says
   * `bestIfaceCreationProposal is null` and then simply never brings `p2p0` up —
   * `createGroup` reports success, no callback ever comes, and the app times
   * out on a phone where Wi-Fi, Location and the permission are all fine.
   *
   * Read off the interface list rather than asked. `isWifiApEnabled` has been
   * hidden from apps since API 26 and reflecting at it is blocked outright now;
   * an interface called `ap0` that is up and holding an address is the same
   * fact, needs no permission, and cannot be taken away.
   *
   * `p2p0` is excluded by name: that is the interface *we* bring up, and
   * matching it would make the check refuse the thing it is guarding.
   */
  private fun hotspotOn(): Boolean {
    val interfaces = runCatching { NetworkInterface.getNetworkInterfaces()?.toList() }
      .getOrNull() ?: return false

    for (iface in interfaces) {
      /*
        Guarded one at a time, not around the whole loop.

        `isUp` and `getInetAddresses` throw `SocketException` for some virtual
        interfaces, and this phone carries about forty of them — ccmni0 to
        ccmni20, tunl0, gre0, ip6tnl0. Wrapping the whole scan meant the first
        one to throw aborted it and the answer came back "no hotspot", which is
        exactly the check failing silently at the job it exists for.
      */
      val hit = runCatching {
        val name = iface.name?.lowercase() ?: return@runCatching false
        // `p2p` first: that is the interface we bring up ourselves, and
        // matching it would make this refuse the very thing it guards.
        if (name.startsWith("p2p")) return@runCatching false
        val looksLikeAp =
          name.startsWith("ap") || name.startsWith("softap") ||
            name == "wlan1" || name == "swlan0"
        if (!looksLikeAp || !iface.isUp) return@runCatching false
        iface.inetAddresses.toList().any { !it.isLoopbackAddress && it is Inet4Address }
      }.getOrDefault(false)

      if (hit) {
        note("hotspot is up on ${iface.name}")
        return true
      }
    }
    return false
  }

  private fun locationOn(): Boolean {
    val lm = app.getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return true
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      lm.isLocationEnabled
    } else {
      @Suppress("DEPRECATION")
      lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
        lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)
    }
  }

  /**
   * Everything that happened, in order, for the screen to show when it fails.
   *
   * The first version of this reported "did not come up in time" and nothing
   * else, which is unactionable on a phone with Wi-Fi and Location both on —
   * and this is the sort of bug that only ever reproduces on somebody else's
   * handset. Each step is logged under `Beam` for `adb logcat -s Beam` and kept
   * here so a teacher with no cable can read the same trace off the screen.
   */
  private val trace = ArrayDeque<String>()

  private fun note(line: String) {
    Log.i(TAG, line)
    synchronized(trace) {
      trace.addLast(line)
      while (trace.size > 12) trace.removeFirst()
    }
  }

  private fun traceText(): String = synchronized(trace) { trace.joinToString(" · ") }

  /**
   * Create the group, then call back once it is up.
   *
   * Always on the main thread — `WifiP2pManager.Channel` is bound to the looper
   * it was initialised with, and calling in from a worker is undefined.
   */
  @Suppress("MissingPermission")
  fun start(timeoutMs: Long, done: (Result<Group>) -> Unit) {
    val wifi = manager ?: return done(Result.failure(BeamUnavailableException()))

    main.post {
      /*
        A real channel listener, where this used to pass null.

        The framework drops the channel when the Wi-Fi stack restarts, and
        every call on a dead channel then silently does nothing — no error, no
        callback. That is indistinguishable from a group that is slow to appear,
        and it is one of the ways this timed out on a phone with everything
        switched on.
      */
      val ch = channel ?: wifi.initialize(app, Looper.getMainLooper()) {
        note("channel disconnected")
        channel = null
      }.also { channel = it }

      if (ch == null) return@post done(Result.failure(BeamUnavailableException()))
      note("channel ready, sdk=${Build.VERSION.SDK_INT}")

      // A group left behind by a previous share — or by a crash — makes
      // `createGroup` fail with BUSY. Clearing first is cheap and it is the
      // single most common reason sharing refuses to start twice in a row.
      wifi.removeGroup(ch, object : WifiP2pManager.ActionListener {
        override fun onSuccess() {
          note("old group removed")
          // Not immediately. The removal is asynchronous inside the framework
          // whatever this callback says, and creating into a half-torn-down
          // group is a BUSY that then never resolves.
          main.postDelayed({ create(wifi, ch, timeoutMs, done) }, SETTLE_MS)
        }

        override fun onFailure(reason: Int) {
          note("no old group (${describe(reason)})")
          main.postDelayed({ create(wifi, ch, timeoutMs, done) }, SETTLE_MS)
        }
      })
    }
  }

  /**
   * A network name and password of our own.
   *
   * The reason this exists is the bug it fixes. The old code called the
   * no-argument `createGroup` and then polled `requestGroupInfo` until it
   * reported a name *and* a passphrase — but plenty of OEM builds return null
   * from `getPassphrase()` for a group the framework generated itself, so the
   * poll never succeeded and the whole thing timed out on a phone where
   * everything was working.
   *
   * Choosing them ourselves removes the question. `createGroup(config)` is
   * API 29 and up; below that there is no way to specify them and the old path
   * is all there is.
   *
   * The name must begin with `DIRECT-` — the framework rejects anything else —
   * and the passphrase must be 8 to 63 characters.
   */
  @RequiresApi(Build.VERSION_CODES.Q)
  private fun ourConfig(): Pair<WifiP2pConfig, Group> {
    val tag = (1..4).map { ALPHABET.random() }.joinToString("")
    val ssid = "DIRECT-$tag-ClassCare"
    val passphrase = (1..10).map { ALPHABET[Random.nextInt(ALPHABET.length)] }.joinToString("")
    val config = WifiP2pConfig.Builder()
      .setNetworkName(ssid)
      .setPassphrase(passphrase)
      // 2.4 GHz: it carries further across a classroom and every phone in one
      // supports it. 5 GHz would be faster and is not the constraint here.
      .setGroupOperatingBand(WifiP2pConfig.GROUP_OWNER_BAND_2GHZ)
      .enablePersistentMode(false)
      .build()
    return config to Group(ssid, passphrase, GROUP_OWNER)
  }

  @Suppress("MissingPermission")
  private fun create(
    wifi: WifiP2pManager,
    ch: WifiP2pManager.Channel,
    timeoutMs: Long,
    done: (Result<Group>) -> Unit,
  ) {
    var settled = false
    var lastFailure: String? = null
    val giveUp = System.currentTimeMillis() + timeoutMs

    fun finish(result: Result<Group>) {
      if (settled) return
      settled = true
      done(result)
    }

    /** Ours when we chose them, the framework's when we could not. */
    val chosen = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ourConfig() else null

    fun address(then: (String) -> Unit) {
      wifi.requestConnectionInfo(ch) { info ->
        then(info?.groupOwnerAddress?.hostAddress ?: GROUP_OWNER)
      }
      // `requestConnectionInfo` can answer with a null address, or not answer
      // at all, for a moment after the group appears. The convention address is
      // correct on every Android build there has ever been, so do not hang on
      // the polite version of the question.
      main.postDelayed({ if (!settled) then(GROUP_OWNER) }, ADDRESS_GRACE_MS)
    }

    fun poll() {
      if (settled) return
      if (System.currentTimeMillis() > giveUp) {
        val why = lastFailure?.let { " ($it)" } ?: ""
        note("gave up after ${timeoutMs}ms")
        return finish(Result.failure(BeamGroupException("timeout$why", traceText())))
      }
      wifi.requestGroupInfo(ch) { group ->
        if (group == null || !group.isGroupOwner) {
          main.postDelayed(::poll, POLL_MS)
          return@requestGroupInfo
        }

        /*
          The group exists. Its own name and passphrase are preferred when it
          will say them, and ours are used when it will not — which is the whole
          point of having chosen them.

          Without a fallback this is where it used to stop: a real, working
          group, reported with a null passphrase, polled until the timeout.
        */
        val ssid = group.networkName?.takeIf { it.isNotEmpty() } ?: chosen?.second?.ssid
        val passphrase = group.passphrase?.takeIf { it.isNotEmpty() } ?: chosen?.second?.passphrase

        if (ssid.isNullOrEmpty() || passphrase.isNullOrEmpty()) {
          note("group up but unnamed, waiting")
          main.postDelayed(::poll, POLL_MS)
          return@requestGroupInfo
        }

        note("group up: $ssid")
        address { host -> finish(Result.success(Group(ssid, passphrase, host))) }
      }
    }

    val listener = object : WifiP2pManager.ActionListener {
      override fun onSuccess() {
        note("createGroup accepted")
        poll()
      }

      override fun onFailure(reason: Int) {
        lastFailure = describe(reason)
        note("createGroup refused: ${describe(reason)}")
        // BUSY often means a group already exists — which is a success in
        // disguise, so look before giving up.
        if (reason == WifiP2pManager.BUSY) poll()
        else finish(Result.failure(BeamGroupException(describe(reason), traceText())))
      }
    }

    if (chosen != null) {
      note("createGroup with our own name")
      wifi.createGroup(ch, chosen.first, listener)
    } else {
      note("createGroup, legacy (sdk<29)")
      wifi.createGroup(ch, listener)
    }
  }

  @Suppress("MissingPermission")
  fun stop() {
    val wifi = manager ?: return
    val ch = channel ?: return
    main.post { wifi.removeGroup(ch, null) }
  }

  private fun describe(reason: Int) = when (reason) {
    WifiP2pManager.P2P_UNSUPPORTED -> "unsupported"
    WifiP2pManager.BUSY -> "busy"
    WifiP2pManager.ERROR -> "error"
    else -> "refused"
  }

  companion object {
    private const val TAG = "Beam"
    private const val POLL_MS = 400L
    /** Long enough for the framework to finish tearing an old group down. */
    private const val SETTLE_MS = 600L
    /** How long to be polite about asking for the address before assuming it. */
    private const val ADDRESS_GRACE_MS = 1_500L
    private const val ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"
    const val GROUP_OWNER = "192.168.49.1"
  }
}

/**
 * The student joins that access point.
 *
 * Deliberately *not* Wi-Fi Direct on this side. A peer-to-peer connect needs
 * discovery, a MAC address and a confirmation dialog on the teacher's phone for
 * every single student — thirty dialogs during a lesson. Joining the group's
 * SSID as an ordinary Wi-Fi client needs only the two strings from the QR and
 * one tap on the student's own phone.
 *
 * The network is requested with `NET_CAPABILITY_INTERNET` removed, because it
 * genuinely has none: leave it in and Android decides the network is broken and
 * tears it down mid-transfer. `bindProcessToNetwork` is avoided for the same
 * reason it is tempting — it would take the whole app off the internet, so the
 * caller uses `network.socketFactory` and nothing else in the app notices.
 *
 * Below API 29 there is no supported way to join a named network without the
 * user doing it: `addNetwork` was restricted in Android 10 and is a no-op for
 * third-party apps. Rather than pretend, this reports `manual`, and the app
 * shows the student the name and password to type in Settings once.
 */
class WifiJoin(context: Context) {
  private val app = context.applicationContext
  private val connectivity =
    app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

  private var callback: ConnectivityManager.NetworkCallback? = null

  val supported: Boolean get() = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q

  fun join(ssid: String, passphrase: String, timeoutMs: Int, done: (Result<Network>) -> Unit) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
      return done(Result.failure(BeamManualJoinException()))
    }

    val specifier = WifiNetworkSpecifier.Builder()
      .setSsid(ssid)
      .setWpa2Passphrase(passphrase)
      .build()

    val request = NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI)
      .removeCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
      .setNetworkSpecifier(specifier)
      .build()

    var settled = false
    val cb = object : ConnectivityManager.NetworkCallback() {
      override fun onAvailable(network: Network) {
        if (settled) return
        settled = true
        done(Result.success(network))
      }

      override fun onUnavailable() {
        if (settled) return
        settled = true
        done(Result.failure(BeamJoinException("Could not join $ssid")))
      }
    }

    callback = cb
    connectivity.requestNetwork(request, cb, timeoutMs)
  }

  /** Leave the group. Without this the student stays off the internet. */
  fun release() {
    callback?.let { runCatching { connectivity.unregisterNetworkCallback(it) } }
    callback = null
  }
}
