package expo.modules.beam

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.WifiNetworkSpecifier
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Handler
import android.os.Looper

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
   * Create the group, then call back once it has a name and an address.
   *
   * Always on the main thread — `WifiP2pManager.Channel` is bound to the looper
   * it was initialised with, and calling in from a worker is undefined.
   */
  @Suppress("MissingPermission")
  fun start(timeoutMs: Long, done: (Result<Group>) -> Unit) {
    val wifi = manager ?: return done(Result.failure(BeamUnavailableException()))

    main.post {
      val ch = channel ?: wifi.initialize(app, Looper.getMainLooper(), null).also { channel = it }
      if (ch == null) return@post done(Result.failure(BeamUnavailableException()))

      // A group left behind by a previous share — or by a crash — makes
      // `createGroup` fail with BUSY. Clearing first is cheap and it is the
      // single most common reason sharing refuses to start twice in a row.
      wifi.removeGroup(ch, object : WifiP2pManager.ActionListener {
        override fun onSuccess() = create(wifi, ch, timeoutMs, done)
        override fun onFailure(reason: Int) = create(wifi, ch, timeoutMs, done)
      })
    }
  }

  @Suppress("MissingPermission")
  private fun create(
    wifi: WifiP2pManager,
    ch: WifiP2pManager.Channel,
    timeoutMs: Long,
    done: (Result<Group>) -> Unit,
  ) {
    var settled = false
    val giveUp = System.currentTimeMillis() + timeoutMs

    fun finish(result: Result<Group>) {
      if (settled) return
      settled = true
      done(result)
    }

    fun poll() {
      if (settled) return
      if (System.currentTimeMillis() > giveUp) {
        return finish(Result.failure(BeamGroupException("Wi-Fi Direct did not come up in time")))
      }
      wifi.requestGroupInfo(ch) { group ->
        val ssid = group?.networkName
        val passphrase = group?.passphrase
        if (group != null && group.isGroupOwner && !ssid.isNullOrEmpty() && !passphrase.isNullOrEmpty()) {
          // The group owner is 192.168.49.1 on every Android build there has
          // ever been, but it is a convention rather than a promise, so ask
          // when the framework is willing to say and fall back when it is not.
          wifi.requestConnectionInfo(ch) { info ->
            val host = info?.groupOwnerAddress?.hostAddress ?: GROUP_OWNER
            finish(Result.success(Group(ssid, passphrase, host)))
          }
          // `requestConnectionInfo` can answer with a null address for a moment
          // after the group appears. Keep polling until one of the two settles.
          main.postDelayed({ if (!settled) poll() }, POLL_MS)
        } else {
          main.postDelayed(::poll, POLL_MS)
        }
      }
    }

    wifi.createGroup(ch, object : WifiP2pManager.ActionListener {
      override fun onSuccess() = poll()
      override fun onFailure(reason: Int) {
        // BUSY often means a group already exists — which is a success in
        // disguise, so look before giving up.
        if (reason == WifiP2pManager.BUSY) poll()
        else finish(Result.failure(BeamGroupException(describe(reason))))
      }
    })
  }

  @Suppress("MissingPermission")
  fun stop() {
    val wifi = manager ?: return
    val ch = channel ?: return
    main.post { wifi.removeGroup(ch, null) }
  }

  private fun describe(reason: Int) = when (reason) {
    WifiP2pManager.P2P_UNSUPPORTED -> "This phone does not support Wi-Fi Direct"
    WifiP2pManager.BUSY -> "Wi-Fi Direct is busy"
    else -> "Wi-Fi Direct refused to start a group"
  }

  companion object {
    private const val POLL_MS = 500L
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
