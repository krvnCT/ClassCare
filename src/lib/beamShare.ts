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
 * The teacher's phone starts a socket server and shows a QR describing how to
 * reach it. Which network that is over is decided at the moment of sharing, and
 * there are three answers — see the native `route`:
 *
 *  - **The teacher's hotspot**, if it is already on. The class is on it, so the
 *    code carries only an address and a token. Nothing to join, nothing to
 *    permit, and this used to be the case the app refused outright.
 *  - **A Wi-Fi Direct group** of its own: a real WPA2 access point needing no
 *    router, no internet and nobody's permission. Here the code carries the
 *    network name and password too, and the student's phone joins on its own.
 *  - **The Wi-Fi they are both on**, last, because plenty of school access
 *    points block phone-to-phone traffic and do it silently.
 *
 * In every case the files come straight off the teacher's phone.
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
import type {
  BeamHostStatus,
  BeamNotifyText,
  BeamPeerEvent,
  BeamProgressEvent,
  BeamRoute,
} from '../../modules/beam/src/Beam.types';
import { beamManifest, encodeBeam, MAX_PAYLOAD_BYTES, type BeamAssignment, type BeamPayload } from '@/lib/beam';

export type { BeamHostStatus, BeamNotifyText, BeamPeerEvent, BeamProgressEvent, BeamRoute };

/** A file to hand over, as the picker described it. */
export type BeamOutgoing = { uri: string; name: string; mime: string; size: number };

/** Why sharing cannot start. Keys into the `beam.*` strings. */
export type BeamBlocker =
  | 'needsRebuild'
  | 'unsupported'
  | 'permission'
  | 'wifiOff'
  | 'locationOff';

/**
 * Whether this build and this phone can share at all.
 *
 * Distinct answers, because the fix is different for each and "sharing is
 * unavailable" tells the teacher nothing. `needsRebuild` is an APK from before
 * the feature existed — reinstall. `unsupported` is a phone with no Wi-Fi
 * Direct radio and no network to fall back on. `permission` is a prompt they
 * said no to — ask again.
 *
 * A running hotspot used to be on this list and is not any more. It is a
 * network, the class is already on it, and the app serves over it — see
 * `beamRoute`.
 */
export function beamBlocker(): Exclude<BeamBlocker, 'permission'> | null {
  if (Platform.OS !== 'android' || !Beam) return 'needsRebuild';

  /*
    Asked of the native side first, and `isAvailable` only as a fallback.

    The order matters and used to be the other way round. `isAvailable` reports
    one thing — whether this phone has a Wi-Fi Direct radio — and a phone
    without one can still hand a worksheet over its own hotspot or the room's
    Wi-Fi. Checking it first greyed the button on a tablet that would have
    worked.
  */
  const blocker = Beam.blocker?.();
  if (blocker !== undefined) return blocker;
  // A build from before the ladder. Its only route was the group.
  return Beam.isAvailable() ? null : 'unsupported';
}

/**
 * How the next share would reach the class, or null when nothing would.
 *
 * Asked before opening the sharing screen, because it changes what the teacher
 * has to tell the room: on the direct route the code carries a network to
 * join, and on the other two the students are already somewhere the teacher's
 * phone can be reached.
 */
export function beamRoute(): BeamRoute | null {
  if (Platform.OS !== 'android' || !Beam) return null;
  // A build from before the ladder existed has no `route`, and the group was
  // the only thing it could do. Say so rather than refusing to share on it.
  if (!Beam.route) return 'direct';
  return Beam.route();
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
 * A setting the teacher has to change, and which screen changes it.
 *
 * Carried on the error rather than worked out at the call site, because the
 * only place that knows Location Services is what failed is the place that
 * checked it.
 */
export class BeamSettingOff extends Error {
  constructor(readonly setting: SettingOff) {
    super(`${setting} — the teacher has to switch this on`);
    this.name = 'BeamSettingOff';
  }
}

/** A blocker the teacher fixes with a switch, rather than by giving up. */
export type SettingOff = 'wifiOff' | 'locationOff';

/** Which Android settings screen fixes it. */
export const SETTINGS_INTENT: Record<SettingOff, string> = {
  wifiOff: 'android.settings.WIFI_SETTINGS',
  locationOff: 'android.settings.LOCATION_SOURCE_SETTINGS',
};

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
  /** The notification's words, in the teacher's language. */
  notify: BeamNotifyText,
): Promise<{ payload: string; ssid: string; passphrase: string; route: BeamRoute }> {
  if (!Beam) throw new Error('Beam is not available in this build');

  const route = beamRoute();
  if (route === null) {
    const setting = Beam.blocker?.();
    if (setting === 'wifiOff' || setting === 'locationOff') throw new BeamSettingOff(setting);
    throw new Error('No way to reach the class from this phone');
  }

  /*
    Asked for only where it is needed.

    Bringing up a Wi-Fi Direct group is what Android gates behind the nearby-
    devices permission. Serving over a hotspot that is already running, or over
    the Wi-Fi the phone is already on, is an ordinary socket on an ordinary
    network — so a teacher taking either of those routes is never shown a
    permission dialog, which is right, because there is nothing to permit.
  */
  if (route === 'direct') {
    const permission = await Beam.requestPermissionsAsync();
    if (!permission.granted) throw new BeamNotPermitted();
  }

  /*
    Asked, never required. Sharing keeps running when the teacher leaves the
    app, and on Android 13 and up the notification that says so — and holds
    the Stop button — is only shown with this. Refusing it costs the teacher
    the notification, not the transfer.
  */
  await Beam.requestNotificationsAsync?.().catch(() => null);

  const group = await Beam.startHostAsync(
    beamManifest(assignment),
    files.map((f) => ({ uri: f.uri, name: f.name, mime: f.mime })),
    token,
    notify,
  );

  const full: BeamPayload = {
    ...assignment,
    // Omitted off the direct route rather than sent empty: an absent network
    // name is what tells the student's phone "you are already where you need
    // to be", and it is also the difference between a code that fits and one
    // that does not.
    ...(group.ssid ? { n: group.ssid } : null),
    ...(group.passphrase ? { q: group.passphrase } : null),
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

  return {
    payload,
    ssid: group.ssid,
    passphrase: group.passphrase,
    route: group.route,
  };
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

/**
 * Hear about the teacher pressing Stop on the notification.
 *
 * The screen did not ask for that, so without this it would go on holding up
 * a code nothing answers. Returns the unsubscribe.
 */
export function onBeamHostStopped(handler: (event: { received: number }) => void): () => void {
  if (!Beam?.hostStatus) return () => {};
  const sub = Beam.addListener('onBeamHostStopped', handler);
  return () => sub.remove();
}

/** The share still running in the background, or null. */
export const beamHostStatus = (): BeamHostStatus | null => Beam?.hostStatus?.() ?? null;

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
