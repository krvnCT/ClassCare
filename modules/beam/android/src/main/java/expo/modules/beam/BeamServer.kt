package expo.modules.beam

import android.content.ContentResolver
import android.net.Uri
import android.provider.OpenableColumns
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.File
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.zip.CRC32

/** One file the teacher is handing out, as the sender sees it. */
data class Outgoing(val uri: String, val name: String, val mime: String)

/**
 * The teacher's end: a socket that hands the same files to whoever asks and
 * knows the token.
 *
 * ## Why the bytes never reach JavaScript
 *
 * A 10 MB PDF read into JavaScript has to be base64'd to cross the bridge,
 * which inflates it by a third and holds the whole thing in the heap twice.
 * Thirty students would do that thirty times. Here the file goes from disk to
 * socket in a 64 KB loop inside one thread and the bridge only ever carries a
 * progress number. That is the difference between a transfer that saturates
 * Wi-Fi Direct and one that runs out of memory in front of a class.
 *
 * ## Every student gets their own thread
 *
 * A pool rather than one at a time, because the interesting case is a room
 * where everybody scans at once. Files are opened per connection — the same
 * `InputStream` cannot be read by two students — and the pool is bounded so
 * that a class of forty cannot spawn forty simultaneous disk readers.
 *
 * Nothing here is stateful across connections: a student whose Wi-Fi drops
 * halfway reconnects and starts again, and the teacher does not have to do
 * anything. Resume is deliberately absent. Retrying a 2 MB worksheet over a
 * link this fast costs a second, and the bookkeeping to avoid that second is
 * how you get a file that is silently half a file.
 */
class BeamServer(
  private val resolver: ContentResolver,
  private val manifest: String,
  private val files: List<Outgoing>,
  private val token: String,
  private val onEvent: (Map<String, Any?>) -> Unit,
) {
  /**
   * Eight, matching what a Wi-Fi Direct group owner will actually hold. More
   * threads than the radio has clients is just contention.
   */
  private val workers = Executors.newFixedThreadPool(8)
  private val accepting = Executors.newSingleThreadExecutor()

  /**
   * Which phones have the handout, not how many transfers finished.
   *
   * The teacher's screen reads "12 received" and acts on it — they stop
   * holding the code up. Counting transfers meant a student who scanned twice
   * counted twice, and a student whose first attempt failed and who tapped
   * "try again" pushed the number up without anyone new getting anything. A
   * teacher trusting that count puts the phone down with half the class
   * missing the worksheet.
   *
   * Keyed by address, which is what identifies a phone on this network for the
   * few minutes the code is up. Two students cannot share one, and one student
   * keeps theirs across a retry.
   */
  private val served = java.util.Collections.synchronizedSet(mutableSetOf<String>())

  private var socket: ServerSocket? = null

  @Volatile private var running = false

  /** Bind, and report the port the OS chose. */
  fun start(): Int {
    val server = ServerSocket()
    // Reuse so a restart within the TIME_WAIT window is not refused — which is
    // exactly what happens when a teacher stops sharing and immediately starts
    // again because a student was not ready.
    server.reuseAddress = true
    server.bind(InetSocketAddress(0))
    socket = server
    running = true
    accepting.execute { acceptLoop(server) }
    return server.localPort
  }

  fun stop() {
    running = false
    runCatching { socket?.close() }
    workers.shutdownNow()
    accepting.shutdownNow()
  }

  private fun acceptLoop(server: ServerSocket) {
    while (running) {
      val client = try {
        server.accept()
      } catch (e: Exception) {
        // `close()` from `stop()` lands here. Only worth reporting if we still
        // believed we were listening.
        if (running) onEvent(mapOf("kind" to "error", "message" to (e.message ?: "accept failed")))
        return
      }
      try {
        workers.execute { serve(client) }
      } catch (_: Exception) {
        // Pool is shutting down, or full past its queue. Close rather than leak.
        runCatching { client.close() }
      }
    }
  }

  private fun serve(client: Socket) {
    val who = client.inetAddress?.hostAddress ?: "?"
    try {
      client.use { sock ->
        // A student who walks out of range mid-transfer must not hold a worker
        // thread until the OS gives up, which is minutes by default.
        sock.soTimeout = 30_000
        sock.tcpNoDelay = true

        val input = DataInputStream(BufferedInputStream(sock.getInputStream()))
        val out = DataOutputStream(BufferedOutputStream(sock.getOutputStream(), Wire.CHUNK))

        val magic = ByteArray(Wire.MAGIC.size)
        input.readFully(magic)
        if (!magic.contentEquals(Wire.MAGIC)) {
          // Said rather than hung up on. The two apps ship separately, and a
          // student running last month's StudentCare against this month's
          // ClassCare otherwise gets a transfer that fails with nothing to act
          // on. One byte back turns that into "update the other app".
          out.writeByte(Wire.STATUS_BAD_VERSION)
          out.flush()
          onEvent(mapOf("kind" to "rejected", "peer" to who))
          return
        }

        val offered = Wire.readText(input, Wire.MAX_TOKEN)
        if (!Wire.tokensMatch(offered, token)) {
          out.writeByte(Wire.STATUS_BAD_TOKEN)
          out.flush()
          onEvent(mapOf("kind" to "rejected", "peer" to who))
          return
        }

        out.writeByte(Wire.STATUS_OK)
        Wire.writeText(out, manifest, Wire.MAX_MANIFEST)
        /*
          Flushed here, and the reason is a bug it caused.

          `out` buffers 64 KB, and the status byte plus a manifest never fill
          that — so nothing actually left this phone until the first file
          flushed. When opening that file threw instead (a `content://` handle
          whose permission had lapsed), the socket closed with the buffer still
          full, and the student's phone saw a connection accepted and dropped
          without a byte. That is indistinguishable from an app too old to
          speak the protocol, and it was reported as exactly that: "the other
          app needs updating", for a file the teacher simply could not read.

          Sending the manifest before touching a single file means the receiver
          always knows what was promised, so a failure after this point reports
          as a transfer that stopped — with the file's name on it.
        */
        out.flush()
        onEvent(mapOf("kind" to "started", "peer" to who))

        files.forEachIndexed { index, file -> sendOne(out, file, index, who) }
        out.flush()

        served.add(who)
        onEvent(mapOf("kind" to "done", "peer" to who, "total" to served.size))
      }
    } catch (e: Exception) {
      onEvent(
        mapOf(
          "kind" to "failed",
          "peer" to who,
          // The class name matters as much as the text here: a
          // `SecurityException` reads as "this phone could not open the file",
          // and its message alone does not say so.
          "message" to listOfNotNull(e.javaClass.simpleName, e.message).joinToString(": "),
        ),
      )
    }
  }

  private fun sendOne(out: DataOutputStream, file: Outgoing, index: Int, who: String) {
    val uri = Uri.parse(file.uri)
    val size = sizeOf(uri)
    out.writeLong(size)

    // Computed over exactly the bytes that go on the wire, padding included —
    // so the receiver's answer is about the transfer rather than about the file
    // the picker once saw.
    val crc = CRC32()

    openStream(uri).use { source ->
      val buffer = ByteArray(Wire.CHUNK)
      var sent = 0L
      var lastReport = 0L
      while (sent < size) {
        val want = minOf(buffer.size.toLong(), size - sent).toInt()
        val read = source.read(buffer, 0, want)
        // The file shrank under us. The frame promised `size` bytes, so pad
        // rather than desync the stream — the student gets a short file they
        // can see is wrong, instead of a reader that hangs waiting for bytes
        // that will never come and then misreads the next file's header.
        if (read < 0) {
          java.util.Arrays.fill(buffer, 0, want, 0)
          out.write(buffer, 0, want)
          crc.update(buffer, 0, want)
          sent += want
          continue
        }
        out.write(buffer, 0, read)
        crc.update(buffer, 0, read)
        sent += read
        // Throttled: at 64 KB a chunk a 10 MB file is 160 writes, and thirty
        // students at once would be five thousand bridge crossings for a number
        // nobody can read that fast.
        if (sent - lastReport >= 512 * 1024 || sent == size) {
          lastReport = sent
          onEvent(
            mapOf(
              "kind" to "progress",
              "peer" to who,
              "file" to index,
              "sent" to sent,
              "size" to size,
            ),
          )
        }
      }
    }
    out.writeInt(crc.value.toInt())
    out.flush()
  }

  /**
   * The size the frame promises, measured now rather than trusted from JS.
   *
   * `content://` first because that is what Android's document picker hands
   * back, and `File.length()` on one of those returns zero.
   */
  private fun sizeOf(uri: Uri): Long {
    if (uri.scheme == "file" || uri.scheme == null) {
      val length = File(uri.path ?: "").length()
      if (length > Wire.MAX_FILE) throw java.io.IOException("File is too large to send")
      return length
    }
    resolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
      val column = cursor.getColumnIndex(OpenableColumns.SIZE)
      if (column >= 0 && cursor.moveToFirst() && !cursor.isNull(column)) {
        val length = cursor.getLong(column)
        if (length > Wire.MAX_FILE) throw java.io.IOException("File is too large to send")
        return length
      }
    }
    // A provider that will not say. Counting the stream is the only honest
    // answer left, and it is why the cap is checked as we go.
    var total = 0L
    openStream(uri).use { stream ->
      val buffer = ByteArray(Wire.CHUNK)
      while (true) {
        val read = stream.read(buffer)
        if (read < 0) break
        total += read
        if (total > Wire.MAX_FILE) throw java.io.IOException("File is too large to send")
      }
    }
    return total
  }

  private fun openStream(uri: Uri): InputStream =
    if (uri.scheme == "file" || uri.scheme == null) {
      BufferedInputStream(File(uri.path ?: "").inputStream(), Wire.CHUNK)
    } else {
      BufferedInputStream(
        resolver.openInputStream(uri) ?: throw java.io.IOException("Cannot open ${uri.lastPathSegment}"),
        Wire.CHUNK,
      )
    }
}
