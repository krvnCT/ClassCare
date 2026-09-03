/**
 * Turning what is on the assignment screen into a handout that fits in a code.
 *
 * The screen has picked files and typed instructions; the QR needs signed URLs
 * and a payload under the size cap. This is the step between, and it is kept
 * out of both so the assignment screen does not grow a second send path and the
 * handout screen stays a pure renderer.
 */
import {
  signedAttachmentUrl,
  uploadAttachments,
  type PickedAttachment,
} from '@/lib/attachments';
import {
  encodeHandout,
  handoutSize,
  MAX_PAYLOAD_BYTES,
  type Handout,
  type HandoutFile,
} from '@/lib/handout';

/**
 * How long the file links stay good.
 *
 * A week rather than the hour `signedAttachmentUrl` defaults to. That default
 * is for a teacher opening one file they are already looking at; this is for a
 * class of students, some of whom scan the code in the room and some of whom
 * get home to a connection that evening, or the next day, or after the
 * weekend. An hour would mean the handout quietly stopped working for exactly
 * the students who most needed it to keep working.
 *
 * A week and not a year because the URL is a bearer token: anyone who
 * photographs the projected code can fetch the file for as long as it lasts.
 * For a worksheet that is an acceptable trade at seven days and a careless one
 * at three hundred.
 */
export const LINK_DAYS = 7;
const LINK_SECONDS = LINK_DAYS * 24 * 60 * 60;

/** Raised when the payload will not fit a code worth showing to a room. */
export class HandoutTooBig extends Error {
  constructor(readonly bytes: number) {
    super(`Handout is ${bytes} bytes, over the ${MAX_PAYLOAD_BYTES} cap`);
    this.name = 'HandoutTooBig';
  }
}

/**
 * Upload, sign, pack.
 *
 * Uploading is the same call the email path makes, and deliberately so: a
 * teacher who shares by QR and then also emails the assignment uploads the
 * files once, because `uploadAttachments` is given the already-picked files
 * either way and the storage paths it returns are what both routes carry.
 */
export async function buildHandout(input: {
  title: string;
  instructions: string;
  teacherName: string;
  files: PickedAttachment[];
  onProgress?: (done: number, total: number) => void;
}): Promise<{ payload: string; handout: Handout }> {
  const uploaded = await uploadAttachments(input.files, input.onProgress);

  const files: HandoutFile[] = [];
  for (const item of uploaded) {
    files.push({
      n: item.filename,
      m: item.mimeType,
      s: item.size,
      u: await signedAttachmentUrl(item.storagePath, LINK_SECONDS),
    });
  }

  const handout: Handout = {
    v: 1,
    t: input.title.trim(),
    b: input.instructions.trim(),
    w: input.teacherName.trim(),
    // Seconds, not milliseconds: three digits shorter each, and nothing here
    // needs to know which part of a second a handout was made in.
    d: Math.floor(Date.now() / 1000),
    f: files,
  };

  /*
    Checked after signing rather than before.

    The signed URLs are most of the payload and their length is not knowable
    until Supabase has issued them — a guess made from the file count would be
    wrong in both directions. The cost of finding out late is that the upload
    has already happened, which is fine: the files are in storage either way and
    the teacher can send the same assignment by email without re-picking them.
  */
  const size = handoutSize(handout);
  if (size > MAX_PAYLOAD_BYTES) throw new HandoutTooBig(size);

  return { payload: encodeHandout(handout), handout };
}
