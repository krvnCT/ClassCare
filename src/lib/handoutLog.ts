/**
 * The handouts this phone has given out over Wi-Fi.
 *
 * ## Why a file of its own rather than the message log
 *
 * Everything else in the Messages screen came back from the server: a row
 * exists because an Edge Function sent something and wrote it down. A QR
 * handout never touches a server — that is the entire point of it — so there
 * is nothing to come back, and the assignments tab showed a teacher nothing
 * for work they had definitely handed out.
 *
 * So this phone writes it down itself. A JSON file rather than a table for the
 * same reason StudentCare's library is one: it is a short list, always read
 * whole, always in the same order, and a schema plus migrations would be more
 * moving parts than the thing they move.
 *
 * ## What it is not
 *
 * It is not a delivery record. It says what was offered and how many phones
 * had taken it when the teacher closed the screen — nothing arrives later to
 * correct that, because there is no server to hear from. A count of zero means
 * nobody had scanned yet, not that nobody ever did.
 */
import { Directory, File, Paths } from 'expo-file-system';

/** One handout, as it was shared. */
export type SharedHandout = {
  /** Minted here. The teacher's own timestamp plus a counter is enough. */
  id: string;
  title: string;
  body: string;
  /** Epoch milliseconds, when the sharing screen was opened. */
  sharedAt: number;
  /**
   * The files, with where this phone kept its own copy.
   *
   * `uri` is what makes a handout re-shareable: the teacher taps last week's
   * worksheet and it goes out again without hunting through storage for it.
   * Absent on records written before the copies were kept — those re-open with
   * their instructions and no files, which is honest about what survived.
   */
  files: { name: string; size: number; uri?: string; mime?: string }[];
  /** Phones that had the whole handout when the screen closed. */
  received: number;
};

/** Shared with `stageForHandout`, which writes each handout's files in here. */
const ROOT = new Directory(Paths.document, 'handouts-sent');
const INDEX = new File(ROOT, 'index.json');

/** Newest first. Never throws — see `readLibrary` in StudentCare. */
export function readHandoutLog(): SharedHandout[] {
  try {
    if (!INDEX.exists) return [];
    const parsed = JSON.parse(INDEX.textSync()) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as SharedHandout[])
      .filter((h) => h && typeof h.id === 'string' && Array.isArray(h.files))
      .sort((a, b) => b.sharedAt - a.sharedAt);
  } catch {
    // A corrupt file means an empty history, which is recoverable. Throwing
    // here means a Messages tab that will not open, which is not.
    return [];
  }
}

function write(list: SharedHandout[]): void {
  ROOT.create({ intermediates: true, idempotent: true });
  const scratch = new File(ROOT, 'index.json.tmp');
  scratch.create({ overwrite: true });
  scratch.write(JSON.stringify(list));
  // `moveSync`, not `move`: the caller navigates immediately and would
  // otherwise re-read the index while the rename was still in flight.
  scratch.moveSync(INDEX, { overwrite: true });
}

/**
 * Record a handout, or update the one already recorded.
 *
 * Called twice for one share — once when the code goes up, and again with the
 * count as the teacher leaves. Keyed on the id so the second call corrects the
 * first rather than making a second row for the same worksheet.
 *
 * Capped, because this is a convenience rather than an archive and a teacher
 * who has been using the app for a year should not be carrying every worksheet
 * they have ever projected.
 */
export function recordHandout(handout: SharedHandout): void {
  const rest = readHandoutLog().filter((h) => h.id !== handout.id);
  write([handout, ...rest].slice(0, 200));
}

/**
 * Forget a handout, and throw away the copies kept for re-sharing.
 *
 * The files go with the record. They exist only so the history can hand the
 * same worksheet out again, so a record nobody kept is a folder nobody wants —
 * and on a phone with no space to spare, a term of them adds up.
 */
export function deleteHandout(id: string): void {
  write(readHandoutLog().filter((h) => h.id !== id));
  const dir = new Directory(ROOT, id);
  if (dir.exists) dir.delete();
}
