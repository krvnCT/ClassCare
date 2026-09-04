#!/usr/bin/env node
/**
 * A laptop that can pretend to be either end of a beam transfer.
 *
 * ## Why this exists
 *
 * Testing the classroom handout properly needs two Android phones in the same
 * room, and until both apps are installed on both phones there is no way to
 * find out whether any of it works. That is a long time to go without a signal.
 *
 * This speaks the same wire protocol, so a laptop stands in for the missing
 * phone and each side can be tested on its own:
 *
 *   node tools/beam.js pull <host> <port> <token> [dir]
 *       Acts as a student. Point it at ClassCare after tapping the QR button
 *       and it will pull the assignment down. Tests the whole teacher side —
 *       Wi-Fi Direct group, socket server, manifest, file streaming — with one
 *       phone and no StudentCare at all.
 *
 *   node tools/beam.js serve [file...]
 *       Acts as a teacher. Prints a CCB1 payload; turn it into a QR with
 *       `node tools/beam.js qr <payload>` and scan it with StudentCare. Tests
 *       the whole student side with one phone and no ClassCare.
 *
 *   node tools/beam.js selftest
 *       Runs both halves against each other, here, in a second. Proves the
 *       protocol round-trips before either phone is involved.
 *
 * ## How to reach the phone
 *
 * For `pull`, the laptop has to be on the teacher's Wi-Fi Direct group. Join it
 * like any other network: the SSID is `DIRECT-xx-Android...` and the password
 * is in the QR — run `node tools/beam.js read <payload>` to print both. Then
 * the host is almost always 192.168.49.1.
 *
 * For `serve`, put the laptop and the phone on the same ordinary Wi-Fi and let
 * the payload carry no SSID; StudentCare skips the join and goes straight to
 * the socket. This is the one case where the app talks over a normal network,
 * and it exists for exactly this reason.
 *
 * ## Keeping it honest
 *
 * The framing below is written from `modules/beam/.../Wire.kt` and has to stay
 * in step with it. `selftest` only proves this file agrees with itself; it is
 * `pull` and `serve`, against a real phone, that prove it agrees with the
 * Kotlin. Run those before believing any of it.
 */
'use strict';

const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');

/* ------------------------------------------------------------------ Wire */

const MAGIC = Buffer.from('CCB1', 'ascii');
const STATUS_OK = 0;
const STATUS_BAD_TOKEN = 1;
const MAX_MANIFEST = 256 * 1024;
const MAX_TOKEN = 256;
const MAX_FILE = 64n * 1024n * 1024n;

/**
 * Read exactly `n` bytes, or reject.
 *
 * A socket hands over whatever has arrived, which for a 10 MB file is hundreds
 * of chunks. Every read in this protocol is a fixed size decided by the bytes
 * before it, so anything that reads "what turned up" desynchronises the stream
 * and the failure surfaces several files later as nonsense.
 */
function readExactly(socket, n) {
  return new Promise((resolve, reject) => {
    if (n === 0) return resolve(Buffer.alloc(0));
    const parts = [];
    let got = 0;

    const onReadable = () => {
      let chunk;
      while ((chunk = socket.read(Math.min(n - got, 65536))) !== null) {
        parts.push(chunk);
        got += chunk.length;
        if (got >= n) {
          cleanup();
          return resolve(Buffer.concat(parts, n));
        }
      }
    };
    const onEnd = () => {
      cleanup();
      reject(new Error(`Connection closed with ${n - got} of ${n} bytes to go`));
    };
    const onError = (e) => {
      cleanup();
      reject(e);
    };
    function cleanup() {
      socket.off('readable', onReadable);
      socket.off('end', onEnd);
      socket.off('error', onError);
    }

    socket.on('readable', onReadable);
    socket.on('end', onEnd);
    socket.on('error', onError);
    onReadable();
  });
}

const writeText = (socket, text) => {
  const bytes = Buffer.from(text, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  socket.write(len);
  socket.write(bytes);
};

async function readText(socket, cap) {
  const size = (await readExactly(socket, 4)).readInt32BE();
  if (size < 0 || size > cap) throw new Error(`Bad length ${size}, cap is ${cap}`);
  return (await readExactly(socket, size)).toString('utf8');
}

/* ------------------------------------------------------- Student: pull */

async function pull(host, port, token, into) {
  fs.mkdirSync(into, { recursive: true });
  const socket = net.createConnection({ host, port: Number(port) });
  socket.setNoDelay(true);

  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
    socket.setTimeout(15000, () => reject(new Error(`No answer from ${host}:${port}`)));
  });
  socket.setTimeout(0);
  console.log(`connected to ${host}:${port}`);

  socket.write(MAGIC);
  writeText(socket, token);

  const status = (await readExactly(socket, 1)).readUInt8();
  if (status === STATUS_BAD_TOKEN) throw new Error('Rejected: wrong token');
  if (status !== STATUS_OK) throw new Error(`Unexpected status ${status}`);

  const manifestJson = await readText(socket, MAX_MANIFEST);
  const manifest = JSON.parse(manifestJson);
  console.log('\nmanifest:');
  console.log(`  title       ${manifest.t}`);
  console.log(`  from        ${manifest.w}`);
  console.log(`  instructions ${JSON.stringify(manifest.b)}`);
  console.log(`  files       ${manifest.f.length}`);

  const files = manifest.f ?? [];
  for (let i = 0; i < files.length; i++) {
    const size = (await readExactly(socket, 8)).readBigUInt64BE();
    if (size > MAX_FILE) throw new Error(`Bad file size ${size}`);

    const name = safeName(files[i].n, i);
    const target = path.join(into, name);
    const handle = fs.openSync(target, 'w');
    let got = 0n;
    try {
      while (got < size) {
        const want = Number(size - got > 65536n ? 65536n : size - got);
        const chunk = await readExactly(socket, want);
        fs.writeSync(handle, chunk);
        got += BigInt(chunk.length);
      }
    } finally {
      fs.closeSync(handle);
    }
    // The declared size is what the sender measured; the count is what arrived.
    // They must agree, and saying so here is what makes this a test rather than
    // a download.
    const actual = BigInt(fs.statSync(target).size);
    const ok = actual === size ? 'ok' : `MISMATCH declared ${size}`;
    console.log(`  ${name}  ${actual} bytes  ${ok}`);
  }

  socket.end();
  console.log(`\npulled into ${into}`);
}

const safeName = (raw, i) =>
  String(raw ?? '')
    .replace(/\\/g, '_')
    .split('/')
    .pop()
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, '')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120) || `file-${i + 1}`;

/* ------------------------------------------------------- Teacher: serve */

function serve(filePaths, { token, quiet } = {}) {
  const files = filePaths.map((p) => ({
    path: p,
    name: path.basename(p),
    size: fs.statSync(p).size,
  }));

  const manifest = {
    v: 1,
    t: 'Test handout',
    b: 'Sent by tools/beam.js. Öýe iş: 3-nji gönükme. 👋',
    w: 'beam.js',
    d: Math.floor(Date.now() / 1000),
    f: files.map((f) => ({ n: f.name, m: 'application/octet-stream', s: f.size })),
  };

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    handle(socket).catch((e) => {
      if (!quiet) console.error('  client failed:', e.message);
      socket.destroy();
    });
  });

  async function handle(socket) {
    const magic = await readExactly(socket, 4);
    if (!magic.equals(MAGIC)) throw new Error(`Not our protocol: ${magic.toString('hex')}`);

    const offered = await readText(socket, MAX_TOKEN);
    if (offered !== token) {
      socket.write(Buffer.from([STATUS_BAD_TOKEN]));
      socket.end();
      if (!quiet) console.log('  rejected a wrong token');
      return;
    }

    socket.write(Buffer.from([STATUS_OK]));
    writeText(socket, JSON.stringify(manifest));
    if (!quiet) console.log(`  serving ${files.length} file(s) to ${socket.remoteAddress}`);

    for (const file of files) {
      const size = Buffer.alloc(8);
      size.writeBigUInt64BE(BigInt(file.size));
      socket.write(size);
      await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(file.path);
        stream.on('error', reject);
        stream.on('end', resolve);
        stream.pipe(socket, { end: false });
      });
    }
    socket.end();
    if (!quiet) console.log('  done');
  }

  return new Promise((resolve) => {
    server.listen(0, '0.0.0.0', () => resolve({ server, port: server.address().port, manifest }));
  });
}

/* --------------------------------------------------------------- Payload */

/**
 * The QR payload, built here rather than imported.
 *
 * `src/lib/beam.ts` is TypeScript with a path alias, and requiring it from a
 * plain node script means a bundler in the loop. What it does is base64url over
 * deflate, which is two lines of `zlib`, and having the second implementation
 * is worth more than the shared one: if these two ever disagree, one of them is
 * wrong and the disagreement is the finding.
 */
function encodePayload(obj) {
  const zlib = require('node:zlib');
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const plain = 'j' + b64url(json);
  // `deflateRawSync`: fflate's `deflateSync` emits raw DEFLATE with no zlib
  // header, and the app's decoder expects exactly that.
  const packed = 'z' + b64url(zlib.deflateRawSync(json, { level: 9 }));
  return 'CCB1:' + (packed.length < plain.length ? packed : plain);
}

function decodePayload(text) {
  const zlib = require('node:zlib');
  const raw = text.trim();
  if (!raw.startsWith('CCB1:')) return null;
  const marked = raw.slice(5);
  const buf = Buffer.from(marked.slice(1).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const json = marked[0] === 'z' ? zlib.inflateRawSync(buf) : buf;
  return JSON.parse(json.toString('utf8'));
}

/* ------------------------------------------------------------- Self test */

async function selftest() {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beam-'));
  const sent = path.join(dir, 'sent');
  const got = path.join(dir, 'got');
  fs.mkdirSync(sent);

  // Sizes chosen to land on both sides of the 64 KB chunk boundary, plus an
  // empty file — the case where a naive reader waits forever for bytes that
  // were never coming.
  const cases = [
    ['empty.txt', 0],
    ['small.txt', 11],
    ['exact.bin', 65536],
    ['over.bin', 65536 + 1],
    ['big.bin', 3 * 1024 * 1024 + 7],
  ];
  for (const [name, size] of cases) {
    const buf = Buffer.alloc(size);
    for (let i = 0; i < size; i++) buf[i] = (i * 31 + 7) & 0xff;
    fs.writeFileSync(path.join(sent, name), buf);
  }

  const token = 'SelfTestToken000000000';
  const { server, port } = await serve(
    cases.map(([n]) => path.join(sent, n)),
    { token, quiet: true },
  );

  let failures = 0;
  const check = (label, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
    if (!ok) failures++;
  };

  console.log('transfer:');
  await pullQuiet('127.0.0.1', port, token, got);
  for (const [name, size] of cases) {
    const a = fs.readFileSync(path.join(sent, name));
    const b = fs.existsSync(path.join(got, name)) ? fs.readFileSync(path.join(got, name)) : null;
    check(`${name} (${size} bytes)`, b !== null && a.equals(b), b === null ? 'not received' : b.length !== size ? `got ${b.length}` : '');
  }

  console.log('token:');
  let rejected = false;
  try {
    await pullQuiet('127.0.0.1', port, 'WrongToken0000000000000', path.join(dir, 'nope'));
  } catch (e) {
    rejected = /wrong token/i.test(e.message);
  }
  check('a wrong token is refused', rejected);

  console.log('payload:');
  const payload = {
    v: 1,
    t: 'Informatika A2',
    b: 'Öýe iş 👋',
    w: 'Kerwen',
    d: 1788500000,
    f: [{ n: 'a.pdf', m: 'application/pdf', s: 2411000 }],
    n: 'DIRECT-4a-Android_9f2c',
    q: 'p8Kq3xTz',
    h: '192.168.49.1',
    o: 41237,
    k: token,
  };
  const encoded = encodePayload(payload);
  check('round-trips', JSON.stringify(decodePayload(encoded)) === JSON.stringify(payload));
  check('is pure ASCII', /^[\x20-\x7e]*$/.test(encoded), `${encoded.length} bytes`);
  check('rejects a foreign code', decodePayload('WIFI:S:Cafe;T:WPA;P:x;;') === null);

  server.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

async function pullQuiet(host, port, token, into) {
  const log = console.log;
  console.log = () => {};
  try {
    await pull(host, port, token, into);
  } finally {
    console.log = log;
  }
}

/* ------------------------------------------------------------------ CLI */

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'pull') {
    const [host, port, token, into = './pulled'] = rest;
    if (!host || !port || !token) return usage();
    return pull(host, port, token, into);
  }

  if (cmd === 'serve') {
    if (!rest.length) return usage();
    const token = 'LaptopServeToken000000';
    const { port, manifest } = await serve(rest, { token });
    const nets = require('node:os').networkInterfaces();
    const addresses = Object.values(nets)
      .flat()
      .filter((n) => n && n.family === 'IPv4' && !n.internal)
      .map((n) => n.address);

    console.log(`listening on port ${port}`);
    console.log(`addresses: ${addresses.join(', ') || 'none — is wifi on?'}\n`);
    for (const host of addresses) {
      console.log(`payload for ${host}:`);
      console.log(encodePayload({ ...manifest, h: host, o: port, k: token }));
      console.log();
    }
    console.log('Turn one of those into a QR (any generator, or an online one)');
    console.log('and scan it with StudentCare. No SSID in it, so the app skips');
    console.log('the Wi-Fi join and goes straight to this socket — put the phone');
    console.log('on the same network as this laptop.');
    return;
  }

  if (cmd === 'read') {
    const decoded = decodePayload(rest.join(' '));
    if (!decoded) return console.error('Not a CCB1 payload');
    console.log(JSON.stringify(decoded, null, 2));
    if (decoded.n) {
      console.log(`\njoin wifi "${decoded.n}" password "${decoded.q}"`);
      console.log(`then: node tools/beam.js pull ${decoded.h} ${decoded.o} ${decoded.k}`);
    }
    return;
  }

  if (cmd === 'selftest') return selftest();
  return usage();
}

function usage() {
  console.log(`
  node tools/beam.js selftest
      Run both halves against each other. No phone needed.

  node tools/beam.js read <payload>
      Decode a CCB1 payload and print how to connect to it.

  node tools/beam.js pull <host> <port> <token> [dir]
      Act as a student against a real ClassCare. Join the teacher's
      Wi-Fi Direct group first — 'read' prints the name and password.

  node tools/beam.js serve <file...>
      Act as a teacher for a real StudentCare. Prints a payload to
      turn into a QR. Put the phone on this laptop's network.
`);
  process.exitCode = 1;
}

main().catch((e) => {
  console.error(String(e.message ?? e));
  process.exit(1);
});
