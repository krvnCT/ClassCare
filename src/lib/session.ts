/**
 * Who is signed in — and the difference between "nobody" and "cannot tell".
 *
 * Access tokens last an hour. A phone that has been without signal for longer
 * than that holds a session whose token has aged out, and `getSession()` then
 * tries to refresh it over the network. With no network the refresh fails with
 * a *retryable* error, and `getSession()` hands back `session: null` alongside
 * it — the same `null` it returns for a teacher who is genuinely signed out.
 *
 * Every caller used to read the `null` and throw "Not signed in", which
 * `describeError` reports as "Your session expired. Sign in again." A teacher
 * who saved a register on a dead connection was told their session had timed
 * out and the change was dropped from the outbox, when nothing was wrong with
 * the session at all and the write only needed the signal back.
 *
 * The session is still in storage in that case — a retryable refresh failure
 * never removes it — so the honest answer is "I could not find out", and the
 * error that says so is the one the sync queue already knows to wait out.
 */
import { isOfflineError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

export type SessionLookup =
  | { state: 'signedIn'; userId: string }
  | { state: 'signedOut' }
  /** The token needed refreshing and the server could not be reached. */
  | { state: 'unknown'; cause: unknown };

export async function lookupSession(): Promise<SessionLookup> {
  const { data, error } = await supabase.auth.getSession();

  const userId = data.session?.user?.id;
  if (userId) return { state: 'signedIn', userId };

  // Only a failure to *reach* the server is "unknown". A refresh token the
  // server refused ("already used", "revoked") is a session that is really
  // over, and saying so is correct.
  if (error && isOfflineError(error)) return { state: 'unknown', cause: error };

  return { state: 'signedOut' };
}

/**
 * The signed-in teacher's id, for a write that needs one.
 *
 * Throws the network error itself when the session could not be checked, so the
 * caller's `isOfflineError` sees an unreachable server — and keeps the change
 * and says "saved on this phone" — rather than an account problem.
 */
export async function requireUserId(): Promise<string> {
  const found = await lookupSession();
  if (found.state === 'signedIn') return found.userId;
  if (found.state === 'unknown') throw found.cause;
  throw new Error('Not signed in');
}
