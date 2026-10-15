package expo.modules.beam

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiConfiguration
import android.net.wifi.WifiManager
import android.net.wifi.p2p.WifiP2pConfig
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.RequiresApi
import java.net.Inet4Address
import java.net.NetworkInterface

/** A way onto the teacher's network, and back off it. */
interface Joiner {
  /** Leave. Safe to call twice, and before the join has finished. */
  fun release()
}

/**
 * Join the teacher's group as a Wi-Fi Direct client, with nothing to tap.
 *
 * ## Why this is the first thing tried
 *
 * The other way onto the group — asking for it as an ordinary Wi-Fi network
 * ([WifiJoin]) — makes Android put up its own "Connect to device" dialog and
 * wait for the student to find the right row in it and tap. On some builds the
 * list comes up empty, and students ended up in Settings typing a password off
 * the teacher's screen, which is the exact thing the QR exists to prevent.
 *
 * Android 10 added a way to join a group by its name and passphrase directly:
 * `WifiP2pConfig.Builder().setNetworkName(…).setPassphrase(…)` handed to
 * `connect`. The framework scans for the group and associates with the key it
 * was given — no invitation, no confirmation on either phone, no dialog. It is
 * the API that exists for exactly this: credentials read off a QR code.
 *
 * It also leaves the student's ordinary Wi-Fi alone. A Wi-Fi Direct client runs
 * beside the normal connection, so a student on the school network stays on it
 * while the worksheet comes down, and nothing has to be put back afterwards.
 *
 * ## How the socket reaches the teacher
 *
 * With no special help. Android routes a Wi-Fi Direct client's subnet on its
 * "local network", which every app can reach, so a plain socket to
 * `192.168.49.1` goes over the group whatever the default network is.
 *
 * ## When it is ready
 *
 * `connect` succeeding means the request was accepted. Joined means
 * `requestConnectionInfo` reports a formed group in which we are not the owner
 * — and usable means DHCP has given the client interface an address. Polled,
 * because the broadcast announcing each of those is unreliable across builds
 * and this is the same lesson [WifiDirectHost] learned on the other side.
 */
@RequiresApi(Build.VERSION_CODES.Q)
class P2pJoin(context: Context) : Joiner {
  private val app = context.applicationContext
  private val manager = app.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
  private val main = Handler(Looper.getMainLooper())

  private var channel: WifiP2pManager.Channel? = null
  @Volatile private var settled = false
  @Volatile private var released = false

  @Suppress("MissingPermission")
  fun join(ssid: String, passphrase: String, timeoutMs: Long, done: (Result<Unit>) -> Unit) {
    val wifi = manager ?: return done(Result.failure(BeamJoinException("no Wi-Fi Direct")))

    fun finish(result: Result<Unit>) {
      if (settled) return
      settled = true
      done(result)
    }

    val config = try {
      WifiP2pConfig.Builder()
        .setNetworkName(ssid)
        .setPassphrase(passphrase)
        .build()
    } catch (e: Exception) {
      // A name that is not `DIRECT-xy…` or a passphrase out of range. Not ours
      // to fix here; the system dialog does not care about either.
      return done(Result.failure(BeamJoinException("not a Wi-Fi Direct group: ${e.message}")))
    }

    main.post {
      if (released) return@post finish(Result.failure(BeamJoinException("released")))
      val ch = wifi.initialize(app, Looper.getMainLooper()) {
        Log.i(TAG, "join: channel disconnected")
        finish(Result.failure(BeamJoinException("channel lost")))
      }
      if (ch == null) return@post finish(Result.failure(BeamJoinException("no channel")))
      channel = ch

      main.postDelayed({ finish(Result.failure(BeamJoinException("timeout"))) }, timeoutMs)

      fun poll() {
        if (settled || released) return
        wifi.requestConnectionInfo(ch) { info ->
          if (settled || released) return@requestConnectionInfo
          if (info?.groupFormed == true && !info.isGroupOwner && clientAddress() != null) {
            Log.i(TAG, "join: on $ssid as a Wi-Fi Direct client")
            finish(Result.success(Unit))
          } else {
            main.postDelayed(::poll, POLL_MS)
          }
        }
      }

      val connect = {
        Log.i(TAG, "join: connecting to $ssid")
        wifi.connect(ch, config, object : WifiP2pManager.ActionListener {
          override fun onSuccess() = poll()

          override fun onFailure(reason: Int) {
            finish(Result.failure(BeamJoinException("connect refused ($reason)")))
          }
        })
      }

      // Out of any group first. A phone still in last lesson's group — or
      // that was itself a group owner — answers BUSY to a new connect.
      wifi.removeGroup(ch, object : WifiP2pManager.ActionListener {
        override fun onSuccess() {
          main.postDelayed({ connect() }, SETTLE_MS)
        }

        override fun onFailure(reason: Int) {
          connect()
        }
      })
    }
  }

  @Suppress("MissingPermission")
  override fun release() {
    if (released) return
    released = true
    val wifi = manager ?: return
    main.post {
      val ch = channel ?: return@post
      runCatching { wifi.cancelConnect(ch, null) }
      runCatching { wifi.removeGroup(ch, null) }
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
        // Closed a little later: removeGroup is asynchronous inside the
        // framework, and closing the channel under it can drop the request.
        main.postDelayed({ runCatching { ch.close() } }, 1_000)
      }
      channel = null
    }
  }

  /** An IPv4 address on a Wi-Fi Direct interface — DHCP has finished. */
  private fun clientAddress(): String? = runCatching {
    NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
      .filter { runCatching { it.name.startsWith("p2p") && it.isUp }.getOrDefault(false) }
      .flatMap { it.inetAddresses.toList() }
      .filterIsInstance<Inet4Address>()
      .firstOrNull { !it.isLoopbackAddress && it.isSiteLocalAddress }
      ?.hostAddress
  }.getOrNull()

  private companion object {
    const val TAG = "Beam"
    const val POLL_MS = 400L
    const val SETTLE_MS = 400L
  }
}

/**
 * Join the old way, on Android 9 and below.
 *
 * Those versions have neither the Wi-Fi Direct join above nor the network
 * request [WifiJoin] uses — and they do not need either, because they still let
 * an app save a network and connect to it. Android 10 took that away from apps;
 * on the phones that predate it, it is the one way to get a student on without
 * them typing a password, so it is used rather than the "type this in Settings"
 * message that was there before.
 *
 * Undone in [release]: the network is forgotten and the phone's own networks
 * are switched back on, so a student is not left on a dead group after class.
 *
 * Ready means the Wi-Fi network holds an address on the teacher's subnet — not
 * that it is called the right thing. These versions hide the network's name
 * from apps without location switched on, and the address is the same answer
 * without needing it.
 */
@Suppress("DEPRECATION")
class LegacyJoin(context: Context) : Joiner {
  private val app = context.applicationContext
  private val wifi = app.getSystemService(Context.WIFI_SERVICE) as WifiManager
  private val connectivity =
    app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
  private val main = Handler(Looper.getMainLooper())

  private var netId = -1
  @Volatile private var settled = false
  @Volatile private var released = false

  fun join(
    ssid: String,
    passphrase: String,
    host: String,
    timeoutMs: Long,
    done: (Result<Network?>) -> Unit,
  ) {
    fun finish(result: Result<Network?>) {
      if (settled) return
      settled = true
      done(result)
    }

    val config = WifiConfiguration().apply {
      SSID = "\"$ssid\""
      preSharedKey = "\"$passphrase\""
      allowedKeyManagement.set(WifiConfiguration.KeyMgmt.WPA_PSK)
    }
    netId = runCatching { wifi.addNetwork(config) }.getOrDefault(-1)
    if (netId == -1) return finish(Result.failure(BeamJoinException("could not save $ssid")))

    runCatching {
      wifi.disconnect()
      wifi.enableNetwork(netId, true)
      wifi.reconnect()
    }

    val subnet = host.substringBeforeLast('.', "")
    val giveUp = System.currentTimeMillis() + timeoutMs

    fun poll() {
      if (settled || released) return
      val network = connectivity.allNetworks.firstOrNull { n ->
        val caps = connectivity.getNetworkCapabilities(n)
        caps?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true &&
          connectivity.getLinkProperties(n)?.linkAddresses?.any {
            val a = it.address
            a is Inet4Address && subnet.isNotEmpty() && a.hostAddress?.startsWith("$subnet.") == true
          } == true
      }
      when {
        network != null -> finish(Result.success(network))
        System.currentTimeMillis() > giveUp ->
          finish(Result.failure(BeamJoinException("timeout joining $ssid")))
        else -> main.postDelayed(::poll, 500)
      }
    }
    main.postDelayed(::poll, 500)
  }

  override fun release() {
    if (released) return
    released = true
    val id = netId
    netId = -1
    if (id == -1) return
    runCatching {
      wifi.removeNetwork(id)
      wifi.saveConfiguration()
      // `enableNetwork(…, true)` switched every other saved network off.
      // Switch them back on, or the student's phone stays off its own Wi-Fi.
      wifi.configuredNetworks?.forEach { wifi.enableNetwork(it.networkId, false) }
      wifi.reconnect()
    }
  }
}
