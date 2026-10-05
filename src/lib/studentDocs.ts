/**
 * A student's identity document: which one, and what makes two of them equal.
 *
 * A child here carries a birth certificate until sixteen and a passport after
 * it, and either number is printed on every form a tutor fills in for them. It
 * is also the only thing that reliably tells two children apart. Names repeat —
 * a roster of four hundred has several Aman Amanows — and phone numbers belong
 * to whichever parent answers. A document number belongs to exactly one person.
 *
 * So the number does two jobs. It is a detail to keep, and it is the identity
 * the importer and the duplicate check go by: one number, one student.
 *
 * Kept free of React and the store so the rules can be tested on their own —
 * see `tools/test-student-import.js`.
 */
import type { DocumentKind, Student } from '@/data/types';
import type { TranslationKey } from '@/i18n';
import { fold } from '@/lib/search';

/** The age a passport replaces the birth certificate. */
export const PASSPORT_AGE = 16;

/** Whole years on `now`, or null when the date is missing or not a date. */
export function ageOn(birthDate: string | undefined, now = new Date()): number | null {
  const m = birthDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate) : null;
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];

  let age = now.getFullYear() - year;
  const beforeBirthday =
    now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day);
  if (beforeBirthday) age -= 1;
  // A birth date in the future is a typo, not a newborn. Saying "unknown" lets
  // the form ask rather than file a passport holder as a baby.
  return age < 0 ? null : age;
}

/**
 * The document someone this age has: a passport from sixteen, a birth
 * certificate before it. Null when the age is not known, which is the one case
 * the teacher has to say which it is.
 */
export function documentKindForAge(
  birthDate: string | undefined,
  now = new Date(),
): 'passport' | 'birthCertificate' | null {
  const age = ageOn(birthDate, now);
  if (age === null) return null;
  return age >= PASSPORT_AGE ? 'passport' : 'birthCertificate';
}

/**
 * Cyrillic capitals that are drawn exactly like Latin ones.
 *
 * Series letters are Latin, but a teacher on a Russian keyboard types the ones
 * that look the same without switching layout — and "А" and "A" then compare as
 * different documents while being, to anybody reading them, the same.
 */
const LOOKALIKE: Record<string, string> = {
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P',
  С: 'C', Т: 'T', Х: 'X', У: 'Y', І: 'I', Ј: 'J', Ѕ: 'S',
};

/** Spacing and punctuation a number is written with but does not consist of. */
const DECORATION = /[\s\-‐-―.,/\\#№_:'"`]/;

/**
 * The form two document numbers are compared in.
 *
 * Capitals, no spacing, no punctuation: "I-AŞ 123456", "i-aş123456" and
 * "I AŞ № 123456" are one passport written three ways, and treating them as
 * three would let the same child onto the roster three times. Never shown —
 * the teacher's own spelling is what is kept and displayed.
 */
export function documentKey(raw: string | undefined | null): string {
  if (!raw) return '';
  let out = '';
  for (const ch of raw.toUpperCase()) {
    if (DECORATION.test(ch)) continue;
    out += LOOKALIKE[ch] ?? ch;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Generated codes                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Letters and digits that cannot be misread for one another — no 0 and O, no
 * 1, I and L, no U next to V. The code is read aloud and copied by hand.
 */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
export const CODE_PREFIX = 'CC-';
const CODE_RE = new RegExp(`^CC-[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

/** A code this app made, rather than a document somebody issued. */
export function isGeneratedCode(raw: string | undefined | null): boolean {
  return !!raw && CODE_RE.test(raw.trim().toUpperCase());
}

/**
 * A new code no student in `taken` already holds, added to `taken`.
 *
 * For a student imported with no document at all. Without one they had nothing
 * that told them apart from a namesake, and the next import could fold two
 * different children into one record. Thirty symbols to the eighth power is a
 * trillion codes; the loop is there for correctness, not because it will turn.
 *
 * `random` is a parameter so tests can make the codes predictable.
 */
export function generateCode(taken: Set<string>, random: () => number = Math.random): string {
  for (;;) {
    let code = CODE_PREFIX;
    for (let i = 0; i < CODE_LENGTH; i += 1) {
      code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
    }
    const key = documentKey(code);
    if (!taken.has(key)) {
      taken.add(key);
      return code;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Ownership                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Who already holds this number, other than `exceptId`.
 *
 * The question the form asks before saving: a number that belongs to somebody
 * else is either a typo or the same child entered twice, and both are worth
 * stopping for.
 */
export function documentOwner<T extends Pick<Student, 'id' | 'documentId'>>(
  students: readonly T[],
  raw: string | undefined,
  exceptId?: string,
): T | undefined {
  const key = documentKey(raw);
  if (!key) return undefined;
  return students.find((s) => s.id !== exceptId && documentKey(s.documentId) === key);
}

/**
 * Could these two names belong to the same person?
 *
 * Asked when a document number matches. The same number on two rows is the
 * same child — unless the names have nothing in common, in which case it is
 * far more likely one digit was mistyped and the number now points at a
 * stranger. Overwriting that stranger's record with this row would be the worst
 * thing an import could do, so a match needs one word of the name in common.
 *
 * Folded first, so a name spelt with and without Turkmen letters still agrees
 * with itself.
 */
export function namesCompatible(a: string, b: string): boolean {
  // Split on spacing and punctuation rather than "anything but a letter": a
  // Unicode letter class needs regex support Hermes cannot be relied on for.
  const words = (s: string) =>
    new Set(
      fold(s)
        .split(/[\s.,;:!?'"`’()[\]\-‐-―/\\]+/)
        .filter((w) => w.length >= 2),
    );
  const left = words(a);
  const right = words(b);
  if (!left.size || !right.size) return true;
  for (const w of left) if (right.has(w)) return true;
  return false;
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                     */
/* -------------------------------------------------------------------------- */

/** What to call the number, by the document it came from. */
export function documentLabelKey(kind: DocumentKind | undefined): TranslationKey {
  switch (kind) {
    case 'passport':
      return 'student.passport';
    case 'birthCertificate':
      return 'student.birthCertificate';
    case 'generated':
      return 'student.generatedId';
    default:
      return 'student.documentId';
  }
}
