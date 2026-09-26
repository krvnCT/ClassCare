package expo.modules.beam

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.NoRouteToHostException
import java.net.Socket
import java.util.zip.CRC32
import javax.net.SocketFactory

/** One file as it landed on the student's phone. */
data class Received(val path: String, val name: String, val size: Long)

/** What came off the wire: the assignment, and the files that go with it. */
data class Delivery(val manifest: String, val files: List<Received>)

/**
 * The student's end.
 *
 * Runs entirely on a background thread and never touches the UI. The only
 * interesting parameter is `factory`.
 *
 * ## Why the socket comes from a factory
 *
 * The student's phone is on the teacher's Wi-Fi Direct group, which has no
 * route to the internet. Android knows that, keeps mobile data as the default
 * network, and sends any ordinary `Socket` out over the cellular radio — where
 * `192.168.49.1` is nothing at all and the connection times out.
 *
 * `Network.getSocketFactory()` produces a socket pinned to one specific
 * network. Passing it here is what makes the transfer go over the group the
 * student just joined, and it does that without `bindProcessToNetwork`, which
 * would drag the rest of the app off the internet for the duration.
 */
object BeamClient {
  fun fetch(
    factory: SocketFactory?,
    host: String,
    port: Int,
    token: String,
    into: File,
    onProgress: (index: Int, received: Long, size: Long) -> Unit,
  ): Delivery {
    val socket: Socket = connect(factory, host, port)
    socket.use { sock ->
      sock.soTimeout = 30_000
      sock.tcpNoDelay = true

      val out = DataOutputStream(BufferedOutputStream(sock.getOutputStream()))
      val input = DataInputStream(BufferedInputStream(sock.getInputStream(), Wire.CHUNK))

      out.write(Wire.MAGIC)
      Wire.writeText(out, token, Wire.MAX_TOKEN)
      out.flush()

      /*
        Nothing at all came back.

        An end-of-stream here means the teacher's phone accepted the connection
        and hung up without a word, and there is one overwhelming reason for
        that: an older build on the other end, which closed the socket silently
        when the magic did not match instead of saying so. Reporting
        `EOFException` sent a student to look at their Wi-Fi; reporting the real
        cause sends them to update the app.
      */
      val status = try {
        input.readUnsignedByte()
      } catch (_: EOFException) {
        throw VersionMismatchException()
      }
      if (status == Wire.STATUS_BAD_TOKEN) throw BadTokenException()
      if (status == Wire.STATUS_BAD_VERSION) throw VersionMismatchException()
      if (status != Wire.STATUS_OK) throw IOException("Unexpected status $status")

      val manifest = try {
        Wire.readText(input, Wire.MAX_MANIFEST)
      } catch (_: EOFException) {
        // Accepted us, then died before describing the work. Not a version
        // problem — it got past the handshake — so say what it is.
        throw CutOffException("before the handout arrived")
      }
      val names = namesFrom(manifest)

      into.mkdirs()
      val landed = mutableListOf<Received>()
      // Written under a `.part` name and renamed at the end, so a transfer that
      // dies halfway cannot leave something that looks like a finished
      // worksheet. The student sees nothing rather than half of something.
      val partials = mutableListOf<Pair<File, File>>()

      try {
        for (index in names.indices) {
          val label = names.getOrNull(index)?.takeIf { it.isNotBlank() } ?: "file ${index + 1}"
          // Named, so a transfer that dies halfway says which file it died on.
          // The teacher's phone stops sending when it cannot read one of them,
          // and "it failed" does not tell either of them which to look at.
          val size = try {
            input.readLong()
          } catch (_: EOFException) {
            throw CutOffException(label)
          }
          if (size < 0 || size > Wire.MAX_FILE) throw IOException("Bad file size $size")

          val target = unique(into, safeName(names[index], index))
          val partial = File(target.parentFile, "${target.name}.part")
          partials.add(partial to target)

          val crc = CRC32()
          BufferedOutputStream(partial.outputStream(), Wire.CHUNK).use { sink ->
            val buffer = ByteArray(Wire.CHUNK)
            var got = 0L
            var lastReport = 0L
            while (got < size) {
              val want = minOf(buffer.size.toLong(), size - got).toInt()
              val read = input.read(buffer, 0, want)
              if (read < 0) throw IOException("Connection closed with ${size - got} bytes to go")
              sink.write(buffer, 0, read)
              crc.update(buffer, 0, read)
              got += read
              if (got - lastReport >= 256 * 1024 || got == size) {
                lastReport = got
                onProgress(index, got, size)
              }
            }
          }

          /*
            Checked before the file is given a real name.

            A worksheet that arrived corrupt is worse than one that did not
            arrive: the student has something on their phone, it looks
            finished, and they find out it is broken when they try to open it —
            usually at home, with nobody to ask. The `.part` file is thrown
            away by the `catch` below, so a failure here leaves nothing.
          */
          val expected = try {
            input.readInt()
          } catch (_: EOFException) {
            throw CutOffException(label)
          }
          if (crc.value.toInt() != expected) throw CorruptFileException(label)

          landed.add(Received(target.absolutePath, target.name, size))
        }

        for ((partial, target) in partials) {
          if (!partial.renameTo(target)) throw IOException("Could not save ${target.name}")
        }
      } catch (e: Exception) {
        for ((partial, _) in partials) runCatching { partial.delete() }
        for (file in landed) runCatching { File(file.path).delete() }
        throw e
      }

      return Delivery(manifest, landed)
    }
  }

  /**
   * Reach the teacher's phone, allowing for a network that is not quite ready.
   *
   * A freshly joined Wi-Fi network reports itself up before DHCP has finished,
   * and a socket opened in that window fails immediately with "network is
   * unreachable" — not after a timeout, instantly, which is why no amount of
   * waiting inside `connect` helps. Retrying for a few seconds covers it, and
   * covers the student who scanned a moment before the teacher's phone
   * finished starting.
   *
   * Only for the two errors that mean "not yet". Anything else — refused,
   * timed out — is a real answer and is passed straight through.
   */
  private fun connect(factory: SocketFactory?, host: String, port: Int): Socket {
    val giveUp = System.currentTimeMillis() + REACH_MS
    var last: Exception? = null
    while (System.currentTimeMillis() < giveUp) {
      val socket = factory?.createSocket() ?: Socket()
      try {
        socket.connect(InetSocketAddress(host, port), CONNECT_MS)
        return socket
      } catch (e: Exception) {
        runCatching { socket.close() }
        val notYet = e is ConnectException || e is NoRouteToHostException
        if (!notYet) throw e
        last = e
        Thread.sleep(RETRY_MS)
      }
    }
    throw UnreachableException(host, last)
  }

  /** Long enough for DHCP on a slow phone, short enough to still be waiting. */
  private const val REACH_MS = 12_000L
  private const val CONNECT_MS = 8_000
  private const val RETRY_MS = 700L

  /**
   * Filenames out of the manifest, without pulling in a JSON library.
   *
   * The manifest is handed back to JavaScript verbatim and parsed properly
   * there; all this end needs is how many files to expect and what to call
   * them, and `org.json` is already in the platform.
   */
  private fun namesFrom(manifest: String): List<String> {
    val files = org.json.JSONObject(manifest).optJSONArray("f") ?: return emptyList()
    return (0 until files.length()).map { files.optJSONObject(it)?.optString("n").orEmpty() }
  }

  /**
   * A name safe to write to disk.
   *
   * The name arrives from another phone, so it is untrusted input pointed at
   * the filesystem. `..` and `/` are how a filename becomes a path, and this
   * app's own storage is where that path would land.
   */
  private fun safeName(raw: String, index: Int): String {
    val cleaned = raw
      .replace('\\', '_')
      .substringAfterLast('/')
      .replace(Regex("[\\u0000-\\u001F]"), "")
      .trim()
      .trimStart('.')
      .take(120)
    return cleaned.ifBlank { "file-${index + 1}" }
  }

  /** `worksheet.pdf`, then `worksheet (2).pdf`. Never overwrite. */
  private fun unique(dir: File, name: String): File {
    val candidate = File(dir, name)
    if (!candidate.exists()) return candidate
    val stem = name.substringBeforeLast('.', name)
    val ext = name.substringAfterLast('.', "")
    val suffix = if (ext.isEmpty()) "" else ".$ext"
    var n = 2
    while (true) {
      val next = File(dir, "$stem ($n)$suffix")
      if (!next.exists()) return next
      n += 1
    }
  }
}

class BadTokenException : IOException("This code is not for this transfer")

/**
 * The file arrived damaged.
 *
 * Distinct from a dropped connection, and the distinction is the teacher's:
 * a drop is "stand closer and scan again", corruption on a link this short is
 * usually a sign the file itself could not be read on the far side.
 */
class CorruptFileException(name: String) : IOException("$name did not arrive intact")

/** The two apps were built from different versions of the protocol. */
class VersionMismatchException : IOException("The other app is a different version")

/**
 * Nothing answered at the teacher's address.
 *
 * Almost always one thing on the routes with no network name in the code: this
 * phone is not on the teacher's network. It is the failure a student hits when
 * the teacher's hotspot is on and they have not joined it, and "connect failed:
 * ENETUNREACH" is not a sentence that gets them any closer to joining it.
 */
class UnreachableException(host: String, cause: Exception?) :
  IOException("Nothing answered at $host", cause)

/**
 * The teacher's phone stopped sending partway through.
 *
 * Separate from corruption, because the remedy is different and so is the
 * cause: this is the shape a *sender-side* failure takes on the receiving end.
 * A file the teacher's phone could not read, or a student who walked out of
 * range, both arrive here — and naming the file is what lets the two of them
 * work out which.
 */
class CutOffException(val where: String) : IOException("The transfer stopped at $where")
