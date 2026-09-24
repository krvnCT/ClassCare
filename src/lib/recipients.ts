/**
 * Who a message goes to, worked out before a word of it is written.
 *
 * Pulled out of `deviceSms` for two reasons. It is the half with the rules in
 * it — which guardian, who has no number, whose number is somebody else's — and
 * those are worth testing without a radio. And the composer needs the *count*
 * on every keystroke, which it cannot get from a function that renders a
 * message body per recipient.
 *
 * ## One number, one message
 *
 * Two children in a family are two students and one mother, and her number is
 * on both records. A teacher messaging both of their classes used to send that
 * mother the same text twice — and being told twice that your child was absent,
 * when only one of them was, is worse than not being told at all.
 *
 * So a number that is already being written to in this send is not written to
 * again, whoever it belongs to. The same rule handles the other shape of it:
 * a student whose own `phone` is their father's, and a record where the same
 * number was typed into both guardian fields.
 *
 * The merge is counted, not hidden. A teacher who sees "reaches 41" against a
 * roster of 44 is owed the reason.
 */
import type { Student } from '@/data/types';
import { guardiansFor, hasGuardianOnFile, type GuardianKind, type ParentTarget } from '@/lib/guardians';
import { normalisePhone } from '@/lib/phone';

/**
 * Who a copy is addressed to.
 *
 * `parent` is the mother and `parent2` the father, matching the column names.
 * The distinction exists so the message log can say which of them was written
 * to — the thing a teacher goes back to when a parent says nobody told them.
 */
export type RecipientKind = 'student' | GuardianKind;

export type PlannedRecipient = {
  /** `${studentId}:${RecipientKind}` — unique within one send. */
  key: string;
  studentId: string;
  kind: RecipientKind;
  /** Who is being written to, for the progress list. */
  name: string;
  /** Already normalised — see `normalisePhone`. */
  phone: string;
};

export type RecipientPlan = {
  rows: PlannedRecipient[];
  /**
   * Somebody who should have been reachable and was not: a student with no
   * number, or a guardian on file with a name and no way to ring them.
   */
  skipped: number;
  /** Copies dropped because that number was already in this send. */
  merged: number;
};

export type Audience = 'students' | 'parents' | 'both';

/**
 * The recipients for one send, in order, with no number appearing twice.
 *
 * Students are deduplicated too. The composer can select several groups and a
 * whole term at once, and a student in two of those groups is still one
 * student — a caller that builds its list by concatenating rosters would
 * otherwise send them two of everything.
 */
export function planRecipients(input: {
  students: Student[];
  audience: Audience;
  /** Which guardian, when the audience includes parents. Defaults to both. */
  parents?: ParentTarget;
}): RecipientPlan {
  const target: ParentTarget = input.parents ?? 'both';
  const rows: PlannedRecipient[] = [];
  const takenPhones = new Set<string>();
  const seenStudents = new Set<string>();
  let skipped = 0;
  let merged = 0;

  const take = (row: PlannedRecipient) => {
    // A number that normalises to nothing — a half-typed entry, a note in the
    // phone field — is not a number. It is the same situation as an empty one.
    if (!row.phone) {
      skipped += 1;
      return;
    }
    if (takenPhones.has(row.phone)) {
      merged += 1;
      return;
    }
    takenPhones.add(row.phone);
    rows.push(row);
  };

  for (const student of input.students) {
    if (seenStudents.has(student.id)) continue;
    seenStudents.add(student.id);

    if (input.audience !== 'parents') {
      if (student.phone?.trim()) {
        take({
          key: `${student.id}:student`,
          studentId: student.id,
          kind: 'student',
          name: student.name,
          phone: normalisePhone(student.phone),
        });
      } else {
        skipped += 1;
      }
    }

    if (input.audience !== 'students') {
      const wanted = guardiansFor(student, target);

      // Skipped only where there was somebody to miss — see `hasGuardianOnFile`.
      if (wanted.length === 0 && hasGuardianOnFile(student)) skipped += 1;

      for (const kind of wanted) {
        const isMother = kind === 'parent';
        take({
          key: `${student.id}:${kind}`,
          studentId: student.id,
          kind,
          name:
            (isMother ? student.parentName : student.parent2Name) ||
            `${student.name} (${isMother ? 'mother' : 'father'})`,
          phone: normalisePhone((isMother ? student.parentPhone : student.parent2Phone) ?? ''),
        });
      }
    }
  }

  return { rows, skipped, merged };
}

/**
 * How many messages this send is, counting a shared number once.
 *
 * What the composer's footer reads off. The old arithmetic was
 * `students × (audience === 'both' ? 2 : 1)`, which over-counted every student
 * with no number and every family reached on one phone — so the footer promised
 * a class of forty and the run sheet showed thirty-one.
 */
export const reachOf = (input: Parameters<typeof planRecipients>[0]) =>
  planRecipients(input).rows.length;
