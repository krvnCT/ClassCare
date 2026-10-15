#!/usr/bin/env node
/**
 * What the teacher is told when a save cannot reach the server.
 *
 * A phone without signal for more than an hour holds a session whose access
 * token has aged out. Saving anything then used to be reported as "your session
 * expired", and the change was dropped from the outbox — when nothing was wrong
 * with the session and the write only needed the signal back.
 *
 *   node tools/test-sync-errors.js
 *
 * The real session helper, the real outbox and the real error classifier,
 * bundled with esbuild. Only the edges are replaced: Supabase's auth, the API
 * module (which calls the real session helper first, like the real one), the
 * on-device database and the store.
 */
'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadEsbuild() {
  try {
    return require('esbuild');
  } catch {
    execSync('npx --yes esbuild --version', { stdio: 'ignore' });
    const cache = path.join(os.homedir(), '.npm', '_npx');
    for (const dir of fs.readdirSync(cache)) {
      const candidate = path.join(cache, dir, 'node_modules', 'esbuild');
      if (fs.existsSync(path.join(candidate, 'package.json'))) return require(candidate);
    }
    throw new Error('esbuild not found — run `npx esbuild --version` once, online');
  }
}
const esbuild = loadEsbuild();
const ROOT = path.resolve(__dirname, '..');

const STUBS = {
  // The auth client, with a session the test can age out or kill.
  '@/lib/supabase': `
    export const auth = { mode: 'signedIn' };
    const retryable = Object.assign(new Error('Network request failed'), { name: 'AuthRetryableFetchError', status: 0 });
    const refused = Object.assign(new Error('Invalid Refresh Token: Already Used'), { name: 'AuthApiError', status: 400 });
    export const supabase = {
      auth: {
        getSession: async () => {
          if (auth.mode === 'signedIn') return { data: { session: { user: { id: 't1' } } }, error: null };
          // Token aged out and the refresh could not reach the server.
          if (auth.mode === 'expiredOffline') return { data: { session: null }, error: retryable };
          // Refresh token refused: a session that is genuinely over.
          if (auth.mode === 'dead') return { data: { session: null }, error: refused };
          return { data: { session: null }, error: null };
        },
      },
    };
    export const hasSupabase = true;
    export const supabaseUrl = 'https://example.invalid';
  `,
  // Every call goes through the real session check first, as in api.ts.
  '@/data/api': `
    import { requireUserId } from '@/lib/session';
    export const sent = [];
    export async function updateTeacher(patch) {
      const id = await requireUserId();
      sent.push({ id, patch });
    }
    export const hasSession = async () => true;
  `,
  '@/data/localDb': `
    export const saved = { outbox: [] };
    export const loadSnapshot = async () => null;
    export const readOutbox = async () => [];
    export const readSetting = async () => null;
    export const writeSetting = async () => {};
    export const replaceOutbox = async (rows) => { saved.outbox = rows; };
  `,
  '@/data/store': `
    const state = { offline: false, signedIn: true, teacherId: 't1', students: [], groups: [] };
    export const useStore = { getState: () => state, setState: (p) => Object.assign(state, p), subscribe: () => () => {} };
    export const setStoreMirror = () => {};
  `,
  '@/lib/studentPhoto': `
    export const deleteRemotePhoto = async () => {};
    export const photoFile = () => ({ exists: false });
    export const refreshPhotos = async () => 0;
    export const syncMissingPhotos = async () => {};
    export const uploadPhoto = async () => '';
  `,
  '@/i18n/useT': `
    import { translate } from '@/i18n';
    export const translateNow = (key, vars) => translate('en', key, vars);
    export const useT = () => translateNow;
  `,
};

const stubPlugin = {
  name: 'stubs',
  setup(build) {
    const filter = new RegExp(
      '^(' + Object.keys(STUBS).map((k) => k.replace(/[/.@-]/g, '\\$&')).join('|') + ')$',
    );
    build.onResolve({ filter }, (args) => ({ path: args.path, namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
      contents: STUBS[args.path],
      loader: 'js',
      resolveDir: ROOT,
    }));
  },
};

let failures = 0;
const describe = (name) => console.log(`\n${name}`);
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail && !ok ? '  — ' + detail : ''}`);
};
const eq = (label, actual, expected) =>
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );
const settle = (ms = 40) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'se-')), 'bundle.cjs');
  await esbuild.build({
    stdin: {
      contents: `
        export { lookupSession, requireUserId } from './src/lib/session';
        export { describeError, isOfflineError } from './src/lib/errors';
        export { remote, flushWrites, retryNow, syncNow } from './src/data/sync';
        export { useSyncStatus } from './src/data/syncStatus';
        export { auth } from '@/lib/supabase';
        export { sent } from '@/data/api';
        export { saved } from '@/data/localDb';
      `,
      resolveDir: ROOT,
      loader: 'ts',
    },
    bundle: true,
    format: 'cjs',
    platform: 'node',
    outfile: out,
    logLevel: 'error',
    plugins: [stubPlugin],
    tsconfig: path.join(ROOT, 'tsconfig.json'),
  });
  const m = require(out);
  const status = () => m.useSyncStatus.getState();

  describe('Session: "cannot tell" is not "signed out"');
  m.auth.mode = 'signedIn';
  eq('a valid session gives its user', (await m.lookupSession()).state, 'signedIn');
  m.auth.mode = 'expiredOffline';
  eq('aged-out token and no signal is unknown', (await m.lookupSession()).state, 'unknown');
  m.auth.mode = 'dead';
  eq('a refresh token the server refused is signed out', (await m.lookupSession()).state, 'signedOut');
  m.auth.mode = 'none';
  eq('no stored session is signed out', (await m.lookupSession()).state, 'signedOut');

  describe('Session: what the caller sees');
  m.auth.mode = 'expiredOffline';
  {
    let caught;
    try {
      await m.requireUserId();
    } catch (e) {
      caught = e;
    }
    check('throws', !!caught);
    check('the error is recognised as an unreachable server', m.isOfflineError(caught));
    eq('and is described as no connection, not an expired session', m.describeError(caught).kind, 'offline');
  }
  m.auth.mode = 'dead';
  {
    let caught;
    try {
      await m.requireUserId();
    } catch (e) {
      caught = e;
    }
    eq('a dead session is still described as signed out', m.describeError(caught).kind, 'auth');
  }

  describe('Saving with an aged-out token and no signal');
  m.auth.mode = 'expiredOffline';
  m.remote.setProfile({ name: 'Aman Berdiýew' });
  await settle();
  eq('nothing reached the server', m.sent.length, 0);
  eq('the change is still queued', m.saved.outbox.length, 1);
  check('the banner is the offline one', status().offline === true);
  eq('no "could not save" failure is raised', status().failure, null);
  eq('one change is waiting', status().pending, 1);

  describe('…and the signal comes back');
  m.auth.mode = 'signedIn';
  await m.flushWrites();
  eq('it was sent', m.sent.length, 1);
  eq('with what the teacher typed', m.sent[0].patch, { name: 'Aman Berdiýew' });
  eq('queue empty', m.saved.outbox.length, 0);
  check('no longer offline', status().offline === false);

  describe('Saving while genuinely signed out');
  m.auth.mode = 'dead';
  m.remote.setProfile({ name: 'Aýgül Orazowa' });
  await settle();
  eq('kept, not dropped', m.saved.outbox.length, 1);
  check('the banner says to sign in, and that it is saved on the phone',
    /Saved on this phone\. Sign in again/.test(status().failure || ''), String(status().failure));
  check('and is not the old "could not be saved"', !/could not be saved/.test(status().failure || ''));

  describe('…and they sign in again');
  m.auth.mode = 'signedIn';
  await m.flushWrites();
  eq('it is sent', m.sent.length, 2);
  eq('with the later name', m.sent[1].patch, { name: 'Aýgül Orazowa' });
  eq('banner cleared', status().failure, null);

  describe('Two edits while waiting are one write');
  m.auth.mode = 'expiredOffline';
  m.remote.setProfile({ name: 'Maýa' });
  // After the first attempt has failed and is waiting, not while it is in
  // flight: the head of the queue on the wire is never rewritten.
  await settle();
  m.remote.setProfile({ timezone: 'Asia/Ashgabat' });
  await settle();
  eq('one queued change', m.saved.outbox.length, 1);
  m.auth.mode = 'signedIn';
  await m.flushWrites();
  eq('carrying both fields', m.sent[2].patch, { name: 'Maýa', timezone: 'Asia/Ashgabat' });

  describe('The Sync button says why it could not finish');
  // The probe only needs an answer from the server, whatever it is.
  globalThis.fetch = async () => ({ status: 200 });

  m.auth.mode = 'expiredOffline';
  m.remote.setProfile({ name: 'Jeren' });
  await settle();
  eq('no signal → "offline"', await m.syncNow(), 'offline');

  m.auth.mode = 'dead';
  eq('signed out → "signIn", not "no internet"', await m.syncNow(), 'signIn');

  m.auth.mode = 'signedIn';
  await m.flushWrites();
  eq('queue cleared once signed in', m.saved.outbox.length, 0);

  console.log(failures ? `\n${failures} failed` : '\nall passing');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
