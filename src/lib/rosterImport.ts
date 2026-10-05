/**
 * What an import of a class list will do, worked out before it does anything.
 *
 * `data/studentsSheet.ts` reads a file into rows and puts the result into the
 * store. Everything in between — which row is which student, which rows are the
 * same student twice, what document each one has, which term its classes
 * belong to, which classes to make — is decided here, on plain data, with no
 * store and no React. That is what lets it be run against a thousand invented
 * students in `tools/test-student-import.js` rather than trusted.
 *
 * ## One student, one document
 *
 * Names repeat and phone numbers are shared, so neither can say on its own that
 * two rows are one child. A passport or birth certificate number can. Matching
 * goes by it first, and two rows with different numbers are never one student
 * however alike their names are — that is the case of two children called the
 * same thing, and they stay two.
 *
 * A row without any number gets a generated one, so every student ends up with
 * something unique to be told apart by; see `generateCode`.
 */
import type { DocumentKind, Group, Student } from '@/data/types';
import { baseForLevel, studentCourses } from '@/lib/courses';
import { groupKey, indexGroupsByName, mergeGroupIds } from '@/lib/groupNames';
import {
  documentKey,
  documentKindForAge,
  generateCode,
  isGeneratedCode,
  namesCompatible,
} from '@/lib/studentDocs';
import { chosenTerm, parseTermCell } from '@/lib/term';

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

/** The document cells of one row, as they were in the file. */
export type DocumentCells = {
  passport: string;
  birthCertificate: string;
  /** The single "passport / birth certificate" column older files have. */
  either: string;
  /** The ClassCare ID column — a code this app generated, when it wrote the file. */
  code: string;
};

export type ParsedStudent = {
  /** Row number in the file, heading included, so messages can point at it. */
  line: number;
  /** The id from the file, when it carried one. Never trusted blindly. */
  sourceId?: string;
  /** Everything but the document, which is chosen from `documents`. */
  student: Omit<Student, 'id' | 'groupIds' | 'documentId' | 'documentKind'>;
  /**
   * The classes named in the row, as written. Names, because the file cannot
   * know an id; resolved against the account when the import runs.
   *
   * Empty means the row said nothing about classes, which is not the same as
   * saying the student is in none: nothing happens to their memberships.
   */
  groupNames: string[];
  /** The level as the file states it, before it is turned into a stored base. */
  level?: number;
  /** The Term cell as written, or empty. */
  termCell: string;
  documents: DocumentCells;
};

type Doc = { id: string; kind?: DocumentKind };

/** A class a row names, with the term it was named in. */
export type GroupRef = { name: string; term?: string };

export type PlannedRow = {
  /** The row, with any later rows for the same student folded into it. */
  parsed: ParsedStudent;
  /** Every class the row asks for, each with its term. */
  groups: GroupRef[];
  /** The student already on the roster that this row is. */
  existingId?: string;
  /**
   * The document to store. Absent means leave the student's own alone — a
   * matched row with no number in it says nothing about the one on file.
   */
  document?: Doc;
};

export type ImportPlan = {
  rows: PlannedRow[];
  /** Rows naming another term, left out of a term's own import. */
  otherTerm: number;
  /** Rows whose Term cell names no season at all, left out of a term's import. */
  unreadableTerm: number;
  /** Rows folded into an earlier row for the same student. */
  mergedInFile: number;
  /**
   * Rows refused because their number belongs to somebody with a different
   * name. One mistyped digit can make a passport point at a stranger, and
   * overwriting the stranger's record would be the worst thing this could do.
   */
  conflicts: { line: number; name: string; owner: string }[];
  /**
   * Students whose number a refused row carried. A replace must not remove
   * them for being absent from the file: the row that named them was refused,
   * not missing.
   */
  protectedIds: string[];
  /** Codes generated for students who had no document. */
  generated: number;
};

/* -------------------------------------------------------------------------- */
/* Choosing a row's document                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The document a row carries, from whichever columns the file had.
 *
 * Separate passport and birth certificate columns say which is which. When a
 * row fills both — a school export that carries every document a child ever had
 * — the age decides, as it does on the form. The single combined column older
 * files have says nothing about which it is, so the age decides that too, and
 * an unknown age leaves the kind unknown rather than guessing.
 *
 * A code this app generated is recognised wherever it appears, so a file that
 * went out and came back keeps every student's code.
 */
export function documentOfRow(
  row: Pick<ParsedStudent, 'documents' | 'student'>,
  today = new Date(),
): Doc | null {
  const passport = row.documents.passport.trim();
  const birth = row.documents.birthCertificate.trim();
  const either = row.documents.either.trim();
  const code = row.documents.code.trim();
  const byAge = documentKindForAge(row.student.birthDate, today);

  const generated = (raw: string): Doc => ({ id: raw.toUpperCase(), kind: 'generated' });

  if (passport && birth) {
    return byAge === 'birthCertificate'
      ? { id: birth, kind: 'birthCertificate' }
      : { id: passport, kind: 'passport' };
  }
  if (passport) return isGeneratedCode(passport) ? generated(passport) : { id: passport, kind: 'passport' };
  if (birth) return isGeneratedCode(birth) ? generated(birth) : { id: birth, kind: 'birthCertificate' };
  if (either) return isGeneratedCode(either) ? generated(either) : { id: either, kind: byAge ?? undefined };
  if (code && isGeneratedCode(code)) return generated(code);
  return null;
}

/* -------------------------------------------------------------------------- */
/* Planning                                                                   */
/* -------------------------------------------------------------------------- */

const digitsOf = (s: string | undefined) => (s ?? '').replace(/\D/g, '');
const nameKey = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Do two documents say these are different people?
 *
 * Only when both have one and they differ — and only when they are the same
 * sort of thing. A real number against a generated code is not a disagreement:
 * the code was made because the student had no number at the time, and the
 * number arriving now is that student's. Two different real numbers, or two
 * different codes, are two different people.
 */
function documentsDisagree(a: string | undefined, b: string | undefined): boolean {
  const ka = documentKey(a);
  const kb = documentKey(b);
  if (!ka || !kb || ka === kb) return false;
  return isGeneratedCode(a) === isGeneratedCode(b);
}

/** Fill the gaps in `into` from `from`. The first row's values win. */
function mergeRow(into: Entry, from: Entry) {
  const a = into.parsed.student as Record<string, unknown>;
  const b = from.parsed.student as Record<string, unknown>;
  for (const key of Object.keys(b)) {
    const empty = a[key] === undefined || a[key] === '';
    if (empty && b[key] !== undefined && b[key] !== '') a[key] = b[key];
  }
  into.parsed.level ??= from.parsed.level;
  into.parsed.sourceId ??= from.parsed.sourceId;
  for (const ref of from.groups) {
    if (!into.groups.some((g) => g.term === ref.term && groupKey(g.name) === groupKey(ref.name))) {
      into.groups.push(ref);
    }
  }
  if (!into.doc && from.doc) {
    into.doc = from.doc;
    into.key = from.key;
  }
}

type Entry = {
  parsed: ParsedStudent;
  groups: GroupRef[];
  doc: Doc | null;
  key: string;
  existingId?: string;
  dropped?: boolean;
};

export function planImport({
  parsed,
  students,
  scopeTerm,
  today = new Date(),
  random = Math.random,
}: {
  parsed: ParsedStudent[];
  /** The roster as it stands — active students only. */
  students: Student[];
  /** Importing into this term: rows for any other are left out. */
  scopeTerm?: string;
  today?: Date;
  random?: () => number;
}): ImportPlan {
  const plan: ImportPlan = {
    rows: [],
    otherTerm: 0,
    unreadableTerm: 0,
    mergedInFile: 0,
    conflicts: [],
    protectedIds: [],
    generated: 0,
  };

  /*
    1. Terms.

    Importing into a term takes that term's rows and nothing else — a file
    holding the whole year can be imported a season at a time. A row with no
    Term cell is taken as this term's, because it was opened from this term;
    a row whose cell names no season at all is left out rather than guessed
    at, and counted separately so the teacher can find it.
  */
  const kept: { parsed: ParsedStudent; term?: string }[] = [];
  for (const row of parsed) {
    // Copied, because rows for the same student are folded into one below and
    // the caller's parsed rows must come out as they went in.
    const copy: ParsedStudent = { ...row, student: { ...row.student } };
    const cell = row.termCell.trim();
    const term = cell ? parseTermCell(cell, { today, context: scopeTerm }) : null;

    if (scopeTerm) {
      if (!cell) kept.push({ parsed: copy, term: scopeTerm });
      else if (!term) plan.unreadableTerm += 1;
      else if (term !== scopeTerm) plan.otherTerm += 1;
      else kept.push({ parsed: copy, term });
    } else {
      kept.push({ parsed: copy, term: term ?? undefined });
    }
  }

  /*
    2. The same student twice in the file.

    A common shape for a class list is one row per enrolment: Aman in maths,
    Aman again in English. Those are one student in two classes, and adding them
    as two students is the duplicate this whole change exists to prevent. Rows
    are the same student when their documents match — or, failing documents,
    when their name and phone both do, which is the rule the roster has always
    used for "this is the child already here". Two rows with the same name and
    different documents are two children and are left alone.
  */
  const entries: Entry[] = [];
  const byKey = new Map<string, Entry>();
  const byNamePhone = new Map<string, Entry>();

  for (const { parsed: row, term } of kept) {
    const doc = documentOfRow(row, today);
    const entry: Entry = {
      parsed: row,
      groups: row.groupNames.map((name) => ({ name, term })),
      doc,
      key: doc ? documentKey(doc.id) : '',
    };

    const phone = digitsOf(row.student.phone);
    const np = phone ? `${nameKey(row.student.name)}|${phone}` : '';

    const sameDoc = entry.key ? byKey.get(entry.key) : undefined;
    if (sameDoc) {
      if (namesCompatible(sameDoc.parsed.student.name, row.student.name)) {
        mergeRow(sameDoc, entry);
        plan.mergedInFile += 1;
      } else {
        plan.conflicts.push({
          line: row.line,
          name: row.student.name,
          owner: sameDoc.parsed.student.name,
        });
      }
      continue;
    }

    const samePerson = np ? byNamePhone.get(np) : undefined;
    if (samePerson && !(samePerson.key && entry.key && samePerson.key !== entry.key)) {
      mergeRow(samePerson, entry);
      if (samePerson.key) byKey.set(samePerson.key, samePerson);
      plan.mergedInFile += 1;
      continue;
    }

    entries.push(entry);
    if (entry.key) byKey.set(entry.key, entry);
    if (np && !byNamePhone.has(np)) byNamePhone.set(np, entry);
  }

  /*
    3. Students already on the roster.

    Four tiers, most certain first, each run over every row before the next
    starts — run per row, a weak match takes a student a stronger one further
    down was going to claim. A student is claimed at most once, so two rows can
    never both become the same person.

      1. The id column, which only this app writes. Exact.
      2. The document number. Exact, provided the names have something in
         common — see `namesCompatible`.
      3. Name and phone.
      4. Name alone, where neither side has a phone to contradict it.

    Tiers 3 and 4 never join a row to a student whose document disagrees with
    the row's: same name, different passport is a different child.
  */
  const taken = new Set<string>();
  const byId = new Map(students.map((s) => [s.id, s]));
  const existingByKey = new Map<string, Student>();
  const existingByNamePhone = new Map<string, Student[]>();
  const existingByName = new Map<string, Student[]>();
  for (const s of students) {
    const key = documentKey(s.documentId);
    if (key && !existingByKey.has(key)) existingByKey.set(key, s);
    push(existingByName, nameKey(s.name), s);
    const phone = digitsOf(s.phone);
    if (phone) push(existingByNamePhone, `${nameKey(s.name)}|${phone}`, s);
  }

  const claim = (entry: Entry, s: Student | undefined) => {
    if (!s || taken.has(s.id)) return false;
    taken.add(s.id);
    entry.existingId = s.id;
    return true;
  };
  const agrees = (entry: Entry) => (s: Student) =>
    !taken.has(s.id) && !documentsDisagree(entry.doc?.id, s.documentId);

  for (const entry of entries) {
    if (entry.parsed.sourceId) claim(entry, byId.get(entry.parsed.sourceId));
  }

  for (const entry of entries) {
    if (entry.existingId || !entry.key) continue;
    const owner = existingByKey.get(entry.key);
    if (!owner) continue;
    if (!taken.has(owner.id) && namesCompatible(owner.name, entry.parsed.student.name)) {
      claim(entry, owner);
    } else {
      // The number is somebody else's — a different name, or the same student
      // already claimed by the id column. Either way this row is not them, and
      // it cannot be added beside them holding their number.
      plan.conflicts.push({
        line: entry.parsed.line,
        name: entry.parsed.student.name,
        owner: owner.name,
      });
      plan.protectedIds.push(owner.id);
      entry.dropped = true;
    }
  }

  for (const entry of entries) {
    if (entry.existingId || entry.dropped) continue;
    const phone = digitsOf(entry.parsed.student.phone);
    if (!phone) continue;
    const list = existingByNamePhone.get(`${nameKey(entry.parsed.student.name)}|${phone}`);
    claim(entry, list?.find(agrees(entry)));
  }

  /*
    Name alone is the weakest evidence there is, so it is only taken when the
    row has nothing better to offer. A row carrying a real document has: that
    number is who the row is, and a student on the roster with the same name
    and no number of their own is as likely a namesake as the same child. On a
    roster of a few hundred, Turkmen names repeat often enough that this is not
    hypothetical — a test import of 270 rows folded eight different children
    into namesakes this way. Such a row becomes a new student; a file without
    documents still matches by name, so re-importing it does not duplicate the
    roster.
  */
  for (const entry of entries) {
    if (entry.existingId || entry.dropped) continue;
    if (entry.doc && entry.doc.kind !== 'generated') continue;
    const phone = digitsOf(entry.parsed.student.phone);
    const list = existingByName.get(nameKey(entry.parsed.student.name)) ?? [];
    claim(entry, list.find((s) => agrees(entry)(s) && (!phone || !digitsOf(s.phone))));
  }

  /*
    4. Documents.

    A row with a number keeps it. A row without one leaves a matched student's
    number alone, and gets a generated code if the student has none either —
    new or old. Codes are drawn against every number already in use, the
    roster's and the file's, so a code can never collide with anything.
  */
  const inUse = new Set<string>();
  for (const s of students) {
    const key = documentKey(s.documentId);
    if (key) inUse.add(key);
  }
  for (const entry of entries) if (entry.key && !entry.dropped) inUse.add(entry.key);

  for (const entry of entries) {
    if (entry.dropped) continue;
    let document: Doc | undefined = entry.doc ?? undefined;
    if (!document) {
      const held = entry.existingId ? byId.get(entry.existingId) : undefined;
      if (!documentKey(held?.documentId)) {
        document = { id: generateCode(inUse, random), kind: 'generated' };
        plan.generated += 1;
      }
    }
    plan.rows.push({
      parsed: entry.parsed,
      groups: entry.groups,
      existingId: entry.existingId,
      document,
    });
  }

  return plan;
}

const push = <T,>(map: Map<string, T[]>, k: string, value: T) => {
  const list = map.get(k);
  if (list) list.push(value);
  else map.set(k, [value]);
};

/* -------------------------------------------------------------------------- */
/* Classes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Class name and term to class id, making the classes that are not there yet.
 *
 * With a term, a name means the class of that name *in that term*: "Matematika
 * A2" in the summer and the one in the autumn are two intakes of the same
 * course and two different groups. A class named nowhere in the term is made
 * there — unless a class of that name is waiting for a term (the "no term yet"
 * pile an import used to fill), in which case it is given this one rather than
 * left waiting beside a new copy of itself.
 *
 * Without a term, the old rule: any class of that name, active ones first,
 * made with no term when there is none.
 *
 * The making and the term-setting are passed in, so this can be tested without
 * a store.
 */
export function groupResolver(
  groups: readonly Group[],
  effects: {
    create: (name: string, term?: string) => string;
    adopt: (groupId: string, term: string) => void;
  },
) {
  const inTerm = new Map<string, string>();
  const ordered = [...groups.filter((g) => !g.archivedAt), ...groups.filter((g) => g.archivedAt)];
  for (const g of ordered) {
    const term = chosenTerm(g);
    if (!term) continue;
    const key = `${term}|${groupKey(g.name)}`;
    if (!inTerm.has(key)) inTerm.set(key, g.id);
  }

  const anyTerm = indexGroupsByName([...groups]);
  const waiting = new Map<string, string>();
  for (const g of groups) {
    if (g.archivedAt || chosenTerm(g)) continue;
    const key = groupKey(g.name);
    if (!waiting.has(key)) waiting.set(key, g.id);
  }

  const counts = { created: 0, adopted: 0 };

  const resolve = (name: string, term?: string): string => {
    const key = groupKey(name);

    if (!term) {
      const found = anyTerm.get(key);
      if (found) return found;
      const id = effects.create(name.trim());
      anyTerm.set(key, id);
      counts.created += 1;
      return id;
    }

    const termKey = `${term}|${key}`;
    const found = inTerm.get(termKey);
    if (found) return found;

    const loose = waiting.get(key);
    if (loose) {
      waiting.delete(key);
      effects.adopt(loose, term);
      inTerm.set(termKey, loose);
      counts.adopted += 1;
      return loose;
    }

    const id = effects.create(name.trim(), term);
    inTerm.set(termKey, id);
    if (!anyTerm.has(key)) anyTerm.set(key, id);
    counts.created += 1;
    return id;
  };

  return { resolve, counts };
}

/* -------------------------------------------------------------------------- */
/* Changes                                                                    */
/* -------------------------------------------------------------------------- */

export type StudentChanges = {
  adds: (Omit<Student, 'id' | 'accent'> & { accent?: Student['accent'] })[];
  updates: { id: string; patch: Partial<Student> }[];
  /** Students a replace removes: on the roster, not in the file, nothing finished. */
  removeIds: string[];
  /** Students a replace left alone because a finished course hangs off them. */
  keptForHistory: number;
  /** Memberships added, counted per student per class. */
  joined: number;
  /** Students added to no class at all. */
  noClass: number;
};

/**
 * The plan as changes to make: who to add, what to change on whom, who goes.
 *
 * A blank cell changes nothing. The parser leaves an empty cell out of the row
 * rather than writing an empty string, and that has to survive to here — an
 * update that carried the key with nothing in it would clear the field on the
 * student, so re-importing a file without emails would wipe every email on the
 * roster.
 *
 * Memberships are unioned, never replaced: nothing a spreadsheet says can take
 * a course away from anybody. `accent` is never in an update — the parser hands
 * colours out round robin, and an existing student's colour is one the teacher
 * recognises them by.
 */
export function changesFor({
  plan,
  students,
  groups,
  mode,
  resolve,
  today,
}: {
  plan: ImportPlan;
  students: Student[];
  /** Every group, after `resolve` has made any it needed. Read lazily. */
  groups: () => Group[];
  mode: 'merge' | 'replace';
  resolve: (name: string, term?: string) => string;
  today?: string;
}): StudentChanges {
  const out: StudentChanges = {
    adds: [],
    updates: [],
    removeIds: [],
    keptForHistory: 0,
    joined: 0,
    noClass: 0,
  };

  if (mode === 'replace') {
    const inFile = new Set<string | undefined>([
      ...plan.rows.map((r) => r.existingId),
      ...plan.protectedIds,
    ]);
    const all = groups();
    for (const s of students) {
      if (inFile.has(s.id)) continue;
      if (studentCourses(s, all, today).finished.length) {
        out.keptForHistory += 1;
        continue;
      }
      out.removeIds.push(s.id);
    }
  }

  const byId = new Map(students.map((s) => [s.id, s]));

  for (const row of plan.rows) {
    const named = [...new Set(row.groups.map((g) => resolve(g.name, g.term)))];
    const { accent, ...fields } = row.parsed.student;
    const defined = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined),
    ) as Partial<Student>;
    const document: Partial<Student> = row.document
      ? { documentId: row.document.id, documentKind: row.document.kind }
      : {};
    const level = (ids: string[]) =>
      row.parsed.level === undefined
        ? {}
        : { levelBase: baseForLevel(row.parsed.level, { groupIds: ids }, groups(), today) };

    const held = row.existingId ? byId.get(row.existingId) : undefined;
    if (held) {
      const after = mergeGroupIds(held.groupIds, named);
      const joined = after.length - held.groupIds.length;
      out.updates.push({
        id: held.id,
        patch: {
          ...defined,
          ...document,
          // Only where it changed: an unchanged list would still be sent and
          // still be written, for every student, by an import that named no
          // classes at all.
          ...(joined ? { groupIds: after } : {}),
          ...level(after),
        },
      });
      out.joined += joined;
    } else {
      out.adds.push({
        ...(defined as Omit<Student, 'id' | 'groupIds' | 'accent'>),
        accent,
        ...document,
        groupIds: named,
        ...level(named),
      });
      out.joined += named.length;
      if (!named.length) out.noClass += 1;
    }
  }

  return out;
}
