/**
 * A class list as a spreadsheet.
 *
 * A `.classcare` backup moves an account between phones; this moves *students*
 * between ClassCare and the place a teacher already keeps them. Every tutor
 * arriving at this app has a list somewhere — a school's export, a notebook
 * typed into Excel, a WhatsApp message pasted into Sheets — and asking them to
 * retype sixty children with two parents each is asking them not to bother.
 *
 * ## Two formats, one path
 *
 * ClassCare *writes* `.xlsx`, because that is what a teacher means by "my
 * students in Excel": a file that opens into a proper sheet with headings and
 * columns, not one that lands in a single column because their copy of Excel
 * was installed in a locale that separates with semicolons.
 *
 * ClassCare *reads* both. The file a teacher has to hand is as often a `.csv` —
 * exported by a school system, saved out of Google Sheets — and refusing it
 * would be refusing the very list this feature exists to accept.
 *
 * Both formats reduce to rows of strings before anything else happens, so the
 * column matching, the date handling and the import rules are written once and
 * cannot drift between the two. The rules themselves — which row is which
 * student, documents, terms — live in `lib/rosterImport.ts`, where they can be
 * tested without a phone.
 *
 * ## Reading is deliberately more forgiving than writing
 *
 * The CSV delimiter is sniffed — comma, semicolon or tab — because an Excel
 * installed in a Russian locale writes semicolons and its owner has no idea
 * that it does. Column order is not assumed either; headings are matched by
 * name, in any of the three languages, so a teacher can hand us the file their
 * school gave them.
 *
 * ## What travels, and what deliberately does not
 *
 * Everything on a student except the photograph, which is a picture and not a
 * cell — pictures are added by hand afterwards, and a column of base64 would
 * make the file unreadable in the tool it exists to be read in.
 *
 * ## Classes are added, never taken away
 *
 * A name in the Groups cell puts the student in that class — joining the
 * existing one, or creating it when there is no class by that name. A name
 * *missing* from the cell does nothing at all. That single rule is what makes
 * the column safe: there is no sequence of imports that can cost a student a
 * course they have done, because nothing here can remove them from anything.
 *
 * The Term cell says which intake those classes are. "Matematika A2" in the
 * summer and in the autumn are two groups, and the cell is how a file tells
 * them apart.
 *
 * The id column is read but never written — see `readOnly` on `Column`.
 */
import Papa from 'papaparse';

import { flushAll } from '@/data/persistence';
import { useStore } from '@/data/store';
import type { Group, Student } from '@/data/types';
import { translateNow } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n';
import { levelOf } from '@/lib/courses';
import { GROUP_SEP, splitGroups } from '@/lib/groupNames';
import { genderFromSurname, joinName, splitName, surnameOf } from '@/lib/names';
import { documentKindForAge } from '@/lib/studentDocs';
import {
  changesFor,
  groupResolver,
  planImport,
  type ImportPlan,
  type ParsedStudent,
} from '@/lib/rosterImport';
import { chosenTerm, termLabel, termOf } from '@/lib/term';
import { accentNames } from '@/theme';
import { readXlsx, serialToDate, writeXlsx } from '@/lib/xlsx';
import { strFromU8 } from 'fflate';

export type { ParsedStudent } from '@/lib/rosterImport';

/* -------------------------------------------------------------------------- */
/* Columns                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One column, and every spelling of it we will answer to.
 *
 * `aliases` are lower-cased and stripped of spaces and punctuation before
 * comparison, so "Parent phone", "parent_phone" and "PARENT PHONE" are one
 * thing. The translated headings are included so a file this app exported in
 * Turkmen can be imported by the same app in Russian — which is not exotic:
 * it is one teacher who changed the language.
 *
 * No alias may appear under two columns: a heading is claimed by the first
 * column that wants it, and the second would silently read nothing.
 */
type Column = {
  key: keyof CsvRow;
  headingKey: TranslationKey;
  aliases: string[];
  /**
   * Read but never written.
   *
   * The `id` column is one. Ids are the app's business — a teacher cannot
   * invent one, and a column of them in a file they are meant to type into is
   * a column of noise they have to scroll past, or worse, edit. Reading it
   * stays, because a file exported by an older version has it, and an id says
   * "this is the same student" outright.
   *
   * The combined "passport / birth certificate" column is the other: files
   * written before the two were separated have it and must keep importing.
   */
  readOnly?: boolean;
};

type CsvRow = {
  id: string;
  name: string;
  surname: string;
  patronymic: string;
  phone: string;
  email: string;
  birthDate: string;
  address: string;
  school: string;
  term: string;
  groups: string;
  level: string;
  passport: string;
  birthCertificate: string;
  documentEither: string;
  code: string;
  parentName: string;
  parentPhone: string;
  parentEmail: string;
  parentWork: string;
  parent2Name: string;
  parent2Phone: string;
  parent2Email: string;
  parent2Work: string;
  note: string;
};

const COLUMNS: Column[] = [
  { key: 'id', headingKey: 'csv.id', aliases: ['id', 'studentid'], readOnly: true },
  { key: 'name', headingKey: 'csv.name', aliases: ['name', 'fullname', 'student', 'ady', 'имя', 'фио'] },
  {
    key: 'surname',
    headingKey: 'students.surname',
    aliases: ['surname', 'lastname', 'familyname', 'familiya', 'familiýasy', 'фамилия'],
  },
  /*
    The father's name, sitting where it is spoken: after the surname and before
    anything else.

    Its aliases deliberately exclude `fathername`, which belongs to the father
    *as a contact* further along. The two are different facts — one is part of
    the child's name, the other is a man with a phone number — and a file whose
    heading matched both would put a patronymic in the parent column, or the
    reverse, without saying so.
  */
  {
    key: 'patronymic',
    headingKey: 'students.patronymic',
    aliases: [
      'patronymic',
      'middlename',
      'fathersname',
      'atasynynady',
      'atasynyňady',
      'atasyady',
      'отчество',
    ],
  },
  { key: 'phone', headingKey: 'csv.phone', aliases: ['phone', 'mobile', 'telefon', 'телефон'] },
  { key: 'email', headingKey: 'csv.email', aliases: ['email', 'mail', 'эл почта', 'почта'] },
  {
    key: 'birthDate',
    headingKey: 'csv.birthDate',
    aliases: ['birthdate', 'birthday', 'dob', 'dateofbirth', 'dogangüni', 'дата рождения'],
  },
  { key: 'address', headingKey: 'csv.address', aliases: ['address', 'salgy', 'адрес'] },
  { key: 'school', headingKey: 'csv.school', aliases: ['school', 'mekdep', 'школа'] },
  /*
    Which intake the row's classes belong to — "Tomus 2026", "Summer term",
    "Лето". Read by `parseTermCell`, which finds the season in any of the
    three languages and works out the year when the cell leaves it off.
  */
  {
    key: 'term',
    headingKey: 'csv.term',
    aliases: [
      'term',
      'season',
      'semester',
      'möwsüm',
      'mowsum',
      'döwür',
      'dowur',
      'сезон',
      'семестр',
      'период',
      'четверть',
    ],
  },
  /*
    The classes a student is in, one cell, separated by commas.

    Read as instructions to join, never as the complete list — see the note at
    the top of this file. Written out in full, archived courses included,
    because the file is then a true record of what a student has done and
    re-importing it cannot do any harm.
  */
  {
    key: 'groups',
    headingKey: 'csv.groups',
    aliases: [
      'group',
      'groups',
      'class',
      'classes',
      'topar',
      'toparlar',
      'группа',
      'группы',
      'класс',
      'классы',
    ],
  },
  {
    key: 'level',
    headingKey: 'students.level',
    aliases: ['level', 'dereje', 'derejesi', 'уровень'],
  },
  /*
    Two columns where there used to be one, because the app now has to know
    which document a number is: a passport from sixteen, a birth certificate
    before it. A teacher fills whichever the child has. A row with both — a
    school export carrying every document a child ever had — is settled by the
    birth date, the same way the form settles it.
  */
  {
    key: 'passport',
    headingKey: 'csv.passport',
    aliases: [
      'passport',
      'passportnumber',
      'passportno',
      'pasport',
      'pasportbelgisi',
      'паспорт',
      'номерпаспорта',
    ],
  },
  {
    key: 'birthCertificate',
    headingKey: 'csv.birthCertificate',
    aliases: [
      'birthcertificate',
      'birthcertificatenumber',
      'birthcertificateno',
      'şahadatnama',
      'sahadatnama',
      'dogluşşahadatnamasy',
      'doglussahadatnamasy',
      'свидетельство',
      'свидетельствоорождении',
      'номерсвидетельства',
    ],
  },
  /*
    The single column older files have, under all three of its old headings.
    Which document it holds is decided by the age — see `documentOfRow`.
  */
  {
    key: 'documentEither',
    headingKey: 'csv.documentId',
    readOnly: true,
    aliases: [
      'document',
      'documentid',
      'resminama',
      'документ',
      'passportbirthcertificateid',
      'passportbirthcertificate',
      'pasportşahadatnamabelgisi',
      'паспортсвидетельствоорождении',
      'паспортсвидетельство',
    ],
  },
  /*
    The code the app made for a student who came with no document.

    Written so a file that goes out and comes back keeps every student's code —
    and with it, an exact match for each of them on the way back in, however
    many share a name.
  */
  {
    key: 'code',
    headingKey: 'csv.studentCode',
    aliases: ['classcareid', 'classcarekod', 'classcarekody', 'classcareкод', 'кодclasscare'],
  },
  {
    key: 'parentName',
    headingKey: 'csv.motherName',
    aliases: ['mother', 'mothername', 'parent', 'parentname', 'parent1', 'eje', 'мама', 'мать'],
  },
  {
    key: 'parentPhone',
    headingKey: 'csv.motherPhone',
    aliases: ['motherphone', 'parentphone', 'parent1phone', 'телефон мамы'],
  },
  {
    key: 'parentEmail',
    headingKey: 'csv.motherEmail',
    aliases: ['motheremail', 'parentemail', 'parent1email'],
  },
  {
    key: 'parentWork',
    headingKey: 'csv.motherWork',
    aliases: ['motherwork', 'parentwork', 'parent1work', 'работа мамы'],
  },
  {
    key: 'parent2Name',
    headingKey: 'csv.fatherName',
    aliases: ['father', 'fathername', 'parent2', 'parent2name', 'kaka', 'папа', 'отец'],
  },
  {
    key: 'parent2Phone',
    headingKey: 'csv.fatherPhone',
    aliases: ['fatherphone', 'parent2phone', 'телефон папы'],
  },
  { key: 'parent2Email', headingKey: 'csv.fatherEmail', aliases: ['fatheremail', 'parent2email'] },
  {
    key: 'parent2Work',
    headingKey: 'csv.fatherWork',
    aliases: ['fatherwork', 'parent2work', 'работа папы'],
  },
  { key: 'note', headingKey: 'csv.note', aliases: ['note', 'notes', 'bellik', 'заметка'] },
];

/**
 * Comparison form for a heading: no case, no spaces, no punctuation.
 *
 * Apostrophes go too, and both shapes of them. A heading of "Father's name"
 * arrives typed straight in one file and curled by Word's autocorrect in the
 * next, and they are the same column. So does the slash, which only ever turns
 * up separating two names for one thing — "Passport / birth certificate ID" —
 * and the numero sign, which Russian headings put in front of numbers.
 */
const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s_\-.'’\/№#]/g, '')
    .trim();

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/** The columns this app writes, which is every column a teacher can fill in. */
const WRITTEN = COLUMNS.filter((c) => !c.readOnly);

/** The heading row, in whichever language the teacher is reading the app in. */
const headingRow = () => WRITTEN.map((c) => translateNow(c.headingKey));

/**
 * The term to write for a student: the one all their written classes share.
 *
 * A student in classes from two terms has no single answer, and writing one of
 * them would file the other class under it on the way back in. Blank is
 * honest — and harmless, because the class names in the row already exist and
 * resolve to themselves.
 */
function termCellFor(student: Student, groups: Group[]): string {
  const terms = new Set(
    groups.filter((g) => student.groupIds.includes(g.id)).map((g) => chosenTerm(g) ?? ''),
  );
  if (terms.size !== 1) return '';
  const [term] = [...terms];
  return term ? termLabel(term, translateNow) : '';
}

/** One student flattened to the cell order the headings promise. */
function rowFor(student: Student, groups: Group[]): string[] {
  // A number saved before the kind was recorded goes where the age says it
  // belongs, and under passport when there is no age to go by.
  const kind =
    student.documentKind ??
    (student.documentId ? (documentKindForAge(student.birthDate) ?? 'passport') : undefined);
  const row: CsvRow = {
    // Present in the shape, absent from the file: `WRITTEN` drops it on the way
    // out. Keeping it here means the row type stays one thing for reading and
    // writing both.
    id: student.id,
    // The full name stays whole in its own column, so a file opened in Excel
    // still reads as a register. The surname is repeated beside it because
    // that is the column a teacher fills in for a new child.
    name: student.name,
    surname: surnameOf(student),
    patronymic: student.patronymic ?? '',
    phone: student.phone,
    email: student.email ?? '',
    birthDate: student.birthDate ?? '',
    address: student.address ?? '',
    school: student.school ?? '',
    term: termCellFor(student, groups),
    groups: groups
      .filter((g) => student.groupIds.includes(g.id))
      .map((g) => g.name)
      .join(GROUP_SEP),
    // The level as a teacher reads it, not the base stored behind it. A column
    // of bases would be a column of numbers that do not match the app.
    level: String(levelOf(student, groups)),
    // Each number in its own column, so it reads back as the same document.
    passport: kind === 'passport' ? (student.documentId ?? '') : '',
    birthCertificate: kind === 'birthCertificate' ? (student.documentId ?? '') : '',
    documentEither: '',
    code: kind === 'generated' ? (student.documentId ?? '') : '',
    parentName: student.parentName ?? '',
    parentPhone: student.parentPhone ?? '',
    parentEmail: student.parentEmail ?? '',
    parentWork: student.parentWork ?? '',
    parent2Name: student.parent2Name ?? '',
    parent2Phone: student.parent2Phone ?? '',
    parent2Email: student.parent2Email ?? '',
    parent2Work: student.parent2Work ?? '',
    note: student.note ?? '',
  };
  return WRITTEN.map((c) => row[c.key]);
}

/** The whole roster as an Excel workbook. */
export function studentsToXlsx(students: Student[], groups: Group[]): Uint8Array {
  return writeXlsx([headingRow(), ...students.map((s) => rowFor(s, groups))]);
}

/**
 * A workbook with the right headings and rows showing what goes in them.
 *
 * Offered whenever an import fails, because "could not read that file" on its
 * own leaves the teacher guessing at column names — and they will guess wrong,
 * try again, and give up. A sample they can open in Excel and type over turns a
 * dead end into a two-minute job.
 *
 * Three rows. A child under sixteen with every column filled, so each column has
 * something to copy the shape of — including a birth certificate, because that
 * is what a child that age has. An adult with a passport, so both document
 * columns are shown in use. And a row with only a name and a number, which is
 * the part a teacher cannot otherwise know: everything else is optional, and a
 * student with no document is given a code of their own.
 */
export function sampleStudentsXlsx(): Uint8Array {
  const year = new Date().getFullYear();
  const term = termLabel(termOf(new Date().toISOString().slice(0, 10)), translateNow);

  const child: CsvRow = {
    // Never reaches the file — see `readOnly` on the column.
    id: '',
    name: 'Aýgül Berdiýewa',
    // Filled in here, though a teacher may leave it and put the whole name in
    // the column to the left. It is what the app reads the gender from.
    surname: 'Berdiýewa',
    // The father's name, not the father. He is further along, with his number.
    patronymic: 'Serdar',
    phone: '+993 65 123456',
    email: 'aygul@example.com',
    birthDate: `${year - 12}-03-15`,
    address: 'Görogly köçesi 12',
    school: '№ 20',
    term,
    // Two classes, comma separated. A name that matches a class in that term
    // puts the student in it; a name that matches nothing makes it.
    groups: `Matematika A2${GROUP_SEP}Iňlis dili B1`,
    // The level as the teacher reads it. Blank means "count it from the
    // courses in this app", which is right for anyone who started here.
    level: '2',
    passport: '',
    birthCertificate: 'I-AŞ 123456',
    documentEither: '',
    code: '',
    parentName: 'Maýa Berdiýewa',
    parentPhone: '+993 65 654321',
    parentEmail: 'maya@example.com',
    parentWork: 'Lukman',
    parent2Name: 'Serdar Berdiýew',
    parent2Phone: '+993 65 111222',
    parent2Email: '',
    parent2Work: 'Mugallym',
    note: '',
  };

  const adult: CsvRow = {
    ...blankRow(),
    name: 'Merdan Orazow',
    surname: 'Orazow',
    phone: '+993 61 445566',
    birthDate: `${year - 19}-09-02`,
    term,
    groups: 'Iňlis dili B1',
    passport: 'I-AŞ 654321',
  };

  // The part a teacher cannot otherwise guess: a name and a number are enough.
  const minimal: CsvRow = { ...blankRow(), name: 'Batyr Amanow', phone: '+993 65 777888' };

  return writeXlsx([
    headingRow(),
    WRITTEN.map((c) => child[c.key]),
    WRITTEN.map((c) => adult[c.key]),
    WRITTEN.map((c) => minimal[c.key]),
  ]);
}

const blankRow = (): CsvRow =>
  Object.fromEntries(COLUMNS.map((c) => [c.key, ''])) as unknown as CsvRow;

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export class SheetError extends Error {
  constructor(readonly reason: 'empty' | 'noName' | 'unreadable') {
    super(reason);
  }
}

/**
 * Split a CSV document into rows of cells.
 *
 * PapaParse rather than the parser that used to be written out here. That one
 * handled quotes and embedded newlines, and missed a file whose lines end in a
 * bare carriage return — which is what Excel for Mac and several school systems
 * write. It read the whole file as one row with a thousand columns, found no
 * name heading, and said the file was unreadable. Papa recognises every line
 * ending, sniffs comma, semicolon and tab from the data rather than the heading
 * alone, and does it in a single pass that stays quick at thousands of rows.
 */
function parseCsv(text: string): string[][] {
  const { data } = Papa.parse<string[]>(text.replace(/^﻿/, ''), {
    // Empty means "detect", across comma, tab, semicolon and pipe.
    delimiter: '',
    skipEmptyLines: 'greedy',
  });
  return data.map((row) => row.map((cell) => (cell ?? '').toString()));
}

/**
 * A file the teacher chose, as rows, whichever of the two formats it is.
 *
 * Sniffed from the bytes rather than trusted to the extension: Android file
 * managers hand a `.xlsx` over as `application/octet-stream` often enough, and
 * a teacher who renamed a file is not wrong about what is in it. `PK` is the
 * zip signature every Office document starts with.
 */
export function rowsFromFile(bytes: Uint8Array): string[][] {
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;

  if (isZip) {
    try {
      return readXlsx(bytes);
    } catch {
      // A zip that is not a workbook — a `.zip` of something else, or a file
      // that did not finish downloading.
      throw new SheetError('unreadable');
    }
  }

  /*
    `strFromU8` rather than `TextDecoder`.

    Hermes does not ship `TextDecoder`, and React Native does not polyfill it,
    so the obvious line would work in the simulator and throw on a phone. This
    comes from the zip library that is already here and decodes UTF-8 properly,
    which matters for every name in the file.
  */
  return parseCsv(strFromU8(bytes));
}

/**
 * A level cell, or nothing.
 *
 * Blank means "count it", not zero, so the column can be left out entirely by
 * the many teachers who will never think about it. Anything that is not a
 * plain non-negative number is ignored rather than guessed at: a file saying
 * "beginner" in this column should leave the counting alone, not reset it.
 */
function levelFrom(raw: string): number | undefined {
  const v = raw.trim();
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined;
}

/** Read a spreadsheet into students, without touching the store. */
export function studentsFromRows(rows: string[][]): ParsedStudent[] {
  if (rows.length < 2) throw new SheetError('empty');

  /*
    Headings decide the columns, not their order.

    A file from a school will not have our column order and asking a teacher to
    rearrange twenty columns in Excel before importing is asking them to give
    up. Anything we do not recognise is ignored rather than refused: a school's
    export carries a dozen fields this app has nowhere to put.

    A heading is claimed once. Two columns that both answered to it would leave
    the second reading the first one's cells.
  */
  const headings = rows[0].map((h) => normalise(String(h ?? '')));
  const index: Partial<Record<keyof CsvRow, number>> = {};
  const claimed = new Set<number>();

  for (const column of COLUMNS) {
    const wanted = new Set([
      normalise(translateNow(column.headingKey)),
      ...column.aliases.map(normalise),
    ]);
    const at = headings.findIndex((h, i) => !claimed.has(i) && wanted.has(h));
    if (at >= 0) {
      index[column.key] = at;
      claimed.add(at);
    }
  }

  if (index.name === undefined && index.surname === undefined) throw new SheetError('noName');

  const value = (row: string[], key: keyof CsvRow) => {
    const at = index[key];
    return at === undefined ? '' : String(row[at] ?? '').trim();
  };

  /**
   * A phone number, with the `+` a spreadsheet ate put back.
   *
   * Excel reads a leading `+` as the start of a formula: type `+99365000000`
   * and it evaluates it, stores the number 99365000000, and the plus is gone
   * from the file before it is ever saved. Our own template formats those
   * columns as text so it cannot happen again — but the file a teacher already
   * has was written before that, or by a school system, or by Excel on someone
   * else's laptop.
   *
   * Ten digits is the line. Numbers here are eight digits locally and eleven or
   * twelve with the country code, so a bare run of ten or more digits is an
   * international number missing its plus, and a shorter one is a local number
   * that never had one. Anything already carrying a `+`, a space or a bracket
   * is left exactly as the teacher wrote it.
   */
  const phone = (raw: string) => {
    const v = raw.trim();
    return /^\d{10,}$/.test(v) ? `+${v}` : v;
  };

  /** Empty strings become absent, so a blank cell does not overwrite with "". */
  const maybe = (v: string) => (v.length ? v : undefined);

  const out: ParsedStudent[] = [];

  rows.slice(1).forEach((row, i) => {
    /*
      Two columns, and either one on its own is enough.

      A file this app wrote has both. A file a school wrote has one column with
      the whole name in it, and a teacher filling in the template may put the
      surname in its own column and leave the name column for the given name —
      which is what the headings invite. All three have to land as the same
      student:

        Name "Aýgül Berdiýewa", Surname ""            -> split it
        Name "Aýgül",           Surname "Berdiýewa"   -> join it
        Name "Aýgül Berdiýewa", Surname "Berdiýewa"   -> already whole

      The last case is the one that needs care: joining blindly would produce
      "Aýgül Berdiýewa Berdiýewa".
    */
    const nameCell = value(row, 'name');
    const surnameCell = value(row, 'surname');
    if (!nameCell && !surnameCell) return; // A row with neither is a spacer.

    const alreadyWhole =
      !!surnameCell && nameCell.toLowerCase().endsWith(surnameCell.toLowerCase());
    const name =
      alreadyWhole || !surnameCell
        ? nameCell
        : nameCell
          ? joinName(nameCell, surnameCell)
          : surnameCell;
    const surname = surnameCell || splitName(nameCell).surname;

    out.push({
      // The heading is line 1, so the first data row is line 2 — the number
      // Excel shows beside it.
      line: i + 2,
      sourceId: maybe(value(row, 'id')),
      groupNames: splitGroups(value(row, 'groups')),
      level: levelFrom(value(row, 'level')),
      termCell: value(row, 'term'),
      documents: {
        passport: value(row, 'passport'),
        birthCertificate: value(row, 'birthCertificate'),
        either: value(row, 'documentEither'),
        code: value(row, 'code'),
      },
      student: {
        name,
        surname: maybe(surname),
        patronymic: maybe(value(row, 'patronymic')),
        phone: phone(value(row, 'phone')),
        email: maybe(value(row, 'email')),
        birthDate: normaliseDate(value(row, 'birthDate')),
        address: maybe(value(row, 'address')),
        school: maybe(value(row, 'school')),
        // Read from the surname rather than asked for. A Turkmen surname says
        // which, in both scripts, and a column for it was a column of sixty
        // cells holding a fact already present two columns to the left.
        gender: genderFromSurname(surname),
        parentName: maybe(value(row, 'parentName')),
        parentPhone: maybe(phone(value(row, 'parentPhone'))),
        parentEmail: maybe(value(row, 'parentEmail')),
        parentWork: maybe(value(row, 'parentWork')),
        parent2Name: maybe(value(row, 'parent2Name')),
        parent2Phone: maybe(phone(value(row, 'parent2Phone'))),
        parent2Email: maybe(value(row, 'parent2Email')),
        parent2Work: maybe(value(row, 'parent2Work')),
        note: maybe(value(row, 'note')),
        accent: accentNames[out.length % accentNames.length],
      },
    });
  });

  return out;
}

/**
 * A birth date the app can use, from whatever the spreadsheet had in the cell.
 *
 * Excel hands back `15/03/2011`, `2011-03-15` or `15.03.2011` depending on the
 * machine it was typed on, and the birthday reminder needs one shape. Anything
 * unrecognisable is dropped rather than guessed: a wrong birthday sends a
 * cheerful notification on a stranger's date, which is worse than none.
 *
 * Day-first is assumed for the ambiguous `03/04/2011`, because that is how
 * dates are written across the region this app is for.
 */
function normaliseDate(raw: string): string | undefined {
  const value = raw.trim();
  if (!value) return undefined;

  /*
    A bare number is Excel's own way of writing a date.

    A teacher who formats the birthday column as a date — which Excel does by
    itself the moment something looks like one — stores `40617`, not a string.
    Without this the column fills with five-digit numbers and every birthday
    reminder is wrong. Bounded inside `serialToDate`, so a phone number typed
    into the wrong column is left alone rather than becoming a date in the year
    180000.
  */
  if (/^\d+(\.\d+)?$/.test(value)) return serialToDate(value) ?? undefined;

  const iso = value.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return pad(+iso[1], +iso[2], +iso[3]);

  const dmy = value.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dmy) return pad(+dmy[3], +dmy[2], +dmy[1]);

  return undefined;
}

function pad(year: number, month: number, day: number): string | undefined {
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/* -------------------------------------------------------------------------- */
/* Applying                                                                   */
/* -------------------------------------------------------------------------- */

export type ImportOutcome = {
  added: number;
  updated: number;
  removed: number;
  /**
   * Students a replace left out of the file but did not delete, because they
   * have a finished course behind them.
   */
  keptForHistory: number;
  /** Classes the file named that this account did not have, so they were made. */
  groupsCreated: number;
  /** Classes that were waiting for a term and were given the file's. */
  groupsAdopted: number;
  /** Memberships added. Counted per student per class, and never removed. */
  joined: number;
  /** Students added to no class at all. */
  noClass: number;
  /** Codes generated for students who arrived with no document. */
  generated: number;
  /** Rows folded into an earlier row for the same student. */
  mergedInFile: number;
  /** Rows refused: their number belongs to somebody else. */
  conflicts: ImportPlan['conflicts'];
  /** Rows for another term, when importing into one. */
  otherTerm: number;
  /** Rows whose Term cell could not be read, when importing into one. */
  unreadableTerm: number;
};

/**
 * Work out what an import would do, without doing it.
 *
 * Split from applying so the confirmation can say how many of the file's rows
 * belong to the term being imported into before the teacher commits to it.
 */
export function previewStudentSheet(parsed: ParsedStudent[], term?: string): ImportPlan {
  const { students } = useStore.getState();
  return planImport({ parsed, students, scopeTerm: term });
}

/**
 * Put parsed students into the store.
 *
 * `mode` is the teacher's answer to what happens to the people already here.
 * `merge` updates the ones the file recognises and adds the rest; `replace`
 * makes the file the roster: students in it keep their identity and everything
 * the file does not carry, and only students absent from it go. A student
 * deleted and re-added would lose their photograph, which is not in the file
 * and cannot come back from it.
 *
 * `term` imports into one term: the file's rows for other terms are left out,
 * and the classes the rows name are that term's classes.
 *
 * An id is kept only when this account already holds it. A file from another
 * teacher's ClassCare carries their ids, and those belong to their account on
 * the server — the same lesson `reownBackup` learned.
 */
export async function applyStudentSheet(
  parsed: ParsedStudent[],
  mode: 'merge' | 'replace',
  { term }: { term?: string } = {},
): Promise<ImportOutcome> {
  const state = useStore.getState();
  const plan = planImport({ parsed, students: state.students, scopeTerm: term });

  /*
    Class names to class ids, making the ones that are not here yet.

    Built once and mutated as it goes, so twenty rows naming the same new class
    create one class and all twenty join it — resolving each row against the
    store on its own would create twenty classes with the same name.

    A class the file makes has a name and a term and nothing else. No days, no
    room: the file did not say, and inventing a Monday four o'clock would put
    sessions in the teacher's calendar that nobody agreed to. With no term in
    the row it has no term either, and shows under "no term yet" until it is
    given one — a guess put there silently is a guess nobody goes back to.
  */
  const resolver = groupResolver(state.groups, {
    create: (name, inTerm) =>
      useStore.getState().addGroup({
        name,
        subject: '',
        room: '',
        slots: [],
        ...(inTerm ? { term: inTerm } : {}),
      }),
    adopt: (groupId, inTerm) => useStore.getState().updateGroup(groupId, { term: inTerm }),
  });

  const changes = changesFor({
    plan,
    students: state.students,
    groups: () => useStore.getState().groups,
    mode,
    resolve: resolver.resolve,
  });

  // Removals first, so a replace frees any number a departing student held
  // before the file's students claim it — on the server, archiving releases a
  // number from the uniqueness index.
  for (const id of changes.removeIds) useStore.getState().removeStudent(id);

  useStore.getState().importStudents({ adds: changes.adds, updates: changes.updates });

  /*
    Straight to disk, rather than waiting for the debounce.

    Every other write in the app can afford to be coalesced for a few hundred
    milliseconds. An import cannot: hundreds of students arrive in one go and
    the teacher's very next act is often to close the app, sign out, or hand the
    phone to somebody — and Android kills a backgrounded app freely on the
    hardware these teachers carry.
  */
  await flushAll();

  return {
    added: changes.adds.length,
    updated: changes.updates.length,
    removed: changes.removeIds.length,
    keptForHistory: changes.keptForHistory,
    groupsCreated: resolver.counts.created,
    groupsAdopted: resolver.counts.adopted,
    joined: changes.joined,
    noClass: changes.noClass,
    generated: plan.generated,
    mergedInFile: plan.mergedInFile,
    conflicts: plan.conflicts,
    otherTerm: plan.otherTerm,
    unreadableTerm: plan.unreadableTerm,
  };
}
