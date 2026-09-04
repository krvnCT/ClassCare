/**
 * The QR code for a direct, offline handout.
 *
 * ## What changed and why
 *
 * The first version of this feature put a link in the code: files went up to
 * storage, each got a signed URL, and the QR carried a web address. It worked,
 * and it was the wrong shape for this app. It needed the internet at the moment
 * of sharing — on a connection that is filtered, slow and sometimes simply
 * absent — and it needed it again on every student's phone. A teacher standing
 * in front of a class cannot wait for an upload, and half the class cannot
 * fetch what the other half already has.
 *
 * So the code no longer points anywhere. It carries the assignment itself and
 * the credentials for a Wi-Fi network that exists for the next few minutes and
 * belongs to the teacher's phone. Nothing crosses the internet. Nothing is
 * stored on anyone's server. The room is the network.
 *
 * ## What is in the code
 *
 *  - The assignment: title, instructions, who set it, when.
 *  - What is coming: each file's name, type and size, so a student sees
 *    "worksheet.pdf · 2.4 MB" and decides *before* anything transfers.
 *  - How to reach the teacher: network name, password, address, port, token.
 *
 * The files themselves are not in the code and never could be — a QR holds
 * about two kilobytes and a PDF is a thousand times that. They come over the
 * socket. But the *words* are in the code, which means a student who scans and
 * then walks out of range still has the instructions.
 *
 * ## Why the token
 *
 * The Wi-Fi password protects the link; the token protects the transfer. They
 * are different jobs. A password is on screen in front of thirty people and
 * will be photographed, and a Wi-Fi Direct group's name and password are
 * reused by Android across sessions on some builds. The token is fresh for
 * every share, so yesterday's photograph of yesterday's code cannot pull
 * today's files even if the network details happen to match.
 *
 * It is not a defence against a student in the room, and it is not meant to be.
 * Anyone who can see the projected code is someone the teacher is showing it
 * to.
 *
 * ## Not a URL
 *
 * A bare `CCB1:` string, not `https://…#CCB1:`. There is nothing on the far
 * side of a link to reach — the whole point is that no server is involved — so
 * dressing it up as a web address would promise something it cannot do. A plain
 * camera shows the student a line of gibberish, which is honest: this code is
 * for the app, and the app is what they need.
 */
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';

import { fromBase64url, toBase64url } from '@/lib/base64url';

/** Version marker. A future format changes the digit and old apps say so. */
const PREFIX = 'CCB1:';

/**
 * The size a code stops being worth showing to a room.
 *
 * Not the format's limit — a QR holds about 2,900 bytes — but the point past
 * which the grid gets too fine to read off a phone held up at the front.
 *
 * There is far more headroom here than the link version had. That one spent
 * most of its budget on signed URLs, which are JWTs and run to a couple of
 * hundred characters each; this one spends about ninety on the whole network
 * handshake regardless of how many files there are. A five-file handout with
 * long instructions lands comfortably inside this.
 */
export const MAX_PAYLOAD_BYTES = 1200;

export type BeamFile = {
  /** Filename as the teacher sees it. */
  n: string;
  /** MIME type, so the student app can offer the right opener. */
  m: string;
  /** Bytes, so the student knows what is coming before accepting it. */
  s: number;
};

/**
 * The half of the payload that describes the work rather than the network.
 *
 * Split out because it is the half that has a life beyond this transfer: it is
 * what the sender serves as a manifest, and what the receiver keeps once the
 * Wi-Fi group it arrived over has been forgotten.
 */
export type BeamAssignment = {
  /** Format version. */
  v: 1;
  /** Assignment title — the groups it is for, as the teacher named them. */
  t: string;
  /** The instructions. Travels inside the code, so it survives losing the link. */
  b: string;
  /** Who set it. */
  w: string;
  /** When it was made, epoch seconds. Lets the student app sort and expire. */
  d: number;
  /** What is coming. Empty is fine: instructions on their own are a handout. */
  f: BeamFile[];
};

export type BeamPayload = BeamAssignment & {
  /** Wi-Fi network name of the teacher's group. Absent on a shared LAN. */
  n?: string;
  /** Its WPA2 password. Absent on a shared LAN. */
  q?: string;
  /** The teacher's address on that network. */
  h: string;
  /** The port the teacher's phone is listening on. */
  o: number;
  /** One-use secret. See the note above on why this is separate from `q`. */
  k: string;
};

/**
 * A fresh token.
 *
 * `Math.random` rather than `expo-crypto`, deliberately: this is not a secret
 * that has to withstand an attacker with the code in hand, it is a nonce that
 * has to differ from the last one. `expo-crypto` would make this async for no
 * gain in the only property that matters here.
 */
export function beamToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 22; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

/**
 * The payload as the string that goes into the code.
 *
 * Deflated only when deflating actually helps. Instructions in Turkmen or
 * Russian compress well; a short handout with no body is mostly the token and
 * the passphrase, both of which are close to random, and the "compressed" form
 * comes out larger. Both are produced and the shorter wins, with the marker
 * after the prefix saying which: `z` deflated, `j` plain.
 */
export function encodeBeam(payload: BeamPayload): string {
  const json = JSON.stringify(payload);
  const plain = `j${toBase64url(strToU8(json))}`;
  const packed = `z${toBase64url(deflateSync(strToU8(json), { level: 9 }))}`;
  return PREFIX + (packed.length < plain.length ? packed : plain);
}

/**
 * Read one back.
 *
 * Returns null rather than throwing on anything it does not recognise. A camera
 * pointed at a shop's wifi poster produces a string, and that is not an error
 * worth a stack trace — it is simply not one of ours.
 */
export function decodeBeam(scanned: string): BeamPayload | null {
  const raw = scanned.trim();
  if (!raw.startsWith(PREFIX)) return null;

  const marked = raw.slice(PREFIX.length);
  const how = marked[0];
  const data = marked.slice(1);

  try {
    const bytes = fromBase64url(data);
    const json = strFromU8(how === 'z' ? inflateSync(bytes) : bytes);
    const parsed = JSON.parse(json) as BeamPayload;
    // Shape-checked rather than trusted. This arrives off a camera, and a
    // truncated read decodes to something that parses and is missing half its
    // fields — including, here, the port to connect to.
    if (parsed?.v !== 1) return null;
    if (typeof parsed.t !== 'string' || !Array.isArray(parsed.f)) return null;
    if (typeof parsed.h !== 'string' || typeof parsed.k !== 'string') return null;
    if (typeof parsed.o !== 'number' || parsed.o <= 0 || parsed.o > 65535) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The manifest the sender serves over the socket.
 *
 * The same object minus the network details, because by the time a student is
 * reading this they are already connected and repeating the password to them
 * over the link it protects would be silly. Keeping it a subset means the
 * receiver can hold one type for "an assignment I have been given", whether it
 * came off the code or off the wire.
 */
export function beamManifest(assignment: BeamAssignment): string {
  const { v, t, b, w, d, f } = assignment;
  return JSON.stringify({ v, t, b, w, d, f });
}

/** How big the code will be, for the screen that has to warn about it. */
export const beamSize = (payload: BeamPayload): number => encodeBeam(payload).length;
