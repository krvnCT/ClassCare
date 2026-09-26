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
 *  student -> teacher   "BEAM3"                   5 bytes, ASCII
 *                       u32 len + UTF-8 token     the secret from the QR
 *                       u32 len + UTF-8 device    who is asking — see below
 *
 *  teacher -> student   u8  status                0 accept, 1 wrong token,
 *                                                 2 the two apps disagree
 *                       u32 len + UTF-8 manifest  JSON, the assignment
 *                       per file, in manifest order:
 *                         u64 size
 *                         exactly `size` bytes
 *                         u32 crc32               of those bytes
 * ```
 *
 * Note this is the *socket* version, and it is not the `CCB1:` on the front of
 * the QR payload. They version separately because they change for different
 * reasons: the QR is a format two apps read, and this is a conversation two
 * apps have. Naming them differently is cheaper than explaining, every time,
 * why one went to 2 and the other did not.
 *
 * ## Three decisions worth knowing
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
 * **The device id is for counting, not for identifying.** The teacher's screen
 * says how many students have the handout, and they act on that number — they
 * stop holding the code up. Counting connections made a student who scanned
 * twice count twice; counting addresses fixed that until a phone rejoined and
 * DHCP gave it a different one. So each phone sends a random id it made up on
 * first use. It is not a hardware id and deliberately not `ANDROID_ID`: those
 * identify a person across apps, which is not what a worksheet count needs, and
 * this one is meaningless outside the teacher's tally.
 *
 * **The checksum is not about attackers, it is about truncation.** TCP carries
 * a 16-bit checksum, which is one missed corruption in every 65,000 bad
 * segments — fine for a web page, not fine for a worksheet a student cannot
 * tell is broken until they open it in front of the class. CRC32 over each
 * file costs nothing next to the Wi-Fi it arrived over, and turns "this PDF
 * will not open" into an error the app can name and retry.
 *
 * Big-endian throughout, which is what `DataOutputStream` writes and what every
 * other language calls network byte order.
 */
object Wire {
  /**
   * Format marker. A future version changes the digit; old apps say so.
   *
   * Five bytes rather than four because the previous version was four, and a
   * length that differs is a mismatch the reader notices immediately rather
   * than one it discovers by misparsing the next field.
   */
  val MAGIC = "BEAM3".toByteArray(Charsets.US_ASCII)

  const val STATUS_OK = 0
  const val STATUS_BAD_TOKEN = 1

  /**
   * The two apps were built from different versions of this file.
   *
   * Worth its own status rather than hanging up: the two apps ship separately
   * and a student who updated one and not the other otherwise sees a transfer
   * that fails for no stated reason. This lets the screen say "update the other
   * app", which is the only thing that will help.
   */
  const val STATUS_BAD_VERSION = 2

  /** 64 KB: comfortably above the socket buffer, far below anything worth worrying about. */
  const val CHUNK = 64 * 1024

  /** A manifest is a title, some instructions and a handful of filenames. */
  const val MAX_MANIFEST = 256 * 1024

  /** Tokens are 22 base64url characters. This is slack, not a target. */
  const val MAX_TOKEN = 256

  /** A UUID is 36 characters. Same slack, same reason. */
  const val MAX_DEVICE = 128

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
