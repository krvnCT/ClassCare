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

/**
 * What the transfer's notification says, in the app's language.
 *
 * The native side has no translations of its own, so the words come from
 * JavaScript. `{title}`, `{count}`, `{busy}`, `{file}`, `{files}` and
 * `{percent}` are filled in as the transfer moves.
 */
export type BeamNotifyText = {
  /** Android's name for the progress notifications, under app settings. */
  channel: string;
  /** Android's name for the "finished" notifications. */
  channelResult: string;
  /** The headline. `{title}` is the handout. */
  title: string;
  /** Before anything moves: "Waiting for students to scan" / "Connecting…". */
  waiting: string;
  /** Sender: `{count}` phones have it. */
  received?: string;
  /** Sender: `{busy}` phones are taking it right now. */
  receiving?: string;
  /** Receiver: `{file}` of `{files}`, `{percent}` overall. */
  progress?: string;
  /** The button that stops sharing, or cancels receiving. */
  stop: string;
  /** Receiver, finished while the app was not on screen. */
  done?: string;
  doneText?: string;
  failed?: string;
  failedText?: string;
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
  /** The handout's title, for the notification. */
  title?: string;
  /** Each file's size as the code promised, for one progress bar across all of them. */
  sizes?: number[];
  notify?: BeamNotifyText;
  /** Opened when the student taps "received" after leaving the app. */
  openUrl?: string;
};

/**
 * How far the student's phone has got in reaching the teacher's.
 *
 * `approve` is the one the student has to act on: Android is showing its own
 * "Connect to device" window, and the screen should tell them to tap Connect.
 */
export type BeamStage = 'joining' | 'approve' | 'connecting' | 'downloading';

/** A share still running — asked by a screen rebuilt while it was. */
export type BeamHostStatus = { title: string; received: number; busy: number };

/** A receive still running — asked by a screen rebuilt while it was. */
export type BeamReceiveStatus = {
  title: string;
  stage: BeamStage;
  file: number;
  files: number;
  received: number;
  total: number;
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
  | { kind: 'failed'; peer: string; message: string; begun?: boolean }
  | { kind: 'error'; message: string };

/** What the student's screen shows while a file lands. */
export type BeamProgressEvent = { file: number; received: number; size: number };

export type BeamEvents = {
  onBeamPeer: (event: BeamPeerEvent) => void;
  onBeamProgress: (event: BeamProgressEvent) => void;
  onBeamStage: (event: { stage: BeamStage }) => void;
  /** The teacher pressed Stop on the notification. */
  onBeamHostStopped: (event: { received: number }) => void;
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
  /** True on every build that has the join ladder; false only on old ones. */
  canJoinAutomatically(): boolean;
  /** The share still running, or null. Absent on builds from before it existed. */
  hostStatus?(): BeamHostStatus | null;
  /** The receive still running, or null. Absent on builds from before it existed. */
  receiveStatus?(): BeamReceiveStatus | null;
  /**
   * Whether Wi-Fi is switched on.
   *
   * The receiving side's one precondition: a phone with Wi-Fi off joins
   * nothing. Separate from `blocker`, which is about sending.
   */
  wifiEnabled(): boolean;
  /**
   * The name a file's provider reports, or null when it will not say.
   *
   * Android document URIs carry no name: the picker falls back to the URI's
   * last path segment, which for the media provider is `msf:1000000033`.
   */
  displayName(uri: string): string | null;
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
  /** Android 13+: may the transfer's notification be shown. Never required. */
  requestNotificationsAsync?(): Promise<{ granted: boolean; canAskAgain: boolean; status: string }>;
  /**
   * Create the group, start serving, and report how to be reached.
   *
   * Keeps running when the app is left, with a notification saying so and a
   * Stop button on it; only `stopHostAsync` or that button ends it.
   */
  startHostAsync(
    manifest: string,
    files: BeamFileArg[],
    token: string,
    notify?: BeamNotifyText,
  ): Promise<BeamGroup>;
  stopHostAsync(): Promise<void>;
  receiveAsync(options: BeamReceiveOptions): Promise<BeamDelivery>;
  cancelReceiveAsync(): Promise<void>;
}
