/**
 * Handing files to the room, with no internet involved.
 *
 * The wrapper around the `beam` native module, in the same shape as
 * `deviceSms.ts`: the module itself is Android-only and absent from any build
 * made before it existed, so exactly one file deals with that and everything
 * else can assume it works.
 *
 * ## What actually happens
 *
 * The teacher's phone creates a Wi-Fi Direct group — a real WPA2 access point,
 * needing no router, no internet and nobody's permission — and starts a socket
 * server on it. The QR carries the network name, its password, the port, and a
 * fresh token. A student's phone reads that, joins the network, and pulls the
 * files straight off the teacher's phone.
 *
 * Nothing is uploaded. Nothing is stored on a server. Nothing crosses the
 * border. In a country where the connection is filtered and often absent, that
 * is the whole point: this works in a classroom with the mobile data switched
 * off.
 *
 * ## The receiving half is here too
 *
 * `receive` is what StudentCare calls, and it lives in this repo because the
 * protocol is the contract between the two apps and a contract maintained in
 * two places drifts. Copy `modules/beam` and this file across; do not rewrite
 * the other end from the documentation.
 */
import { Platform } from 'react-native';

import Beam from '../../modules/beam/src/BeamModule';
import type { BeamPeerEvent, BeamProgressEvent } from '../../modules/beam/src/Beam.types';
import { beamManifest, encodeBeam, MAX_PAYLOAD_BYTES, type BeamAssignment, type BeamPayload } from '@/lib/beam';

export type { BeamPeerEvent, BeamProgressEvent };

/** A file to hand over, as the picker described it. */
export type BeamOutgoing = { uri: string; name: string; mime: string; size: number };

/** Why sharing cannot start. Keys into the `beam.*` strings. */
export type BeamBlocker = 'needsRebuild' | 'unsupported' | 'permission';

/**
 * Whether this build and this phone can share at all.
 *
 * Three distinct answers, because the fix is different for each and "sharing
 * is unavailable" tells the teacher nothing. `needsRebuild` is an APK from
 * before the feature existed — reinstall. `unsupported` is a tablet with no
 * Wi-Fi Direct radio — nothing to be done. `permission` is a prompt they said
 * no to — ask again.
 */
export function beamBlocker(): Exclude<BeamBlocker, 'permission'> | null {
  if (Platform.OS !== 'android' || !Beam) return 'needsRebuild';
  return Beam.isAvailable() ? null : 'unsupported';
}

/** Thrown when the assignment will not fit in a readable code. */
export class BeamTooBig extends Error {
  constructor() {
    super('Handout is too large for a QR code');
    this.name = 'BeamTooBig';
  }
}

/** Thrown when the teacher declined the Wi-Fi permission. */
export class BeamNotPermitted extends Error {
  constructor() {
    super('Permission to use Wi-Fi Direct was not granted');
    this.name = 'BeamNotPermitted';
  }
}

/**
 * Start the access point and the server; return the code to hold up.
 *
 * The manifest served over the socket is the assignment *without* the network
 * details. By the time a student reads it they are already connected, and
 * repeating the Wi-Fi password over the link it protects would be silly.
 */
export async function startBeam(
  assignment: BeamAssignment,
  files: BeamOutgoing[],
  token: string,
): Promise<{ payload: string; ssid: string; passphrase: string }> {
  if (!Beam) throw new Error('Beam is not available in this build');

  const permission = await Beam.requestPermissionsAsync();
  if (!permission.granted) throw new BeamNotPermitted();

  const group = await Beam.startHostAsync(
    beamManifest(assignment),
    files.map((f) => ({ uri: f.uri, name: f.name, mime: f.mime })),
    token,
  );

  const full: BeamPayload = {
    ...assignment,
    n: group.ssid,
    q: group.passphrase,
    h: group.host,
    o: group.port,
    k: token,
  };
  const payload = encodeBeam(full);

  // Checked after starting rather than before, because the network name and
  // password are part of what has to fit and neither is knowable until Android
  // has brought the group up.
  if (payload.length > MAX_PAYLOAD_BYTES) {
    await stopBeam();
    throw new BeamTooBig();
  }

  return { payload, ssid: group.ssid, passphrase: group.passphrase };
}

/**
 * Take the access point down.
 *
 * Safe to call when nothing is running, and safe to call twice — which matters,
 * because it is called from a cleanup function that can run after a failed
 * start.
 */
export async function stopBeam(): Promise<void> {
  try {
    await Beam?.stopHostAsync();
  } catch {
    // Nothing useful to do. The screen is going away either way, and an error
    // here means the group was already gone.
  }
}

/** Watch students arrive. Returns the unsubscribe. */
export function onBeamPeer(handler: (event: BeamPeerEvent) => void): () => void {
  if (!Beam) return () => {};
  const sub = Beam.addListener('onBeamPeer', handler);
  return () => sub.remove();
}

/* -------------------------------------------------------------------------- */
/* The receiving half — for StudentCare                                       */
/* -------------------------------------------------------------------------- */

/** Watch a file land. Returns the unsubscribe. */
export function onBeamProgress(handler: (event: BeamProgressEvent) => void): () => void {
  if (!Beam) return () => {};
  const sub = Beam.addListener('onBeamProgress', handler);
  return () => sub.remove();
}

/**
 * Join the teacher's group and pull everything down.
 *
 * `payload` is what came off the camera. `directory` is where the files land —
 * app storage, not the shared Downloads folder, so a handout cannot be
 * overwritten by anything else on the phone and goes away when the app does.
 */
export async function receiveBeam(
  payload: BeamPayload,
  directory: string,
): Promise<{ manifest: string; files: { path: string; name: string; size: number }[] }> {
  if (!Beam) throw new Error('Beam is not available in this build');

  const permission = await Beam.requestPermissionsAsync();
  if (!permission.granted) throw new BeamNotPermitted();

  return Beam.receiveAsync({
    ssid: payload.n,
    passphrase: payload.q,
    host: payload.h,
    port: payload.o,
    token: payload.k,
    directory,
  });
}

/**
 * False below Android 10, where no app may join a named network on its own.
 *
 * The student has to type the name and password into Settings once. Worth
 * knowing *before* showing them a code that will fail, which is why this is a
 * question the UI can ask rather than an error it discovers.
 */
export const canJoinAutomatically = (): boolean => Beam?.canJoinAutomatically() ?? false;
