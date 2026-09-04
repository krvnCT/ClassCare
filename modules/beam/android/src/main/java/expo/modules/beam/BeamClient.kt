package expo.modules.beam

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
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
    val socket: Socket = factory?.createSocket() ?: Socket()
    socket.use { sock ->
      sock.connect(InetSocketAddress(host, port), 15_000)
      sock.soTimeout = 30_000
      sock.tcpNoDelay = true

      val out = DataOutputStream(BufferedOutputStream(sock.getOutputStream()))
      val input = DataInputStream(BufferedInputStream(sock.getInputStream(), Wire.CHUNK))

      out.write(Wire.MAGIC)
      Wire.writeText(out, token, Wire.MAX_TOKEN)
      out.flush()

      val status = input.readUnsignedByte()
      if (status == Wire.STATUS_BAD_TOKEN) throw BadTokenException()
      if (status != Wire.STATUS_OK) throw IOException("Unexpected status $status")

      val manifest = Wire.readText(input, Wire.MAX_MANIFEST)
      val names = namesFrom(manifest)

      into.mkdirs()
      val landed = mutableListOf<Received>()
      // Written under a `.part` name and renamed at the end, so a transfer that
      // dies halfway cannot leave something that looks like a finished
      // worksheet. The student sees nothing rather than half of something.
      val partials = mutableListOf<Pair<File, File>>()

      try {
        for (index in names.indices) {
          val size = input.readLong()
          if (size < 0 || size > Wire.MAX_FILE) throw IOException("Bad file size $size")

          val target = unique(into, safeName(names[index], index))
          val partial = File(target.parentFile, "${target.name}.part")
          partials.add(partial to target)

          BufferedOutputStream(partial.outputStream(), Wire.CHUNK).use { sink ->
            val buffer = ByteArray(Wire.CHUNK)
            var got = 0L
            var lastReport = 0L
            while (got < size) {
              val want = minOf(buffer.size.toLong(), size - got).toInt()
              val read = input.read(buffer, 0, want)
              if (read < 0) throw IOException("Connection closed with ${size - got} bytes to go")
              sink.write(buffer, 0, read)
              got += read
              if (got - lastReport >= 256 * 1024 || got == size) {
                lastReport = got
                onProgress(index, got, size)
              }
            }
          }
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
