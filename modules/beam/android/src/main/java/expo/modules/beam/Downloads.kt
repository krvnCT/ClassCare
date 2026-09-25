package expo.modules.beam

import android.content.ContentValues
import android.content.Context
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File

/**
 * Putting a received file where the student can actually find it.
 *
 * The transfer writes into app storage, and that is the right place for it to
 * live: nothing else on the phone can overwrite it, it needs no permission, and
 * it goes away when the app does. But it is invisible. A student told "send me
 * that worksheet" opens their file manager, or a chat app's attach button, and
 * app storage does not appear in either — so as far as they are concerned the
 * file they can see in this app does not exist.
 *
 * So a second copy goes into the phone's Downloads folder, under a directory
 * named after the handout. Two storage APIs, because Android changed this
 * underneath everyone:
 *
 *  - **API 29 and up**: MediaStore. The file is inserted into the Downloads
 *    collection with a relative path and the system decides where that is.
 *    No permission at all — this is the sanctioned way and the only one that
 *    works on a modern phone.
 *  - **Below that**: the public Downloads directory, written directly. Needs
 *    `WRITE_EXTERNAL_STORAGE`, which the manifest declares with
 *    `maxSdkVersion="32"` for precisely this case.
 *
 * ## Failure is not fatal here
 *
 * Every path returns null rather than throwing. The file is already on the
 * phone and already openable from inside the app; the copy is a convenience. A
 * transfer reported as failed because a *convenience* did not work would be the
 * app lying about the thing the student actually cares about.
 */
object Downloads {
  private const val TAG = "Beam"

  /**
   * Copy `source` into `Downloads/<folder>/`, and say where it went.
   *
   * `folder` is sanitised here rather than trusted: it comes from a handout
   * title, which comes from another phone, and a title containing a slash would
   * otherwise write outside the directory this is supposed to be confined to.
   */
  fun save(context: Context, source: File, name: String, mime: String, folder: String): String? {
    if (!source.exists()) return null
    val safeFolder = sanitise(folder).ifBlank { "StudentCare" }
    val safeName = sanitise(name).ifBlank { source.name }

    return runCatching {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
        viaMediaStore(context, source, safeName, mime, safeFolder)
      } else {
        viaPublicDirectory(source, safeName, safeFolder)
      }
    }.getOrElse {
      Log.w(TAG, "could not export $safeName: ${it.message}")
      null
    }
  }

  @androidx.annotation.RequiresApi(Build.VERSION_CODES.Q)
  private fun viaMediaStore(
    context: Context,
    source: File,
    name: String,
    mime: String,
    folder: String,
  ): String? {
    val relative = "${Environment.DIRECTORY_DOWNLOADS}/$folder"
    val values = ContentValues().apply {
      put(MediaStore.Downloads.DISPLAY_NAME, name)
      put(MediaStore.Downloads.MIME_TYPE, mime.ifBlank { "application/octet-stream" })
      put(MediaStore.Downloads.RELATIVE_PATH, relative)
      // Hidden from other apps until the copy is complete, so a file manager
      // cannot show a half-written worksheet as though it were finished.
      put(MediaStore.Downloads.IS_PENDING, 1)
    }

    val resolver = context.contentResolver
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values) ?: return null

    try {
      resolver.openOutputStream(uri)?.use { sink -> source.inputStream().use { it.copyTo(sink) } }
        ?: return null
    } catch (e: Exception) {
      // Leave nothing half-made behind.
      runCatching { resolver.delete(uri, null, null) }
      throw e
    }

    resolver.update(uri, ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) }, null, null)
    return "$relative/$name"
  }

  private fun viaPublicDirectory(source: File, name: String, folder: String): String? {
    val dir = File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), folder)
    if (!dir.exists() && !dir.mkdirs()) return null
    val target = unique(dir, name)
    source.inputStream().use { input -> target.outputStream().use { input.copyTo(it) } }
    return "${Environment.DIRECTORY_DOWNLOADS}/$folder/${target.name}"
  }

  /**
   * A name safe to put in a path.
   *
   * The handout title and the filenames both arrive from another phone. `/` and
   * `..` are how a name becomes a path, and the destination here is shared
   * storage — the one place on the phone where writing outside the intended
   * directory would touch somebody else's files.
   */
  private fun sanitise(raw: String): String =
    raw
      .replace(Regex("[\\\\/:*?\"<>|\\u0000-\\u001F]"), " ")
      .replace("..", " ")
      .trim()
      .trimStart('.')
      .take(80)

  /** `worksheet.pdf`, then `worksheet (2).pdf`. MediaStore does this itself. */
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
