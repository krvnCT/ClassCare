#!/usr/bin/env node
/**
 * Tests for bulk student import, against invented rosters of real size.
 *
 * "Imported 450 students" used to be reported by an import that left a fraction
 * of them on the phone and fewer on the account. Every cause of that was a
 * thing that only happened at scale — a response cut off at 1000 rows, two
 * database transactions landing inside each other, twelve hundred requests in
 * a row through shared hosting — so these tests run at scale: thousands of
 * generated students, a fake server that enforces the row limit, and a fake
 * SQLite that refuses a transaction inside a transaction the way the real one
 * does.
 *
 *   node tools/test-student-import.js
 *
 * The modules under test are the real ones, bundled with esbuild. Only the
 * edges are replaced: the store, Supabase, SQLite and the file system, each by
 * a small stand-in defined below.
 */
'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * esbuild's JavaScript API, for its plugins.
 *
 * The other tests here call the `npx esbuild` command line, which needs no
 * dependency. Stubbing modules needs a plugin, and plugins need the API — so
 * this finds the copy npx keeps in its cache rather than adding a package.
 */
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

/* ------------------------------------------------------------------ Stubs */

const STUBS = {
  // A store with exactly the actions the importer uses, and a real student
  // array behind them, so `applyStudentSheet` runs unmodified.
  '@/data/store': `
    let state;
    let n = 0;
    const uid = () => 'id-' + (++n).toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const accents = ['blue', 'green', 'orange', 'pink'];
    export const useStore = {
      getState: () => state,
      setState: (patch) => { state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }; },
    };
    export function resetStore(seed) {
      n = 0;
      state = {
        signedIn: true,
        offline: false,
        students: [],
        groups: [],
        log: { created: [], updated: [], archived: [], groups: [], adopted: [] },
        ...seed,
      };
      state.addGroup = (g) => {
        const id = uid();
        state.groups = [...state.groups, { ...g, id, accent: 'blue' }];
        state.log.groups.push({ id, name: g.name, term: g.term });
        return id;
      };
      state.updateGroup = (id, patch) => {
        state.groups = state.groups.map((g) => (g.id === id ? { ...g, ...patch } : g));
        if ('term' in patch) state.log.adopted.push({ id, term: patch.term });
      };
      state.removeStudent = (id) => {
        state.students = state.students.filter((s) => s.id !== id);
        state.log.archived.push(id);
      };
      state.importStudents = ({ adds, updates }) => {
        const patchOf = new Map(updates.map((u) => [u.id, u.patch]));
        const created = adds.map((a, i) => ({ ...a, id: a.id ?? uid(), accent: a.accent ?? accents[i % 4] }));
        state.students = [
          ...state.students.map((s) => (patchOf.has(s.id) ? { ...s, ...patchOf.get(s.id) } : s)),
          ...created,
        ];
        state.log.created.push(...created);
        state.log.updated.push(...updates);
        return created.map((s) => s.id);
      };
      return state;
    }
  `,
  '@/data/persistence': `export async function flushAll() {}`,
  // Headings and messages in English, from the real catalogue.
  '@/i18n/useT': `
    import { translate } from '@/i18n';
    export const translateNow = (key, vars) => translate('en', key, vars);
    export const useT = () => translateNow;
  `,
  '@/theme': `export { accentNames } from '@/theme/tokens';`,
  'react-native': `export const AppState = { addEventListener: () => ({ remove() {} }), currentState: 'active' };`,
  // A Supabase that enforces a row limit, like the real one, and counts requests.
  '@/lib/supabase': `
    export const fake = { tables: {}, maxRows: 1000, requests: 0 };
    function query(table) {
      const q = { filters: [], orders: [], from: 0, to: Infinity, wantCount: false };
      const api = {
        select(_cols, opts) { q.wantCount = !!(opts && opts.count); return api; },
        is(col, v) { q.filters.push((r) => (r[col] ?? null) === v); return api; },
        gte(col, v) { q.filters.push((r) => r[col] >= v); return api; },
        order(col, opts) { q.orders.push([col, opts && opts.ascending === false ? -1 : 1]); return api; },
        range(from, to) { q.from = from; q.to = to; return api; },
        then(resolve, reject) {
          fake.requests += 1;
          let rows = (fake.tables[table] || []).filter((r) => q.filters.every((f) => f(r)));
          rows = [...rows].sort((a, b) => {
            for (const [col, dir] of q.orders) {
              if (a[col] < b[col]) return -dir;
              if (a[col] > b[col]) return dir;
            }
            return 0;
          });
          const total = rows.length;
          const end = Math.min(q.to + 1, q.from + fake.maxRows);
          const data = rows.slice(q.from, end);
          return Promise.resolve({ data, error: null, status: 200, count: q.wantCount ? total : null }).then(resolve, reject);
        },
      };
      return api;
    }
    export const supabase = {
      from: (table) => query(table),
      auth: { getSession: async () => ({ data: { session: { user: { id: 't1' } } } }) },
    };
    export const hasSupabase = true;
    export const supabaseUrl = 'https://example.invalid';
  `,
  // SQLite as far as transactions go: one connection, and BEGIN inside BEGIN
  // fails — which is the behaviour the write lane exists to survive.
  'expo-sqlite': `
    export const fakeDb = { inTx: false, tables: {}, pending: null, errors: [] };
    const tick = () => new Promise((r) => setTimeout(r, Math.random() * 2));
    const db = {
      async execAsync(sql) {
        await tick();
        const s = sql.trim().toUpperCase();
        if (s.startsWith('BEGIN')) {
          if (fakeDb.inTx) { const e = new Error('cannot start a transaction within a transaction'); fakeDb.errors.push(e.message); throw e; }
          fakeDb.inTx = true; fakeDb.pending = JSON.parse(JSON.stringify(fakeDb.tables));
        } else if (s.startsWith('COMMIT')) {
          if (!fakeDb.inTx) { const e = new Error('cannot commit - no transaction is active'); fakeDb.errors.push(e.message); throw e; }
          fakeDb.inTx = false; fakeDb.pending = null;
        } else if (s.startsWith('ROLLBACK')) {
          if (!fakeDb.inTx) throw new Error('cannot rollback - no transaction is active');
          fakeDb.tables = fakeDb.pending; fakeDb.inTx = false; fakeDb.pending = null;
        }
      },
      async runAsync(sql, params) {
        await tick();
        const del = /^delete from (\\w+)/i.exec(sql.trim());
        if (del) { fakeDb.tables[del[1]] = []; return; }
        const kv = /settings/.test(sql);
        if (kv) { (fakeDb.tables.settings ??= []).push(params); return; }
      },
      async prepareAsync(sql) {
        const table = /insert into (\\w+)/i.exec(sql)[1];
        return {
          async executeAsync(params) { await tick(); (fakeDb.tables[table] ??= []).push(params); },
          async finalizeAsync() {},
        };
      },
      async withTransactionAsync(task) {
        try { await this.execAsync('BEGIN'); await task(); await this.execAsync('COMMIT'); }
        catch (e) { await this.execAsync('ROLLBACK').catch(() => {}); throw e; }
      },
      async getFirstAsync() { return null; },
      async getAllAsync() { return []; },
    };
    export async function openDatabaseAsync() { return db; }
    export const defaultDatabaseDirectory = undefined;
  `,
  'expo-file-system': `export class Directory { constructor() { this.uri = 'file:///x'; } } export class File {}; export const Paths = {};`,
  '@/lib/appFolder': `export const appDirectory = () => ({ uri: 'file:///x' }); export const moveIfPresent = () => false;`,
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

/* ---------------------------------------------------------------- Harness */

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

/* ------------------------------------------------------------- Mock data */

/** Deterministic, so a failure reproduces. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const GIVEN = ['Aman', 'Batyr', 'Merdan', 'Serdar', 'Döwlet', 'Aýgül', 'Maýa', 'Jeren', 'Ogulgerek', 'Bahar', 'Kemal', 'Leýli'];
const SURNAME = ['Amanow', 'Berdiýew', 'Orazow', 'Hojaýew', 'Annaýew', 'Gurbanow', 'Saparow', 'Durdyýew'];

/** A roster's worth of rows, as a teacher's spreadsheet would hold them. */
function mockRows(count, random, { year = 2026, withDocs = 0.8, terms = ['Tomus 2026'] } = {}) {
  const rows = [];
  for (let i = 0; i < count; i++) {
    const given = GIVEN[Math.floor(random() * GIVEN.length)];
    const surname = SURNAME[Math.floor(random() * SURNAME.length)];
    const age = 7 + Math.floor(random() * 15);
    const born = `${year - age}-${String(1 + Math.floor(random() * 12)).padStart(2, '0')}-${String(1 + Math.floor(random() * 28)).padStart(2, '0')}`;
    const doc = random() < withDocs ? `I-AŞ ${String(100000 + i).padStart(6, '0')}` : '';
    rows.push({
      name: `${given} ${surname}`,
      surname,
      phone: random() < 0.7 ? `+993 6${Math.floor(random() * 5)} ${String(100000 + i)}` : '',
      birthDate: born,
      term: terms[i % terms.length],
      groups: `Matematika ${['A1', 'A2', 'B1'][i % 3]}, Iňlis dili ${['A1', 'B1'][i % 2]}`,
      passport: doc && age >= 16 ? doc : '',
      birthCertificate: doc && age < 16 ? doc : '',
    });
  }
  return rows;
}

const HEAD = ['Name', 'Surname', 'Phone', 'Birth date', 'Term', 'Groups', 'Passport number', 'Birth certificate number'];
const toTable = (rows) => [
  HEAD,
  ...rows.map((r) => [r.name, r.surname, r.phone, r.birthDate, r.term, r.groups, r.passport, r.birthCertificate]),
];
const csvOf = (table, sep = ',', eol = '\n') =>
  table
    .map((row) => row.map((c) => (/["\n\r,;]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(sep))
    .join(eol);
const bytes = (s) => new Uint8Array(Buffer.from(s, 'utf8'));

/* ------------------------------------------------------------------- Run */

async function main() {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'si-')), 'bundle.cjs');
  await esbuild.build({
    stdin: {
      contents: `
        export * from './src/lib/rosterImport';
        export * from './src/lib/studentDocs';
        export * from './src/lib/opBatch';
        export { parseTermCell } from './src/lib/term';
        export {
          applyStudentSheet, rowsFromFile, studentsFromRows, studentsToXlsx, sampleStudentsXlsx,
        } from './src/data/studentsSheet';
        export { fetchStudents, fetchAttendance } from './src/data/api';
        export { replaceCollection, replaceOutbox } from './src/data/localDb';
        export { resetStore, useStore } from '@/data/store';
        export { fake } from '@/lib/supabase';
        export { fakeDb } from 'expo-sqlite';
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
  const today = new Date(2026, 9, 5); // 5 October 2026

  /* ---------------------------------------------------- Documents */
  describe('Documents: one number, written any way, is one document');
  eq('spacing, case and dashes', m.documentKey('i-aş 123456'), m.documentKey('I-AŞ123456'));
  eq('numero sign and dots', m.documentKey('I.AŞ № 123456'), m.documentKey('IAŞ123456'));
  eq('Cyrillic look-alikes', m.documentKey('С-АВ 12'), m.documentKey('C-AB 12'));
  check('different numbers differ', m.documentKey('I-AŞ 123456') !== m.documentKey('I-AŞ 123457'));

  describe('Documents: the age decides');
  eq('16 today → passport', m.documentKindForAge('2010-10-05', today), 'passport');
  eq('16 tomorrow → birth certificate', m.documentKindForAge('2010-10-06', today), 'birthCertificate');
  eq('no birth date → unknown', m.documentKindForAge(undefined, today), null);
  eq('a future birth date → unknown', m.documentKindForAge('2030-01-01', today), null);

  describe('Documents: generated codes');
  {
    const taken = new Set();
    for (let i = 0; i < 20000; i++) m.generateCode(taken);
    eq('20,000 codes, all different', taken.size, 20000);
    const code = m.generateCode(new Set());
    check(`well-formed (${code})`, m.isGeneratedCode(code));
    check('a passport is not a code', !m.isGeneratedCode('I-AŞ 123456'));
    // A random source that repeats forces the collision path.
    const stuck = new Set([m.documentKey('CC-22222222')]);
    let calls = 0;
    const again = m.generateCode(stuck, () => (calls++ < 8 ? 0 : 0.5));
    check('a colliding code is redrawn', again !== 'CC-22222222' && m.isGeneratedCode(again));
  }

  describe('Documents: names that could be one person');
  check('same name', m.namesCompatible('Aýgül Berdiýewa', 'Aýgül Berdiýewa'));
  check('Turkmen letters typed plain', m.namesCompatible('Aýgül Berdiýewa', 'Aygul Berdiyewa'));
  check('surname only in common', m.namesCompatible('Aýgül Berdiýewa', 'Maýa Berdiýewa'));
  check('nothing in common', !m.namesCompatible('Aýgül Berdiýewa', 'Batyr Orazow'));

  /* -------------------------------------------------------- Terms */
  describe('Terms: read out of a cell');
  eq('"Summer term" into summer 2026', m.parseTermCell('Summer term', { today, context: '2026-summer' }), '2026-summer');
  eq('"Tomus 2026"', m.parseTermCell('Tomus 2026', { today }), '2026-summer');
  eq('"Лето 2025"', m.parseTermCell('Лето 2025', { today }), '2025-summer');
  eq('"летний семестр" in October → this summer', m.parseTermCell('летний семестр', { today }), '2026-summer');
  eq('"gyş" in October → the coming winter', m.parseTermCell('gyş', { today }), '2027-winter');
  eq('"Güýz" in October → this autumn', m.parseTermCell('Güýz', { today }), '2026-autumn');
  eq('"fall 2026"', m.parseTermCell('fall 2026', { today }), '2026-autumn');
  eq('canonical key', m.parseTermCell('2026-spring', { today }), '2026-spring');
  eq('"Ýaz" is spring', m.parseTermCell('Ýaz 2027', { today }), '2027-spring');
  eq('no season → null', m.parseTermCell('Group 4', { today }), null);
  eq('"Letter" is not "лет"', m.parseTermCell('Letter', { today }), null);

  /* ----------------------------------------------------- Reading */
  describe('Reading: CSV in every shape a teacher has');
  {
    const random = rng(1);
    const rows = mockRows(1200, random);
    const table = toTable(rows);

    const comma = m.studentsFromRows(m.rowsFromFile(bytes(csvOf(table))));
    eq('1200 rows, commas', comma.length, 1200);

    const semi = m.studentsFromRows(m.rowsFromFile(bytes('﻿' + csvOf(table, ';', '\r\n'))));
    eq('1200 rows, semicolons + BOM + CRLF (Russian Excel)', semi.length, 1200);

    const mac = m.studentsFromRows(m.rowsFromFile(bytes(csvOf(table, ',', '\r'))));
    eq('1200 rows, bare CR line ends (Excel for Mac)', mac.length, 1200);

    const tabs = m.studentsFromRows(m.rowsFromFile(bytes(csvOf(table, '\t'))));
    eq('1200 rows, tabs', tabs.length, 1200);

    eq('first name read', comma[0].student.name, rows[0].name);
    eq('groups split', comma[0].groupNames.length, 2);
    eq('term read', comma[0].termCell, 'Tomus 2026');

    const tricky = m.studentsFromRows(
      m.rowsFromFile(
        bytes('Name;Address;Passport number\n"Aman Amanow";"Görogly köçesi 12;\n3-nji jaý";"I-AŞ 1"\n'),
      ),
    );
    eq('quoted semicolon and newline stay in one cell', tricky[0].student.address, 'Görogly köçesi 12;\n3-nji jaý');
    eq('passport column read', tricky[0].documents.passport, 'I-AŞ 1');

    const legacy = m.studentsFromRows(
      m.rowsFromFile(bytes('Name,Birth date,Passport / birth certificate ID\nAman Amanow,2015-01-01,I-AŞ 9\n')),
    );
    eq('old combined column still read', legacy[0].documents.either, 'I-AŞ 9');
    eq('…and filed by age', m.documentOfRow(legacy[0], today), { id: 'I-AŞ 9', kind: 'birthCertificate' });
  }

  describe('Reading: our own workbook comes back as it went out');
  {
    const groups = [
      { id: 'g1', name: 'Matematika A1', subject: '', room: '', slots: [], term: '2026-summer', accent: 'blue' },
      { id: 'g2', name: 'Fizika', subject: '', room: '', slots: [], term: '2026-autumn', accent: 'blue' },
    ];
    const students = [
      { id: 's1', name: 'Aman Amanow', phone: '+99365000001', groupIds: ['g1'], accent: 'blue', documentId: 'I-AŞ 1', documentKind: 'passport', birthDate: '2005-01-01' },
      { id: 's2', name: 'Jeren Orazowa', phone: '', groupIds: ['g1', 'g2'], accent: 'blue', documentId: 'CC-23456789', documentKind: 'generated' },
      { id: 's3', name: 'Maýa Saparowa', phone: '', groupIds: [], accent: 'blue', documentId: 'II-AŞ 7', birthDate: '2016-01-01' },
    ];
    const back = m.studentsFromRows(m.rowsFromFile(m.studentsToXlsx(students, groups)));
    eq('three rows', back.length, 3);
    eq('passport in the passport column', back[0].documents.passport, 'I-AŞ 1');
    eq('term written when all classes share one', back[0].termCell, 'Summer 2026');
    eq('code in the ClassCare ID column', back[1].documents.code, 'CC-23456789');
    eq('no term when classes span two', back[1].termCell, '');
    eq('legacy number of a child goes under birth certificate', back[2].documents.birthCertificate, 'II-AŞ 7');

    const sample = m.studentsFromRows(m.rowsFromFile(m.sampleStudentsXlsx()));
    eq('template reads back: three examples', sample.length, 3);
    check('template child has a birth certificate', !!sample[0].documents.birthCertificate);
    check('template adult has a passport', !!sample[1].documents.passport);
    check('template carries a term', !!sample[0].termCell);
  }

  /* ---------------------------------------------------- Planning */
  describe('Planning: 1000 new students, a fifth without documents');
  {
    const random = rng(2);
    const parsed = m.studentsFromRows(toTable(mockRows(1000, random)));
    const plan = m.planImport({ parsed, students: [], today, random });
    const docless = parsed.filter((p) => !m.documentOfRow(p, today)).length;
    eq('every row planned', plan.rows.length, 1000);
    eq('a code for each one without a document', plan.generated, docless);
    const keys = plan.rows.map((r) => m.documentKey(r.document && r.document.id));
    eq('every student ends with a unique number', new Set(keys).size, 1000);
    check('none blank', keys.every(Boolean));
    eq('no conflicts', plan.conflicts.length, 0);
  }

  describe('Planning: the same name is not the same student');
  {
    const parsed = m.studentsFromRows(
      toTable([
        { name: 'Aman Amanow', surname: 'Amanow', phone: '', birthDate: '2005-01-01', term: '', groups: '', passport: 'I-AŞ 1', birthCertificate: '' },
        { name: 'Aman Amanow', surname: 'Amanow', phone: '', birthDate: '2006-02-02', term: '', groups: '', passport: 'I-AŞ 2', birthCertificate: '' },
      ]),
    );
    const existing = [{ id: 'x', name: 'Aman Amanow', phone: '', groupIds: [], accent: 'blue', documentId: 'I-AŞ 3' }];
    const plan = m.planImport({ parsed, students: existing, today });
    eq('two rows, two students', plan.rows.length, 2);
    eq('neither is the existing namesake with another passport', plan.rows.filter((r) => r.existingId).length, 0);
  }

  describe('Planning: one row per class is one student');
  {
    const row = (groups, extra = {}) => ({ name: 'Aýgül Berdiýewa', surname: 'Berdiýewa', phone: '+993 65 1', birthDate: '2012-03-15', term: 'Tomus 2026', groups, passport: '', birthCertificate: 'I-AŞ 5', ...extra });
    const parsed = m.studentsFromRows(toTable([row('Matematika A2'), row('Iňlis dili B1'), row('Fizika', { birthCertificate: '', phone: '+993 65 1' })]));
    const plan = m.planImport({ parsed, students: [], today });
    eq('three rows → one student', plan.rows.length, 1);
    eq('…in all three classes', plan.rows[0].groups.map((g) => g.name), ['Matematika A2', 'Iňlis dili B1', 'Fizika']);
    eq('merged count', plan.mergedInFile, 2);
    eq('keeps the birth certificate', plan.rows[0].document, { id: 'I-AŞ 5', kind: 'birthCertificate' });
  }

  describe('Planning: a mistyped number does not overwrite a stranger');
  {
    const existing = [{ id: 'b', name: 'Batyr Orazow', phone: '', groupIds: [], accent: 'blue', documentId: 'I-AŞ 777' }];
    const parsed = m.studentsFromRows(
      toTable([{ name: 'Jeren Hojaýewa', surname: 'Hojaýewa', phone: '', birthDate: '', term: '', groups: '', passport: 'I-AŞ 777', birthCertificate: '' }]),
    );
    const plan = m.planImport({ parsed, students: existing, today });
    eq('row refused', plan.rows.length, 0);
    eq('reported with both names', plan.conflicts.map((c) => [c.name, c.owner]), [['Jeren Hojaýewa', 'Batyr Orazow']]);
    eq('the owner is protected from a replace', plan.protectedIds, ['b']);
  }

  describe('Planning: matching the roster already here');
  {
    const existing = [
      { id: 'a', name: 'Aman Amanow', phone: '+99365111', groupIds: [], accent: 'blue', documentId: 'I-AŞ 100' },
      { id: 'b', name: 'Batyr Orazow', phone: '+99365222', groupIds: [], accent: 'blue' },
      { id: 'c', name: 'Merdan Saparow', phone: '', groupIds: [], accent: 'blue', documentId: 'CC-23456789', documentKind: 'generated' },
    ];
    const parsed = m.studentsFromRows(
      toTable([
        // Same passport, written differently, new phone.
        { name: 'Aman Amanow', surname: 'Amanow', phone: '+99365999', birthDate: '', term: '', groups: '', passport: 'i-aş100', birthCertificate: '' },
        // Name and phone, now with a passport.
        { name: 'Batyr Orazow', surname: 'Orazow', phone: '+99365222', birthDate: '', term: '', groups: '', passport: 'I-AŞ 200', birthCertificate: '' },
        // Name alone, but the row has a real passport: could be a namesake.
        { name: 'Merdan Saparow', surname: 'Saparow', phone: '', birthDate: '', term: '', groups: '', passport: 'I-AŞ 300', birthCertificate: '' },
        // Name and phone with a passport, for a student who had only a code.
        { name: 'Jeren Hally', surname: 'Hally', phone: '+99365333', birthDate: '', term: '', groups: '', passport: 'I-AŞ 400', birthCertificate: '' },
        // Name alone, no document: a re-imported list without numbers.
        { name: 'Bahar Garaýewa', surname: 'Garaýewa', phone: '', birthDate: '', term: '', groups: '', passport: '', birthCertificate: '' },
      ]),
    );
    const roster = [
      ...existing,
      { id: 'd', name: 'Jeren Hally', phone: '+99365333', groupIds: [], accent: 'blue', documentId: 'CC-34567892', documentKind: 'generated' },
      { id: 'e', name: 'Bahar Garaýewa', phone: '', groupIds: [], accent: 'blue', documentId: 'CC-45678923', documentKind: 'generated' },
    ];
    const plan = m.planImport({ parsed, students: roster, today });
    eq('matched by document, by name+phone; namesake with a passport kept apart', plan.rows.map((r) => r.existingId ?? null), ['a', 'b', null, 'd', 'e']);
    eq('name+phone: the code is replaced by the passport', plan.rows[3].document, { id: 'I-AŞ 400', kind: 'passport' });
    eq('a row without a number leaves the code alone', plan.rows[4].document, undefined);
  }

  describe('Planning: importing into a term takes that term only');
  {
    const rows = [
      ...mockRows(10, rng(3), { terms: ['Tomus 2026'] }),
      ...mockRows(7, rng(4), { terms: ['Güýz 2026'] }),
      ...mockRows(3, rng(5), { terms: [''] }),
      ...mockRows(2, rng(6), { terms: ['???'] }),
    ].map((r, i) => ({ ...r, passport: `P${i}`, birthCertificate: '' }));
    const parsed = m.studentsFromRows(toTable(rows));
    const plan = m.planImport({ parsed, students: [], scopeTerm: '2026-summer', today });
    eq('summer rows and blank-term rows kept', plan.rows.length, 13);
    eq('autumn rows skipped', plan.otherTerm, 7);
    eq('unreadable term skipped', plan.unreadableTerm, 2);
    check('every kept class is filed in summer', plan.rows.every((r) => r.groups.every((g) => g.term === '2026-summer')));
  }

  /* ------------------------------------------------------ Classes */
  describe('Classes: a name means that term’s class');
  {
    const groups = [
      { id: 'sum', name: 'Matematika A2', term: '2026-summer', slots: [] },
      { id: 'wait', name: 'Fizika', slots: [] },
    ];
    const made = [];
    const adopted = [];
    const r = m.groupResolver(groups, {
      create: (name, term) => { const id = `new-${made.length}`; made.push({ id, name, term }); return id; },
      adopt: (id, term) => adopted.push({ id, term }),
    });
    eq('existing class in the term', r.resolve('matematika  a2', '2026-summer'), 'sum');
    const autumn = r.resolve('Matematika A2', '2026-autumn');
    eq('same name in another term is made there', made[0], { id: autumn, name: 'Matematika A2', term: '2026-autumn' });
    eq('…once', r.resolve('Matematika A2', '2026-autumn'), autumn);
    eq('a class waiting for a term is given this one', r.resolve('Fizika', '2026-autumn'), 'wait');
    eq('…and recorded', adopted, [{ id: 'wait', term: '2026-autumn' }]);
    eq('no term: any class of that name', r.resolve('Matematika A2'), 'sum');
    eq('counts', r.counts, { created: 1, adopted: 1 });
  }

  /* ------------------------------------------------------- Apply */
  describe('Apply: 450 students into an empty account, then the same file again');
  {
    m.resetStore({ students: [], groups: [] });
    const random = rng(7);
    const table = toTable(mockRows(450, random, { withDocs: 0.7 }));
    const parsed = m.studentsFromRows(table);

    const first = await m.applyStudentSheet(parsed, 'merge');
    const state = m.useStore.getState();
    eq('450 added', first.added, 450);
    eq('450 on the roster', state.students.length, 450);
    eq('one state change for all of them', state.log.created.length, 450);
    check('every student has a number', state.students.every((s) => m.documentKey(s.documentId)));
    eq('numbers unique', new Set(state.students.map((s) => m.documentKey(s.documentId))).size, 450);
    check('codes marked generated', state.students.filter((s) => s.documentKind === 'generated').length === first.generated);
    eq('classes made once each, in summer', state.groups.map((g) => g.term), state.groups.map(() => '2026-summer'));
    eq('five classes', state.groups.length, 5);
    check('everyone joined two classes', state.students.every((s) => s.groupIds.length === 2));

    const second = await m.applyStudentSheet(m.studentsFromRows(table), 'merge');
    eq('re-import adds nobody', second.added, 0);
    eq('…updates everybody', second.updated, 450);
    eq('…makes no classes', second.groupsCreated, 0);
    eq('roster unchanged in size', m.useStore.getState().students.length, 450);
    eq('no new codes for students who have one', second.generated, 0);
  }

  describe('Apply: a blank cell clears nothing');
  {
    m.resetStore({
      students: [{ id: 'a', name: 'Aman Amanow', phone: '+99365111', email: 'aman@example.com', groupIds: [], accent: 'blue', documentId: 'I-AŞ 1', documentKind: 'passport' }],
      groups: [],
    });
    await m.applyStudentSheet(
      m.studentsFromRows([['Name', 'Phone', 'Email', 'Passport number'], ['Aman Amanow', '+99365111', '', 'I-AŞ 1']]),
      'merge',
    );
    const s = m.useStore.getState().students[0];
    eq('email kept', s.email, 'aman@example.com');
    check('no empty or undefined key in the update', Object.entries(m.useStore.getState().log.updated[0].patch).every(([, v]) => v !== undefined && v !== ''));
  }

  describe('Apply: replace keeps students the file’s refused rows pointed at');
  {
    m.resetStore({
      students: [
        { id: 'a', name: 'Aman Amanow', phone: '', groupIds: [], accent: 'blue', documentId: 'I-AŞ 1' },
        { id: 'b', name: 'Batyr Orazow', phone: '', groupIds: [], accent: 'blue', documentId: 'I-AŞ 2' },
        { id: 'c', name: 'Gone Away', phone: '', groupIds: [], accent: 'blue', documentId: 'I-AŞ 3' },
      ],
      groups: [],
    });
    const outcome = await m.applyStudentSheet(
      m.studentsFromRows([
        ['Name', 'Passport number'],
        ['Aman Amanow', 'I-AŞ 1'],
        ['Jeren Hojaýewa', 'I-AŞ 2'], // Batyr's number, someone else's name
      ]),
      'replace',
    );
    eq('one conflict', outcome.conflicts.length, 1);
    eq('only the student truly absent is removed', m.useStore.getState().log.archived, ['c']);
  }

  describe('Apply: into a term');
  {
    m.resetStore({
      students: [],
      groups: [{ id: 'aut', name: 'Matematika A1', term: '2026-autumn', slots: [], subject: '', room: '', accent: 'blue' }],
    });
    const rows = [
      ...mockRows(20, rng(8), { terms: ['Tomus'] }),
      ...mockRows(5, rng(9), { terms: ['Güýz 2026'] }),
    ].map((r, i) => ({ ...r, groups: 'Matematika A1', passport: `T${i}`, birthCertificate: '' }));
    const outcome = await m.applyStudentSheet(m.studentsFromRows(toTable(rows)), 'merge', { term: '2026-summer' });
    const st = m.useStore.getState();
    eq('summer rows only', outcome.added, 20);
    eq('autumn rows skipped', outcome.otherTerm, 5);
    const summer = st.groups.find((g) => g.term === '2026-summer');
    check('a summer Matematika A1 was made beside the autumn one', !!summer && summer.id !== 'aut');
    check('everyone is in the summer class, nobody in autumn', st.students.every((s) => s.groupIds.length === 1 && s.groupIds[0] === summer.id));
  }

  /* ----------------------------------------------------- Batching */
  describe('Queue: 450 creates fold into five batches');
  {
    let queue = [];
    const enqueue = (op) => {
      const tail = queue[queue.length - 1];
      const folded = tail ? m.foldIntoBatch(tail, op) : null;
      if (folded) queue[queue.length - 1] = folded;
      else queue.push(op);
    };
    enqueue({ kind: 'group.create', group: { id: 'g' } });
    for (let i = 0; i < 450; i++) enqueue({ kind: 'student.create', student: { id: `s${i}`, groupIds: ['g'] } });
    eq('ops', queue.map((op) => op.kind), ['group.create', 'student.createMany', 'student.createMany', 'student.createMany', 'student.createMany', 'student.createMany']);
    eq('sizes', queue.slice(1).map((op) => op.students.length), [100, 100, 100, 100, 50]);
    eq('weight is students, not requests', queue.reduce((n, op) => n + m.opWeight(op), 0), 451);
    eq('order kept', queue.slice(1).flatMap((op) => op.students.map((s) => s.id))[449], 's449');

    enqueue({ kind: 'student.create', student: { id: 's449', name: 'again' } });
    eq('a repeated create replaces, not duplicates', queue[queue.length - 1].students.length, 50);

    const parts = m.splitBatch(queue[1]);
    eq('a refused batch splits into its rows', parts.length, 100);
    eq('…as single creates', parts[0].kind, 'student.create');
    eq('a batch of one does not split again', m.splitBatch({ kind: 'student.updateMany', patches: [{ id: 'x', patch: {} }] }), null);
    check('a batch touches its students', m.touchesSameTarget({ kind: 'student.update', id: 's7', patch: {} }, queue[1]));

    queue = [];
    for (let i = 0; i < 150; i++) enqueue({ kind: 'student.archive', id: `a${i}` });
    eq('archives fold too', queue.map((op) => op.ids.length), [100, 50]);
  }

  /* --------------------------------------------------------- Pull */
  describe('Pull: every row comes back, whatever the server’s row limit');
  for (const limit of [1000, 500, 333]) {
    m.fake.maxRows = limit;
    m.fake.requests = 0;
    const students = Array.from({ length: 2500 }, (_, i) => ({
      id: `s${String(i).padStart(5, '0')}`, teacher_id: 't1', name: `Student ${i % 40}`, phone: '', accent: 'blue', archived_at: null,
    }));
    const links = students.flatMap((s, i) => [
      { student_id: s.id, group_id: 'g1' },
      { student_id: s.id, group_id: `g${2 + (i % 3)}` },
      ...(i % 2 ? [{ student_id: s.id, group_id: 'g9' }] : []),
    ]);
    m.fake.tables = { students, student_groups: links };
    const got = await m.fetchStudents();
    eq(`limit ${limit}: 2500 students`, got.length, 2500);
    eq(`limit ${limit}: all ${links.length} memberships`, got.reduce((n, s) => n + s.groupIds.length, 0), links.length);
    eq(`limit ${limit}: no student twice`, new Set(got.map((s) => s.id)).size, 2500);
  }
  {
    m.fake.maxRows = 1000;
    const attendance = Array.from({ length: 4321 }, (_, i) => ({
      id: `a${String(i).padStart(5, '0')}`, group_id: 'g1', session_date: `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, starts_at: '16:00:00', student_id: `s${i}`, status: 'present',
    }));
    m.fake.tables = { attendance };
    const reg = await m.fetchAttendance();
    eq('4321 attendance marks all arrive', Object.values(reg).reduce((n, r) => n + Object.keys(r).length, 0), 4321);
  }

  /* ---------------------------------------------------- Local DB */
  describe('Device database: two writers, no collisions');
  {
    const rows = Array.from({ length: 450 }, (_, i) => ({ id: `s${i}`, value: { id: `s${i}`, name: `S ${i}` } }));
    const ops = Array.from({ length: 450 }, (_, i) => ({ kind: 'student.create', student: { id: `s${i}` } }));
    m.fakeDb.errors.length = 0;
    // The import's table write and the outbox saves, started together as the
    // app does — then a second round of each while the first is still running.
    const results = await Promise.allSettled([
      m.replaceCollection('students', rows),
      m.replaceOutbox(ops),
      m.replaceOutbox(ops.slice(0, 300)),
      m.replaceCollection('students', rows),
      m.replaceOutbox(ops.slice(0, 100)),
    ]);
    eq('every write succeeded', results.filter((r) => r.status === 'rejected').map((r) => r.reason.message), []);
    eq('no transaction errors', [...new Set(m.fakeDb.errors)], []);
    eq('all 450 students on disk', (m.fakeDb.tables.students || []).length, 450);
    eq('the last outbox write wins', (m.fakeDb.tables.outbox || []).length, 100);
  }

  console.log(failures ? `\n${failures} failing` : '\nall passing');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
