/**
 * Finding a student by whatever the teacher happens to remember.
 *
 * The old search was `name.includes(query)` plus a bare digit match on the
 * student's own phone, and it failed on the three things teachers actually
 * type:
 *
 * - **A parent's number.** A mother rings, the screen shows eight digits and no
 *   name, and the teacher needs to know whose mother that is. That number is on
 *   the record — under `parentPhone` — and was the one field the search would
 *   not look at.
 * - **A name with the accents left off.** `Aýgül` typed as `aygul` matched
 *   nothing, and the accented letters are the hard ones to reach on a phone
 *   keyboard, so leaving them off is what everybody does.
 * - **Two words.** "aygul mekdep" matched nothing, because the query was one
 *   substring and no field contains both.
 *
 * So: fold the accents away, split the query into words, and require every word
 * to hit *some* field. Words are ANDed and fields are ORed, which is the rule
 * every search box behaves by and therefore the one nobody has to be taught.
 *
 * Pure, and deliberately outside the screens — three of them search students
 * and they used to do it three different ways, so a student findable on the
 * home screen was not findable in the roster picker.
 */
import type { Student } from '@/data/types';

/**
 * Letters that are the same letter to somebody looking for a name.
 *
 * Written out rather than done with `normalize('NFD')`: Hermes ships without
 * full Unicode data, `ý` is not a decomposable character in every build, and a
 * search box that works on the simulator and not on the teacher's phone is
 * worse than no search box. This table is explicit, complete for Turkmen, and
 * costs one map lookup per non-ASCII character.
 */
const FOLD: Record<string, string> = {
  ä: 'a', â: 'a', á: 'a', à: 'a', ā: 'a', å: 'a',
  ç: 'c', ć: 'c', č: 'c',
  é: 'e', è: 'e', ê: 'e', ë: 'e', ē: 'e',
  ğ: 'g',
  ı: 'i', í: 'i', ì: 'i', ï: 'i', î: 'i',
  ň: 'n', ñ: 'n', ń: 'n',
  ö: 'o', ó: 'o', ô: 'o', ő: 'o', ò: 'o', ø: 'o',
  ş: 's', ś: 's', š: 's',
  ü: 'u', ú: 'u', ù: 'u', û: 'u', ű: 'u',
  ý: 'y', ÿ: 'y',
  ž: 'z', ź: 'z', ż: 'z',
  // Russian keyboards are common here and ё is routinely typed as е.
  ё: 'е',
};

/** Lower case, accents removed. The form both sides of a match are compared in. */
export function fold(value: string): string {
  let out = '';
  for (const ch of value.toLowerCase()) out += FOLD[ch] ?? ch;
  return out;
}

/** Just the digits, which is the only part of a phone number that is stable. */
export const digitsOf = (value: string) => value.replace(/\D/g, '');

/**
 * One student, flattened into the two things a query is matched against.
 *
 * Cached against the student object rather than its id: the store replaces a
 * student on every edit, so a new object is a changed record and an unchanged
 * object cannot be stale. A `Map` keyed by id would hand back the old spelling
 * of a name the teacher had just corrected.
 */
type Index = { text: string; phones: string };

const cache = new WeakMap<object, Index>();

function indexOf(s: Student): Index {
  const hit = cache.get(s);
  if (hit) return hit;

  const text = fold(
    [
      s.name,
      s.surname,
      s.patronymic,
      s.school,
      s.address,
      s.email,
      s.parentName,
      s.parent2Name,
      s.parentEmail,
      s.parent2Email,
      s.parentWork,
      s.parent2Work,
      s.documentId,
      s.note,
    ]
      .filter(Boolean)
      .join(' '),
  );

  /*
    Every number on the record, run together.

    One string rather than a list because the question is only ever "does this
    appear anywhere", and `includes` on one string beats a loop over four. The
    separator is a space so a query cannot match across the join between two
    different people's numbers.
  */
  const phones = [s.phone, s.parentPhone, s.parent2Phone]
    .filter(Boolean)
    .map((p) => digitsOf(p!))
    .filter(Boolean)
    .join(' ');

  const index = { text, phones };
  cache.set(s, index);
  return index;
}

/**
 * A prepared test for one query string.
 *
 * Built once and applied to every student, because the query is parsed the same
 * way for all of them and doing it inside the loop is the difference between
 * one split and six hundred.
 *
 * `extraOf` adds text the student record does not carry — the names of the
 * groups they are in, on the screens that know them. A teacher searching
 * "matematika" means "show me that class", and until this they got nothing.
 *
 * Returns a function that is always true for an empty query, so a caller can
 * apply it unconditionally rather than branching around it.
 */
export function matcherFor(
  query: string,
  extraOf?: (s: Student) => string | undefined,
): (s: Student) => boolean {
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return () => true;

  // A word with a digit in it is a number being typed, and is matched against
  // the phone numbers as digits — so `+993 65` and `65` and `993 65` all find
  // the same person, whatever the record happens to be punctuated like.
  const terms = words.map((word) => ({ word, digits: /\d/.test(word) ? digitsOf(word) : '' }));

  return (s: Student) => {
    const index = indexOf(s);
    const extra = extraOf ? fold(extraOf(s) ?? '') : '';
    return terms.every(
      ({ word, digits }) =>
        index.text.includes(word) ||
        (!!extra && extra.includes(word)) ||
        (!!digits && index.phones.includes(digits)),
    );
  };
}

/** One-off form, for the places matching a single record. */
export const matchesQuery = (s: Student, query: string, extra?: string) =>
  matcherFor(query, extra === undefined ? undefined : () => extra)(s);
