#!/usr/bin/env node
/**
 * Tests for who a message actually goes to.
 *
 * `src/lib/recipients.ts` decides three things that cost real money and real
 * trust when they are wrong: which guardian is written to, who counts as
 * unreachable, and whether a number shared by two children gets one message or
 * two. None of those are visible in a screenshot — the composer shows a number
 * and the teacher has no way to know it is the wrong one until a parent says
 * they were told twice, or not at all.
 *
 *   node tools/test-recipients.js
 *
 * Bundled with esbuild rather than imported, because the module is TypeScript
 * behind a path alias. It deliberately has no React and no native imports,
 * which is why it is a separate file from `deviceSms`.
 */
'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rcp-')), 'rcp.cjs');
execSync(
  `npx esbuild src/lib/recipients.ts --bundle --format=cjs --platform=node --outfile=${out} --log-level=error`,
  { stdio: 'inherit' },
);
const { planRecipients, reachOf } = require(out);

/* ---------------------------------------------------------------- Harness */

let failures = 0;
const describe = (name) => console.log(`\n${name}`);
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const eq = (label, actual, expected) => {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  check(label, same, same ? '' : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
};

let n = 0;
const student = (over = {}) => ({
  id: over.id ?? `s${++n}`,
  name: over.name ?? `Student ${n}`,
  phone: '',
  groupIds: [],
  accent: 'blue',
  ...over,
});

const plan = (students, over = {}) =>
  planRecipients({ students, audience: 'both', ...over });
/** Who is written to, as `name<phone>` — both halves matter. */
const to = (result) => result.rows.map((r) => `${r.name}<${r.phone}>`);
const phones = (result) => result.rows.map((r) => r.phone);

/* ------------------------------------------------------------- The basics */

describe('who gets a copy');
const family = student({
  name: 'Aýgül',
  phone: '65111111',
  parentName: 'Ogulgerek',
  parentPhone: '65222222',
  parent2Name: 'Serdar',
  parent2Phone: '65333333',
});

eq('students only', to(plan([family], { audience: 'students' })), ['Aýgül<+99365111111>']);
eq(
  'parents only, both of them',
  to(plan([family], { audience: 'parents' })),
  ['Ogulgerek<+99365222222>', 'Serdar<+99365333333>'],
);
eq('both means all three', plan([family]).rows.length, 3);
eq('the mother alone', to(plan([family], { audience: 'parents', parents: 'mother' })), [
  'Ogulgerek<+99365222222>',
]);
eq('the father alone', to(plan([family], { audience: 'parents', parents: 'father' })), [
  'Serdar<+99365333333>',
]);

// Asking for one who is not on file falls back rather than dropping the
// message — see `guardiansFor`.
const fatherOnly = student({ name: 'Baýram', parent2Name: 'Myrat', parent2Phone: '65444444' });
eq(
  'asking for the mother of a child who only has a father',
  to(plan([fatherOnly], { audience: 'parents', parents: 'mother' })),
  ['Myrat<+99365444444>'],
);

/* ----------------------------------------------- Numbers written two ways */

describe('one number, however it was typed');
eq(
  'the country code is not a different number',
  phones(
    plan(
      [
        student({ name: 'Elder', parentPhone: '65223344' }),
        student({ name: 'Younger', parentPhone: '+993 65 22 33 44' }),
      ],
      { audience: 'parents' },
    ),
  ),
  ['+99365223344'],
);
eq(
  'nor is the trunk 8',
  phones(
    plan(
      [
        student({ name: 'Elder', parentPhone: '65223344' }),
        student({ name: 'Younger', parentPhone: '8 65 223344' }),
      ],
      { audience: 'parents' },
    ),
  ),
  ['+99365223344'],
);

/* ------------------------------------------------------- Shared numbers */

describe('a number shared by two children');
const siblings = [
  student({ name: 'Elder', phone: '65111111', parentName: 'Mum', parentPhone: '65999999' }),
  student({ name: 'Younger', phone: '65222222', parentName: 'Mum', parentPhone: '65999999' }),
];
const shared = plan(siblings);
eq('the mother is written to once', to(shared), [
  'Elder<+99365111111>',
  'Mum<+99365999999>',
  'Younger<+99365222222>',
]);
eq('and the merge is counted, not hidden', shared.merged, 1);
eq('reach is the messages, not the children', reachOf({ students: siblings, audience: 'both' }), 3);
eq(
  'messaging the parents alone is one message, not two',
  reachOf({ students: siblings, audience: 'parents' }),
  1,
);

// The same shape inside one record rather than across two.
eq(
  'a student whose own number is their father’s',
  to(
    plan([
      student({ name: 'Merjen', phone: '65777777', parentName: 'Kaka', parentPhone: '65777777' }),
    ]),
  ),
  ['Merjen<+99365777777>'],
);
eq(
  'the same number in both guardian fields',
  to(
    plan(
      [
        student({
          name: 'Aman',
          parentName: 'Mum',
          parentPhone: '65888888',
          parent2Name: 'Dad',
          parent2Phone: '+99365888888',
        }),
      ],
      { audience: 'parents' },
    ),
  ),
  ['Mum<+99365888888>'],
);

/* ------------------------------------------------------- Nobody to write to */

describe('who counts as skipped');
eq(
  'a student with no number',
  plan([student({ name: 'Nobody' })], { audience: 'students' }).skipped,
  1,
);
eq(
  'a guardian on file with no number',
  plan([student({ name: 'Named', parentName: 'Ogulgerek' })], { audience: 'parents' }).skipped,
  1,
);
eq(
  'no guardian at all is not a skip',
  plan([student({ name: 'Alone' })], { audience: 'parents' }).skipped,
  0,
);
eq(
  'a phone field holding something that is not a number',
  plan([student({ name: 'Typo', phone: '  -- ' })], { audience: 'students' }).skipped,
  1,
);

/* ----------------------------------------------------- The same student twice */

describe('a student in two of the selected groups');
const twice = student({ name: 'Gözel', phone: '65121212' });
eq('is still one student', to(plan([twice, twice], { audience: 'students' })), [
  'Gözel<+99365121212>',
]);
eq('and is not counted as a merge', plan([twice, twice], { audience: 'students' }).merged, 0);

/* ------------------------------------------------------------------ Empty */

describe('nothing selected');
eq('no rows rather than a crash', plan([]).rows, []);
eq('and nothing skipped', plan([]).skipped, 0);

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
