#!/usr/bin/env node
/**
 * Tests for the student list's filters and sorts.
 *
 * `src/lib/studentFilter.ts` is the part of that screen with decisions in it,
 * and every one of them is easy to get subtly wrong in a way that looks fine:
 * a sort that puts level 10 between 1 and 2, a "missing parent phone" filter
 * that counts a name as a contact, an ungraded student filed under the bottom
 * score band as though they were failing. None of those show up in a
 * screenshot. All of them show up here.
 *
 *   node tools/test-student-filter.js
 *
 * Bundled with esbuild rather than imported, because the module is TypeScript
 * behind a path alias. It has no React and no native imports, which is the
 * whole reason it was pulled out of the screen.
 */
'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-')), 'sf.cjs');
execSync(
  `npx esbuild src/lib/studentFilter.ts --bundle --format=cjs --platform=node --outfile=${out} --log-level=error`,
  { stdio: 'inherit' },
);
const { buildSections, isMissing, schoolKey } = require(out);

/* ---------------------------------------------------------------- Harness */

let failures = 0;
let group = '';
const describe = (name) => {
  group = name;
  console.log(`\n${name}`);
};
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`);
};
const eq = (label, actual, expected) =>
  check(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    JSON.stringify(actual) === JSON.stringify(expected)
      ? ''
      : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`,
  );

/** Echoes the key, so a heading is checkable without a catalogue. */
const t = (key, vars) =>
  vars ? `${key}(${Object.values(vars).join(',')})` : key;

const thisYear = new Date().getFullYear();
const bornAgo = (years) => `${thisYear - years}-01-15`;

let n = 0;
const student = (over = {}) => ({
  id: `s${++n}`,
  name: over.name ?? `Student ${n}`,
  phone: '65000000',
  groupIds: [],
  accent: 'blue',
  ...over,
});

/** The names of the sections, and who is in each. */
const shape = (sections) => sections.map((s) => [s.title, s.data.map((d) => d.name)]);

const run = (students, over = {}) =>
  buildSections({
    students,
    query: '',
    gender: 'any',
    term: 'any',
    age: 'any',
    school: 'any',
    level: 'any',
    missing: 'any',
    sort: 'name',
    termsByStudent: new Map(students.map((s) => [s.id, new Set()])),
    levelByStudent: new Map(students.map((s) => [s.id, 0])),
    t,
    ...over,
  });

const names = (sections) => sections.flatMap((s) => s.data.map((d) => d.name));

/* -------------------------------------------------------------- schoolKey */

describe('schoolKey merges the spellings people actually type');
eq('case', schoolKey('Mekdep 20'), schoolKey('mekdep 20'));
eq('padding and runs of space', schoolKey('  Mekdep   20 '), schoolKey('Mekdep 20'));
check('but not different schools', schoolKey('Mekdep 20') !== schoolKey('Mekdep 21'));

/* ---------------------------------------------------------------- missing */

describe('missing details finds the hole, not the student');
check('no phone', isMissing(student({ phone: '' }), 'phone'));
check('whitespace is no phone', isMissing(student({ phone: '   ' }), 'phone'));
check('a phone is not missing', !isMissing(student({ phone: '65123456' }), 'phone'));

check(
  'a parent name with no number still counts as missing',
  isMissing(student({ parentName: 'Aýna' }), 'parent'),
  'a name is no use when a child is off sick',
);
check(
  'either parent having a number is enough',
  !isMissing(student({ parent2Phone: '65123456' }), 'parent'),
);
check('no birthday', isMissing(student({}), 'birthday'));
check('no school', isMissing(student({ school: '  ' }), 'school'));

const roster = [
  student({ name: 'Aman', phone: '', school: 'Mekdep 20' }),
  student({ name: 'Baýram', phone: '65111111', parentPhone: '65222222', school: 'Mekdep 20' }),
];
eq(
  'the filter returns only students with that gap',
  names(run(roster, { missing: 'phone' })),
  ['Aman'],
);

/* ----------------------------------------------------------------- school */

describe('school filter');
const schools = [
  student({ name: 'Aman', school: 'Mekdep 20' }),
  student({ name: 'Baýram', school: 'mekdep  20' }),
  student({ name: 'Çary', school: 'Mekdep 21' }),
  student({ name: 'Döwlet' }),
];
eq(
  'differently typed spellings land together',
  names(run(schools, { school: schoolKey('Mekdep 20') })),
  ['Aman', 'Baýram'],
);
eq('a different school does not', names(run(schools, { school: schoolKey('Mekdep 21') })), ['Çary']);
eq('"none" selects the ones with no school', names(run(schools, { school: 'none' })), ['Döwlet']);

/* ------------------------------------------------------------------ level */

describe('level sorts as a number, not as text');
const levelled = [
  student({ name: 'Ten' }),
  student({ name: 'One' }),
  student({ name: 'Two' }),
];
const levelBy = new Map([
  [levelled[0].id, 10],
  [levelled[1].id, 1],
  [levelled[2].id, 2],
]);
eq(
  'headings run 1, 2, 10',
  shape(run(levelled, { sort: 'level', levelByStudent: levelBy })).map(([title]) => title),
  ['students.levelN(1)', 'students.levelN(2)', 'students.levelN(10)'],
);
eq(
  'filtering on a level is exact',
  names(run(levelled, { level: '2', levelByStudent: levelBy })),
  ['Two'],
);
eq(
  'level 10 is not matched by "1"',
  names(run(levelled, { level: '1', levelByStudent: levelBy })),
  ['One'],
);

/* ------------------------------------------------------------------ score */

describe('score bands, and where the ungraded go');
const scored = [
  student({ name: 'Top', avgScore: 9.5 }),
  student({ name: 'Mid', avgScore: 7 }),
  student({ name: 'Low', avgScore: 4.2 }),
  student({ name: 'Ungraded' }),
  student({ name: 'Zero', avgScore: 0 }),
];
eq(
  'banded best first, ungraded last',
  shape(run(scored, { sort: 'score' })),
  [
    ['students.scoreBand(9,10)', ['Top']],
    ['students.scoreBand(7,8)', ['Mid']],
    ['students.scoreUnder(5)', ['Low', 'Zero']],
    ['students.noScore', ['Ungraded']],
  ],
);
check(
  'an ungraded student is not filed as failing',
  shape(run(scored, { sort: 'score' })).find(([, who]) => who.includes('Ungraded'))[0] ===
    'students.noScore',
);

/* ------------------------------------------------------------------ place */

describe('place and school sorts put the blanks at the end');
const placed = [
  student({ name: 'NoAddress' }),
  student({ name: 'Ashgabat', address: 'Aşgabat, Görogly köçesi 12' }),
  student({ name: 'Mary', address: 'Mary' }),
];
eq(
  'city taken from before the first comma, blanks last',
  shape(run(placed, { sort: 'place' })),
  [
    ['Aşgabat', ['Ashgabat']],
    ['Mary', ['Mary']],
    ['students.noPlace', ['NoAddress']],
  ],
);
const bySchool = shape(run(schools, { sort: 'school' }));
eq(
  'school sort merges the spellings the filter merges',
  bySchool.map(([, who]) => who),
  [['Aman', 'Baýram'], ['Çary'], ['Döwlet']],
);
check(
  'and puts the schoolless last',
  bySchool[bySchool.length - 1][0] === 'students.noSchool',
);
check(
  'each section has exactly one heading, not one per spelling',
  bySchool.length === 3,
  `${bySchool.length} sections: ${bySchool.map(([tt]) => tt).join(', ')}`,
);

/* -------------------------------------------------------- age, and gender */

describe('age bands need a birth date');
const aged = [
  student({ name: 'Young', birthDate: bornAgo(8) }),
  student({ name: 'Exam', birthDate: bornAgo(16) }),
  student({ name: 'NoDate' }),
];
eq('a band selects that band', names(run(aged, { age: '14to17' })), ['Exam']);
check(
  'a student with no birth date is in no band',
  !names(run(aged, { age: '18plus' })).includes('NoDate'),
  'silently including them would put children in the 18+ list',
);

describe('gender is read off the surname, not only the stored column');
const gendered = [
  student({ name: 'Aýna Myradowa', surname: 'Myradowa' }),
  student({ name: 'Serdar Myradow', surname: 'Myradow' }),
  student({ name: 'Alex Smith', surname: 'Smith' }),
];
eq('female by surname ending', names(run(gendered, { gender: 'female' })), ['Aýna Myradowa']);
eq('male by surname ending', names(run(gendered, { gender: 'male' })), ['Serdar Myradow']);
eq(
  '"not recorded" is the ones nothing can be read from',
  names(run(gendered, { gender: 'none' })),
  ['Alex Smith'],
);

/* ------------------------------------------------------------ combination */

describe('filters combine');
const mixed = [
  student({ name: 'Aman', school: 'Mekdep 20', phone: '', birthDate: bornAgo(15) }),
  student({ name: 'Baýram', school: 'Mekdep 20', phone: '65111111', birthDate: bornAgo(15) }),
  student({ name: 'Çary', school: 'Mekdep 21', phone: '', birthDate: bornAgo(15) }),
];
eq(
  'school and missing together',
  names(run(mixed, { school: schoolKey('Mekdep 20'), missing: 'phone' })),
  ['Aman'],
);
eq(
  'and an age band on top',
  names(run(mixed, { school: schoolKey('Mekdep 20'), missing: 'phone', age: 'under10' })),
  [],
);

/* ----------------------------------------------------------------- Search */

describe('the search box');
const searchable = [
  student({
    name: 'Aýgül Berdiýewa',
    phone: '+993 65 111111',
    parentName: 'Ogulgerek',
    parentPhone: '65 22 33 44',
    school: 'Mekdep 20',
    address: 'Aşgabat, Görogly 12',
  }),
  student({
    name: 'Serdar Myradow',
    phone: '65999999',
    parent2Phone: '+993 65 77 88 99',
    school: 'Mekdep 21',
  }),
  student({ name: 'John Smith', phone: '65000001', school: 'Mekdep 20' }),
];
const found = (query, over = {}) => names(run(searchable, { query, ...over }));

eq('a name', found('berdi'), ['Aýgül Berdiýewa']);
// The accented letters are the hard ones to type, so nobody types them.
eq('the same name with the accents left off', found('aygul'), ['Aýgül Berdiýewa']);
eq('and with them typed', found('aýgül'), ['Aýgül Berdiýewa']);
// The point of the whole exercise: an unknown number ringing the teacher.
eq('a mother’s number, as written on the record', found('65 22 33 44'), ['Aýgül Berdiýewa']);
eq('a mother’s number, run together', found('65223344'), ['Aýgül Berdiýewa']);
// Stored with the country code, typed without it — and the other way round.
eq('a father’s number, typed the short way', found('65778899'), ['Serdar Myradow']);
eq('and the long way', found('+993 65 22 33 44'), ['Aýgül Berdiýewa']);
// Siblings. Both are found, which is the honest answer to "whose number is
// this" — and the case the send has to reduce to one message. See
// `planRecipients` and tools/test-recipients.js.
eq(
  'a number two children share finds both',
  names(
    run(
      [
        student({ name: 'Elder', parentPhone: '65223344' }),
        student({ name: 'Younger', parentPhone: '+99365223344' }),
      ],
      { query: '65223344' },
    ),
  ),
  ['Elder', 'Younger'],
);
eq('the student’s own number still works', found('65999999'), ['Serdar Myradow']);
eq('a parent’s name', found('ogulgerek'), ['Aýgül Berdiýewa']);
eq('a school', found('mekdep 20'), ['Aýgül Berdiýewa', 'John Smith']);
eq('an address', found('gorogly'), ['Aýgül Berdiýewa']);
// Two words, each in a different field. The old search could not do this.
eq('two words across two fields', found('aygul mekdep'), ['Aýgül Berdiýewa']);
eq('every word has to hit something', found('aygul mekdep 21'), []);
eq('case is ignored', found('BERDI'), ['Aýgül Berdiýewa']);
eq('spaces around the query are ignored', found('   serdar  '), ['Serdar Myradow']);
eq('nothing matching finds nobody', found('zzzz'), []);
eq('an empty query keeps everybody', found('').length, 3);

// Group names come from the screen, not the record — see `groupNamesByStudent`.
eq(
  'a group name, when the screen supplies them',
  found('matematika', {
    groupNamesByStudent: new Map([[searchable[1].id, 'Matematika 9-njy synp']]),
  }),
  ['Serdar Myradow'],
);

// Search runs before the filters, not instead of them.
eq(
  'the search and a filter together',
  found('mekdep 20', { missing: 'parent' }),
  ['John Smith'],
);

/* -------------------------------------------------------------- Empty set */

describe('an empty roster');
eq('no sections rather than a crash', run([]), []);
eq('and none under any sort', run([], { sort: 'score' }), []);

console.log(failures ? `\n${failures} failure(s)` : '\nall passed');
process.exit(failures ? 1 : 0);
