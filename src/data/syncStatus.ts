/**
 * Whether the teacher's changes have actually reached the server.
 *
 * Kept out of the main store deliberately: this is transient truth about the
 * connection, not data, and persisting it would mean a relaunch could show
 * "3 changes waiting" for a queue that no longer exists.
 *
 * It exists at all because the app writes locally first and mirrors in the
 * background. That is the right trade for taking attendance on classroom wifi,
 * but it means a failed write used to be invisible — the group looked saved,
 * and only the send days later revealed that the server had never heard of it.
 */
import { create } from 'zustand';

export type SyncState = {
  /** Writes accepted locally that have not yet landed on the server. */
  pending: number;
  /** The last attempt failed because the server could not be reached. */
  offline: boolean;
  /** A write that failed for a reason retrying will not fix. */
  failure: string | null;
  /** A push or pull is in flight right now. Drives the spinner on the button. */
  syncing: boolean;
  /**
   * The very first pull on this device is running, and there is nothing local
   * behind it yet.
   *
   * Distinct from `syncing`, which is true of every later refresh and is meant
   * to be ignorable. This one earns the whole screen: a teacher signing in on a
   * new phone waits while a term of students, groups, registers and marks comes
   * down, and what they used to see meanwhile was an empty roster — which reads
   * exactly like an account with nothing in it. More than one has concluded
   * their data was lost and begun typing it back in.
   *
   * Cleared when the pull finishes, succeeds or fails. A failure leaves them on
   * the empty roster with the sync banner, which is at least honest; leaving
   * the spinner up forever would not be.
   */
  firstPull: boolean;
  /**
   * When something last reached the server, as `Date.now()`.
   *
   * Not persisted, like everything else here. "Last synced 3 days ago" after a
   * relaunch would be a claim about a queue this process has never seen.
   */
  lastSyncedAt: number | null;
};

type SyncStore = SyncState & {
  report: (patch: Partial<SyncState>) => void;
  clearFailure: () => void;
};

export const useSyncStatus = create<SyncStore>()((set) => ({
  pending: 0,
  offline: false,
  failure: null,
  syncing: false,
  firstPull: false,
  lastSyncedAt: null,
  report: (patch) => set(patch),
  clearFailure: () => set({ failure: null }),
}));

export const syncStatus = () => useSyncStatus.getState();
