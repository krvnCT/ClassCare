package expo.modules.beam

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.security.MessageDigest

/**
 * The wire format, written down once because two apps have to agree on it.
 *
 * ClassCare speaks the sending half and StudentCare speaks the receiving half,
 * and the cheapest way to keep them agreeing is for both to be built from this
 * file. Copy the module, do not retype the protocol.
 *
 * ```
 *  student -> teacher   "CCB1"                    4 bytes, ASCII
 *                       u32 len + UTF-8 token     the secret from the QR
 *
 *  teacher -> student   u8  status                0 accept, 1 wrong token
 *                       u32 len + UTF-8 manifest  JSON, the assignment
 *                       per file, in manifest order:
 *                         u64 size
 *                         exactly `size` bytes
 * ```
 *
 * ## Two decisions worth knowing
 *
 * **The size in the frame is authoritative; the size in the manifest is not.**
 * The manifest is built in JavaScript from what the file picker reported, and
 * it exists so the student sees "worksheet.pdf · 2.4 MB" before deciding to
 * accept. The frame's `u64` is measured by the sender at the moment it opens
 * the file. Keeping them separate means a file that changed on disk between
 * being picked and being sent transfers correctly and merely displays a stale
 * number, rather than truncating or hanging the reader.
 *
 * **Every length is bounded before it is allocated.** `readInt` on a socket
 * carrying anything other than this protocol returns whatever four bytes turned
 * up, and `ByteArray(that)` is then an out-of-memory crash driven by a stranger
 * on the network. The caps below are what stands between the two.
 *
 * Big-endian throughout, which is what `DataOutputStream` writes and what every
 * other language calls network byte order.
 */
object Wire {
  /** Format marker. A future version changes the digit; old apps say so. */
  val MAGIC = byteArrayOf('C'.code.toByte(), 'C'.code.toByte(), 'B'.code.toByte(), '1'.code.toByte())

  const val STATUS_OK = 0
  const val STATUS_BAD_TOKEN = 1

  /** 64 KB: comfortably above the socket buffer, far below anything worth worrying about. */
  const val CHUNK = 64 * 1024

  /** A manifest is a title, some instructions and a handful of filenames. */
  const val MAX_MANIFEST = 256 * 1024

  /** Tokens are 22 base64url characters. This is slack, not a target. */
  const val MAX_TOKEN = 256

  /** One file. Matches the picker's own ceiling in `src/lib/attachments.ts`. */
  const val MAX_FILE = 64L * 1024 * 1024

  fun writeText(out: DataOutputStream, text: String, cap: Int) {
    val bytes = text.toByteArray(Charsets.UTF_8)
    if (bytes.size > cap) throw IOException("Refusing to send ${bytes.size} bytes, cap is $cap")
    out.writeInt(bytes.size)
    out.write(bytes)
  }

  fun readText(input: DataInputStream, cap: Int): String {
    val size = input.readInt()
    if (size < 0 || size > cap) throw IOException("Bad length $size, cap is $cap")
    val bytes = ByteArray(size)
    input.readFully(bytes)
    return String(bytes, Charsets.UTF_8)
  }

  /**
   * Compare tokens without leaking where they stopped matching.
   *
   * On a Wi-Fi Direct group with one teacher and thirty students this is close
   * to theatre, and it is one line. `String.equals` returns at the first
   * differing character, which is a timing signal; `MessageDigest.isEqual` is
   * documented not to.
   */
  fun tokensMatch(a: String, b: String): Boolean =
    MessageDigest.isEqual(a.toByteArray(Charsets.UTF_8), b.toByteArray(Charsets.UTF_8))
}
