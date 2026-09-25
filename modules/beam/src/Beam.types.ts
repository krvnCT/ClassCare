import type { NativeModule } from 'expo';

/** A file the teacher is handing out. `uri` is what the picker gave us. */
export type BeamFileArg = {
  uri: string;
  name: string;
  mime: string;
};

/**
 * How the class reaches the teacher's phone.
 *
 * `hotspot` and `lan` are networks that already existed — the class is on them
 * or joins them the way they always do — so the code carries no credentials.
 * `direct` is a group this app brought up for the occasion, and that one has a
 * name and a password nobody has seen before.
 */
export type BeamRoute = 'hotspot' | 'direct' | 'lan';

/** Everything the QR has to carry for a student to reach this phone. */
export type BeamGroup = {
  /** The network the teacher's phone is running, e.g. `DIRECT-Ab-…`. Empty off the direct route. */
  ssid: string;
  /** Its WPA2 password. Empty off the direct route. */
  passphrase: string;
  /** The teacher's address on that network. */
  host: string;
  /** Chosen by the OS, so nothing is hardcoded and two apps cannot collide. */
  port: number;
  /** Which of the three this turned out to be. */
  route: BeamRoute;
};

export type BeamReceiveOptions = {
  /** Omit when the student is already on the right network. */
  ssid?: string;
  passphrase?: string;
  host: string;
  port: number;
  token: string;
  /** Absolute directory to write into. Created if missing. */
  directory: string;
};

export type BeamDelivery = {
  /** The manifest JSON verbatim, for the receiver to parse and store. */
  manifest: string;
  files: { path: string; name: string; size: number }[];
};

/** What the teacher's screen shows while the class is scanning. */
export type BeamPeerEvent =
  | { kind: 'started'; peer: string }
  | { kind: 'progress'; peer: string; file: number; sent: number; size: number }
  | { kind: 'done'; peer: string; total: number }
  | { kind: 'rejected'; peer: string }
  | { kind: 'failed'; peer: string; message: string }
  | { kind: 'error'; message: string };

/** What the student's screen shows while a file lands. */
export type BeamProgressEvent = { file: number; received: number; size: number };

export type BeamEvents = {
  onBeamPeer: (event: BeamPeerEvent) => void;
  onBeamProgress: (event: BeamProgressEvent) => void;
};

export declare class BeamModuleType extends NativeModule<BeamEvents> {
  /** False on a phone with no Wi-Fi Direct radio. Hide the button. */
  isAvailable(): boolean;
  /**
   * How the next share would reach the class, or null when nothing would.
   *
   * The ladder is hotspot, then a group of our own, then the joined Wi-Fi —
   * see the native `route`. Worth asking before starting because the answer
   * changes what the screen tells the students to do.
   */
  route(): BeamRoute | null;
  /**
   * What would stop a share right now, or null.
   *
   * Null whenever any route is open, so this is only ever an answer when there
   * is no network to be had at all. Asked before starting rather than
   * discovered by waiting: each of these otherwise spends thirty seconds
   * becoming a timeout, which is the one error that tells a teacher nothing
   * about what to do next.
   */
  blocker(): 'unsupported' | 'wifiOff' | 'locationOff' | null;
  /** False below Android 10 — the student must join the network by hand. */
  canJoinAutomatically(): boolean;
  /**
   * Whether Wi-Fi is switched on.
   *
   * The receiving side's one precondition: a phone with Wi-Fi off joins
   * nothing. Separate from `blocker`, which is about sending.
   */
  wifiEnabled(): boolean;
  /**
   * Copy a received file into the phone's Downloads folder.
   *
   * Resolves to where it landed, or null if it could not be copied — which is
   * not an error worth failing a transfer over, since the file is already in
   * the app.
   */
  exportAsync(path: string, name: string, mime: string, folder: string): Promise<string | null>;
  getPermissionsAsync(): Promise<{ granted: boolean; canAskAgain: boolean; status: string }>;
  requestPermissionsAsync(): Promise<{ granted: boolean; canAskAgain: boolean; status: string }>;
  /** Create the group, start serving, and report how to be reached. */
  startHostAsync(manifest: string, files: BeamFileArg[], token: string): Promise<BeamGroup>;
  stopHostAsync(): Promise<void>;
  receiveAsync(options: BeamReceiveOptions): Promise<BeamDelivery>;
  cancelReceiveAsync(): Promise<void>;
}
