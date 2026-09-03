/**
 * A handout: an assignment, packed small enough to live inside a QR code.
 *
 * ## Why a QR at all
 *
 * An assignment already goes out by email, and email is the thing that fails
 * here. It needs an address on file for every student, it needs the server
 * reachable at the moment of sending, and it arrives whenever it arrives. A
 * teacher standing in front of the class with the worksheet on their phone has
 * none of those problems and no way to act on it.
 *
 * A QR on the teacher's screen is the shortest path there is: they hold it up,
 * the class points their cameras at it, and every student has the work. No
 * addresses, no delivery reports, nothing to go wrong per-recipient.
 *
 * ## What is actually in the code
 *
 * Everything the teacher typed, and a link per file.
 *
 * The *words* travel inside the QR itself, so the instructions arrive with no
 * network of any kind — that is the half that matters most and the half that
 * costs nothing. The files cannot: a PDF is megabytes and a QR holds about two
 * kilobytes, so what travels for those is a signed URL each.
 *
 * That split is deliberate and it is where the honesty of this feature lives. A
 * student out of signal still gets "exercises 3 and 4, photograph your work";
 * they get the worksheet when they next have a connection.
 *
 * ## Why not the local network
 *
 * The obvious idea is to serve the files off the teacher's phone over the
 * classroom wifi, and it is the wrong one here for three separate reasons, each
 * of which is on its own fatal:
 *
 *  - There is no HTTP server for Expo. Running one means a native module and a
 *    config plugin, which is weeks of work and cannot be tested without the
 *    hardware in hand.
 *  - Most school and public access points have client isolation switched on,
 *    which blocks phone-to-phone traffic outright. The transfer would fail in
 *    exactly the room it was built for, and fail silently.
 *  - The files are already in storage. They were uploaded so the email could
 *    carry them, and signing a URL for something already uploaded costs one
 *    round trip and no new infrastructure at all.
 *
 * The format below carries a `u` per file and does not care what kind of URL it
 * is. If a local server is ever worth building, it drops in there and nothing
 * else changes.
 *
 * ## The wrapper
 *
 * The payload is wrapped in `https://api.smiletech.dev/h#…`, and the payload is
 * in the *fragment*, which browsers never send to the server. So the teacher's
 * hosting sees a request for a page and never sees the handout.
 *
 * The wrapper is what makes a plain phone camera useful: it opens a page rather
 * than showing a screenful of base64. A student app that registers the link
 * takes it first and decodes locally, without a request at all.
 */
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';

/**
 * Where a scanner with no ClassCare app on it ends up.
 *
 * The fragment carries the whole handout, so this page can render it without a
 * server, and the server it is hosted on never receives it.
 */
export const HANDOUT_URL = 'https://api.smiletech.dev/h';

/** Version marker. A future format changes the digit and old apps say so. */
const PREFIX = 'CCH1:';

/**
 * The size a code stops being worth showing to a room.
 *
 * Not the format's limit — a QR holds about 2,900 bytes — but the point past
 * which the grid gets too fine to read off a phone held up at the front. At
 * this size the code is around 110 modules square, which scans from a couple of
 * desks away. Past it the teacher gets told to send fewer files rather than
 * being handed a code that only works pressed against the lens.
 */
export const MAX_PAYLOAD_BYTES = 1200;

export type HandoutFile = {
  /** Filename as the teacher sees it, not the storage key. */
  n: string;
  /** MIME type, so the student app can offer the right opener. */
  m: string;
  /** Bytes, so a student on a metered connection knows before tapping. */
  s: number;
  /** Where to fetch it. A signed storage URL today; any URL in principle. */
  u: string;
};

export type Handout = {
  /** Format version. */
  v: 1;
  /** Assignment title — the group and subject, as the teacher named it. */
  t: string;
  /** The instructions. Travels inside the code, so it needs no network. */
  b: string;
  /** Who set it, so a scanned handout says where it came from. */
  w: string;
  /** When it was made, epoch seconds. Lets the student app sort and expire. */
  d: number;
  /** Attached files. Empty is fine: instructions on their own are a handout. */
  f: HandoutFile[];
};

/* -------------------------------------------------------------------------- */
/* Base64url                                                                  */
/* -------------------------------------------------------------------------- */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/**
 * Written out rather than reached for.
 *
 * Hermes has no `Buffer`, and `btoa` only takes a binary string — which means
 * building one character by character out of a byte array and hoping nothing in
 * it is above 0xFF. Doing the arithmetic directly is shorter than the dance and
 * cannot get that wrong.
 *
 * URL-safe alphabet and no padding, because this ends up in a URL fragment and
 * `+`, `/` and `=` all mean something else there.
 */
function toBase64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    if (b === undefined) break;
    out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c === undefined) break;
    out += B64[c & 63];
  }
  return out;
}

function fromBase64url(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9\-_]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) continue;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[n++] = (acc >> bits) & 0xff;
    }
  }
  return out.subarray(0, n);
}

/* -------------------------------------------------------------------------- */
/* Encoding                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A handout as the string that goes into the code.
 *
 * Deflated only when deflating actually helps. One file is mostly a signed URL,
 * which is a JWT and therefore already close to random — compressing it adds
 * a header and base64 adds a third on top, so the "compressed" form comes out
 * *larger* than the plain JSON. Three files are three URLs sharing a long
 * prefix and it halves them. So both are produced and the shorter wins, with
 * the marker after the prefix saying which: `z` deflated, `j` plain.
 */
export function encodeHandout(handout: Handout): string {
  const json = JSON.stringify(handout);
  const plain = `j${toBase64url(strToU8(json))}`;
  const packed = `z${toBase64url(deflateSync(strToU8(json), { level: 9 }))}`;
  return PREFIX + (packed.length < plain.length ? packed : plain);
}

/** The scannable link: the wrapper page, with the handout in the fragment. */
export const handoutLink = (handout: Handout): string =>
  `${HANDOUT_URL}#${encodeHandout(handout)}`;

/**
 * Read one back, from either the bare payload or the whole link.
 *
 * Returns null rather than throwing on anything it does not recognise. A camera
 * pointed at a shop's wifi poster produces a string, and that is not an error
 * worth a stack trace — it is simply not one of ours.
 */
export function decodeHandout(scanned: string): Handout | null {
  const hash = scanned.indexOf('#');
  const raw = (hash >= 0 ? scanned.slice(hash + 1) : scanned).trim();
  if (!raw.startsWith(PREFIX)) return null;

  const marked = raw.slice(PREFIX.length);
  const how = marked[0];
  const data = marked.slice(1);

  try {
    const bytes = fromBase64url(data);
    const json = strFromU8(how === 'z' ? inflateSync(bytes) : bytes);
    const parsed = JSON.parse(json) as Handout;
    // Shape-checked rather than trusted. This arrives off a camera, and a
    // truncated read decodes to something that parses and is missing half its
    // fields.
    if (parsed?.v !== 1 || typeof parsed.t !== 'string' || !Array.isArray(parsed.f)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** How big the code will be, for the screen that has to warn about it. */
export const handoutSize = (handout: Handout): number => handoutLink(handout).length;
