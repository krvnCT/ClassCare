package expo.modules.beam

import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.util.Log
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * A network that already exists, and how to be reached on it.
 *
 * ## Why this is the most important file in the module
 *
 * The first version of this feature had exactly one way to hand a file over:
 * bring up a Wi-Fi Direct group. When that could not happen the share did not
 * happen, and the commonest reason it could not happen turned out to be the
 * teacher's own hotspot — a Wi-Fi chipset hands out a fixed, small number of
 * interfaces, and a running hotspot is holding the one Wi-Fi Direct needs.
 *
 * Which is backwards, because a teacher whose hotspot is on is a teacher whose
 * class is *already connected to their phone*. The situation the app treated as
 * the blocking failure is the situation with the best network in it.
 *
 * So: before building a network, look for one. The phone's own hotspot first —
 * the students are on it, it needs no permission, no Location Services and no
 * group to come up. Then the Wi-Fi it is joined to, which covers a room with
 * working Wi-Fi that everybody is already on.
 *
 * ## What this deliberately does not do
 *
 * It does not turn the hotspot on, and it does not join anything. Both of those
 * are the teacher's to decide and Android would not allow the first in any
 * case. This only reports what is already true.
 */
enum class Route {
  /** A Wi-Fi Direct group this app brought up. */
  DIRECT,

  /** The phone's own hotspot, already running. */
  HOTSPOT,

  /** A Wi-Fi network the phone is joined to. */
  LAN,
}

/** Where this phone can be reached, and over what. */
data class LocalAddress(val address: String, val iface: String, val route: Route)

class LocalNet(context: Context) {
  private val app = context.applicationContext

  /** The hotspot if it is up, else the joined Wi-Fi, else nothing. */
  fun existing(): LocalAddress? = hotspot() ?: lan()

  /**
   * The phone's own hotspot, if it is running.
   *
   * Read off the interface list rather than asked for. `isWifiApEnabled` has
   * been hidden from apps since API 26 and reflecting at it is blocked outright
   * now; an interface called `ap0` that is up and holding an address is the
   * same fact, needs no permission, and cannot be taken away.
   *
   * The address matters as much as the answer. The classic `192.168.43.1` is
   * not what modern builds use — the phone this was debugged on was handing out
   * `10.92.141.85` — so the address is read from the interface rather than
   * assumed, and it is what goes in the QR.
   *
   * `p2p` is excluded by name: that is the interface we bring up ourselves, and
   * matching it would make this claim the teacher's hotspot is on whenever a
   * Wi-Fi Direct group is up.
   */
  fun hotspot(): LocalAddress? {
    val interfaces = runCatching { NetworkInterface.getNetworkInterfaces()?.toList() }
      .getOrNull() ?: return null

    for (iface in interfaces) {
      /*
        Guarded one interface at a time, not around the whole loop.

        `isUp` and `getInetAddresses` throw `SocketException` for some virtual
        interfaces, and this phone carries about forty of them — ccmni0 to
        ccmni20, tunl0, gre0, ip6tnl0. Wrapping the whole scan meant the first
        one to throw aborted it and the answer came back "no hotspot", which is
        the check failing silently at the one job it exists for.
      */
      val hit = runCatching {
        val name = iface.name?.lowercase() ?: return@runCatching null
        if (name.startsWith("p2p")) return@runCatching null
        val looksLikeAp =
          name.startsWith("ap") || name.startsWith("softap") ||
            name == "wlan1" || name == "swlan0"
        if (!looksLikeAp || !iface.isUp) return@runCatching null
        iface.inetAddresses
          .toList()
          .filterIsInstance<Inet4Address>()
          .firstOrNull { !it.isLoopbackAddress && it.isSiteLocalAddress }
          ?.hostAddress
          ?.let { LocalAddress(it, iface.name, Route.HOTSPOT) }
      }.getOrNull()

      if (hit != null) {
        Log.i(TAG, "hotspot is up on ${hit.iface} at ${hit.address}")
        return hit
      }
    }
    return null
  }

  /**
   * The Wi-Fi network this phone is joined to, if any.
   *
   * Asked of `ConnectivityManager` rather than guessed from interface names,
   * because the question is not "is there a `wlan0`" — there is one whether or
   * not it is associated with anything — but "is this phone on a Wi-Fi network
   * right now", and that is what the active network says.
   *
   * Restricted to private addresses. A phone on a public IPv4 has no business
   * opening a file server on it, and a captive-portal address is not somewhere
   * a classmate can reach anyway.
   *
   * Worth knowing about the cases this does not solve: plenty of school and
   * café access points have client isolation switched on, which blocks
   * phone-to-phone traffic outright. That is why this is the last route tried
   * rather than the first, and why the Wi-Fi Direct group — which is a network
   * with nobody's rules on it but ours — stays the default.
   */
  fun lan(): LocalAddress? {
    val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
      ?: return null
    val network = cm.activeNetwork ?: return null
    val caps = cm.getNetworkCapabilities(network) ?: return null
    if (!caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) return null

    val props = cm.getLinkProperties(network) ?: return null
    val address = props.linkAddresses
      .map { it.address }
      .filterIsInstance<Inet4Address>()
      .firstOrNull { !it.isLoopbackAddress && it.isSiteLocalAddress }
      ?.hostAddress ?: return null

    return LocalAddress(address, props.interfaceName ?: "wlan", Route.LAN)
  }

  private companion object {
    const val TAG = "Beam"
  }
}
