/**
 * Base64url, written out rather than reached for.
 *
 * Hermes has no `Buffer`, and `btoa` only takes a binary string — which means
 * building one character by character out of a byte array and hoping nothing in
 * it is above 0xFF. Doing the arithmetic directly is shorter than the dance and
 * cannot get that wrong.
 *
 * URL-safe alphabet and no padding. The QR payloads this serves are pure ASCII
 * as a result, which is what lets the code be generated in byte mode with no
 * encoding declaration and read by any scanner.
 */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function toBase64url(bytes: Uint8Array): string {
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

export function fromBase64url(text: string): Uint8Array {
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
