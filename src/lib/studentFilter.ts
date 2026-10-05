/**
 * Narrowing a long student list: the filters, the sorts, and the sections.
 *
 * Lifted out of the screen so it can be run without React. This is the part
 * with the decisions in it — which student counts as missing a parent's phone,
 * where the ungraded belong in a sort by score, whether "Mekdep 20" and
 * "mekdep 20" are one school — and every one of those is a rule that is easy to
 * get subtly wrong and impossible to check by looking at a screenshot.
 *
 * `buildSections` takes `t` rather than calling it, so it has no dependency on
 * a mounted app and a test can pass in something that echoes its key.
 */
import type { Gender, Student } from '@/data/types';
import type { TranslationKey } from '@/i18n';
import { ageFrom } from '@/lib/date';
import { genderOf } from '@/lib/names';
import { matcherFor } from '@/lib/search';

export type Section = { title: string; data: Student[] };

/** Translate, as `buildSections` needs it. */
export type Translate = (key: TranslationKey, vars?: Record<string, string | number>) => string;

export type GenderFilter = 'any' | Gender | 'none';
export type SortMode = 'name' | 'place' | 'school' | 'level' | 'score';

/**
 * Students with a gap in their record.
 *
 * The one filter here that is not about finding a student — it is about finding
 * the *hole*. A teacher who cannot send a message to half a class needs the
 * list of who has no number on file, and until now the only way to get it was
 * to open sixty students one at a time.
 *
 * `parent` means neither guardian has a phone, not neither has a name. A name
 * with no number is no more use than nothing when the child is off sick.
 */
export type MissingFilter = 'any' | 'phone' | 'parent' | 'birthday' | 'school';

export const MISSING_FILTERS = [
  { key: 'phone', labelKey: 'students.missingPhone' as TranslationKey },
  { key: 'parent', labelKey: 'students.missingParent' as TranslationKey },
  { key: 'birthday', labelKey: 'students.missingBirthday' as TranslationKey },
  { key: 'school', labelKey: 'students.missingSchool' as TranslationKey },
] as const;

/**
 * Score bands, for the sort that groups by them.
 *
 * Out of ten, in twos, because that is the granularity a teacher actually acts
 * on. "Who is under five" is a question with a consequence; "who is on 6.4
 * against 6.7" is not.
 */
export const SCORE_BANDS = [
  { key: '9', labelKey: 'students.scoreBand' as TranslationKey, params: { from: 9, to: 10 }, min: 9 },
  { key: '7', labelKey: 'students.scoreBand' as TranslationKey, params: { from: 7, to: 8 }, min: 7 },
  { key: '5', labelKey: 'students.scoreBand' as TranslationKey, params: { from: 5, to: 6 }, min: 5 },
  { key: '0', labelKey: 'students.scoreUnder' as TranslationKey, params: { score: 5 }, min: 0 },
] as const;

/**
 * A school name as a bucket key.
 *
 * Case and spacing only. School names are typed by hand, once per student, so
 * "Mekdep 20", "mekdep 20" and " Mekdep  20 " are one school and have to land
 * in one chip — otherwise the filter offers three and each finds a third of
 * the children.
 */
export const schoolKey = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The schools in a roster, each with the spelling to show for it.
 *
 * One source for both the filter chips and the sort headings. They used to
 * derive their own — the chips bucketed on `schoolKey` and the sort on the raw
 * string — so a school typed once with a stray capital was one chip that found
 * everybody, and two sections that split them. The filter said one school and
 * the sort said two.
 *
 * The label is the commonest spelling of each key, so a single mistyping does
 * not decide how the school reads anywhere.
 */
export function schoolsOf(students: Pick<Student, 'school'>[]): { key: string; label: string }[] {
  const spellings = new Map<string, Map<string, number>>();
  for (const s of students) {
    const raw = s.school?.trim();
    if (!raw) continue;
    const key = schoolKey(raw);
    const counts = spellings.get(key) ?? new Map<string, number>();
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
    spellings.set(key, counts);
  }
  return [...spellings.entries()]
    .map(([key, counts]) => ({
      key,
      label: [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0],
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Age bands rather than a slider.
 *
 * A tutor thinks in school stages — the little ones, the exam years — not in
 * "students aged 11 to 14". Bands make the common questions one tap, and a
 * slider would make every one of them a fiddle.
 */
export const AGE_BANDS = [
  { key: 'under10', labelKey: 'students.ageUnder' as TranslationKey, params: { age: 10 }, min: 0, max: 9 },
  { key: '10to13', labelKey: 'students.ageBetween' as TranslationKey, params: { from: 10, to: 13 }, min: 10, max: 13 },
  { key: '14to17', labelKey: 'students.ageBetween' as TranslationKey, params: { from: 14, to: 17 }, min: 14, max: 17 },
  { key: '18plus', labelKey: 'students.ageOver' as TranslationKey, params: { age: 18 }, min: 18, max: 200 },
] as const;

export type AgeBand = (typeof AGE_BANDS)[number]['key'] | 'any';


/* -------------------------------------------------------------------------- */
/* Filtering, sorting, sectioning                                             */
/* -------------------------------------------------------------------------- */

/**
 * Where a student lives, as a heading.
 *
 * The first comma-separated part of the address, which is how people write
 * these — "Aşgabat, Görogly köçesi 12" is a city and a street, and the city is
 * the useful bucket. An address with no comma is its own heading, which for a
 * tutor whose students all live in one town is exactly right: the streets
 * become the groups.
 */
export const placeOf = (s: Student) => (s.address ?? '').split(',')[0]?.trim() ?? '';

export function buildSections({
  students,
  query,
  gender,
  term,
  age,
  school,
  level,
  missing,
  sort,
  termsByStudent,
  levelByStudent,
  groupNamesByStudent,
  inClass,
  t,
}: {
  students: Student[];
  query: string;
  gender: GenderFilter;
  term: string;
  age: AgeBand;
  school: string;
  level: string;
  missing: MissingFilter;
  sort: SortMode;
  termsByStudent: Map<string, Set<string>>;
  levelByStudent: Map<string, number>;
  /**
   * The names of the groups each student is in, for the search to look at.
   *
   * Optional because the rule belongs to the screen that has the groups, not
   * to this file — and every caller that has them should pass them: "show me
   * the maths lot" is a search teachers make constantly.
   */
  groupNamesByStudent?: Map<string, string>;
  /**
   * Students in at least one running course. What `term: 'none'` reads: the
   * ones who have finished, or were never put in a class.
   */
  inClass?: Set<string>;
  t: Translate;
}): Section[] {
  const band = AGE_BANDS.find((b) => b.key === age);
  // Parsed once for the whole list — see `matcherFor`. Searches the parents'
  // numbers, the schools, the addresses and the names with their accents
  // folded away, which is how these names are actually typed.
  const hit = matcherFor(query, groupNamesByStudent && ((s) => groupNamesByStudent.get(s.id)));

  const matches = students.filter((s) => {
    if (!hit(s)) return false;

    /*
      "Not recorded" is its own answer, not a third gender: it selects the
      students whose gender nobody has filled in, which is the list a teacher
      wants when they are trying to finish filling it in.

      Read through `genderOf`, so a surname that says which counts as recorded.
      Filtering on the stored column alone put every student entered before the
      inference existed in the "not recorded" bucket, and left the male and
      female filters returning only the handful saved since.
    */
    const known = genderOf(s);
    if (gender === 'none' ? !!known : gender !== 'any' && known !== gender) return false;

    if (term === 'none') {
      if (inClass?.has(s.id)) return false;
    } else if (term !== 'any' && !termsByStudent.get(s.id)?.has(term)) return false;

    if (school !== 'any') {
      const key = s.school?.trim() ? schoolKey(s.school) : '';
      // `none` is the students with no school on file, the same shape of answer
      // as "not recorded" on gender and for the same reason.
      if (school === 'none' ? key !== '' : key !== school) return false;
    }

    if (level !== 'any' && String(levelByStudent.get(s.id) ?? 0) !== level) return false;

    if (missing !== 'any' && !isMissing(s, missing)) return false;

    if (band) {
      // No birth date means no age, and a student with no age cannot be in a
      // band. Silently including them would put ten-year-olds in the 18+ list.
      if (!s.birthDate) return false;
      const years = ageFrom(s.birthDate);
      if (years < band.min || years > band.max) return false;
    }

    return true;
  });

  if (sort === 'place') {
    return bucketed(matches, (s) => placeOf(s), t('students.noPlace'));
  }

  if (sort === 'school') {
    // Keyed on `schoolKey` and labelled from `schoolsOf`, so a school spelled
    // two ways is one section — the same answer the filter chip gives.
    const label = new Map(schoolsOf(matches).map((s) => [s.key, s.label]));
    return bucketed(
      matches,
      (s) => label.get(schoolKey(s.school ?? '')) ?? '',
      t('students.noSchool'),
    );
  }

  if (sort === 'level') {
    /*
      Numeric order, not the alphabetical order `bucketed` would give — which
      puts level 10 between 1 and 2. Low to high, so the headings read as a
      progression a teacher can scan down.
    */
    const sorted = [...matches].sort(
      (a, b) =>
        (levelByStudent.get(a.id) ?? 0) - (levelByStudent.get(b.id) ?? 0) ||
        a.name.localeCompare(b.name),
    );
    const buckets = new Map<number, Student[]>();
    for (const s of sorted) {
      const n = levelByStudent.get(s.id) ?? 0;
      buckets.set(n, [...(buckets.get(n) ?? []), s]);
    }
    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([n, data]) => ({ title: t('students.levelN', { level: n }), data }));
  }

  if (sort === 'score') {
    /*
      Best first, and banded rather than one long ordered list: the question
      behind this sort is "who is struggling", and a heading a teacher can stop
      at answers it faster than a position in a ranking.
    */
    const scored = matches.filter((s) => typeof s.avgScore === 'number');
    const unscored = matches.filter((s) => typeof s.avgScore !== 'number');
    const buckets = new Map<string, Student[]>();

    for (const s of [...scored].sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0) || a.name.localeCompare(b.name))) {
      const hit = SCORE_BANDS.find((b) => (s.avgScore ?? 0) >= b.min) ?? SCORE_BANDS[SCORE_BANDS.length - 1];
      buckets.set(hit.key, [...(buckets.get(hit.key) ?? []), s]);
    }

    const sections = SCORE_BANDS.filter((b) => buckets.has(b.key)).map((b) => ({
      title: t(b.labelKey, b.params),
      data: buckets.get(b.key)!,
    }));
    // Students with no score at the end rather than at zero. A student nobody
    // has graded is not a student doing badly, and putting them in the bottom
    // band says the opposite.
    if (unscored.length) {
      sections.push({
        title: t('students.noScore'),
        data: [...unscored].sort((a, b) => a.name.localeCompare(b.name)),
      });
    }
    return sections;
  }

  const buckets = new Map<string, Student[]>();
  for (const s of [...matches].sort((a, b) => a.name.localeCompare(b.name))) {
    const letter = s.name[0]?.toUpperCase() ?? '#';
    const list = buckets.get(letter) ?? [];
    list.push(s);
    buckets.set(letter, list);
  }
  return [...buckets.entries()].map(([title, data]) => ({ title, data }));
}

/** Whether this student has the gap the filter is looking for. */
export function isMissing(s: Student, what: Exclude<MissingFilter, 'any'>): boolean {
  switch (what) {
    case 'phone':
      return !s.phone.trim();
    case 'parent':
      // Phones, not names. A guardian's name with no number is no more use than
      // nothing at all when a child is off sick.
      return !s.parentPhone?.trim() && !s.parent2Phone?.trim();
    case 'birthday':
      return !s.birthDate;
    case 'school':
      return !s.school?.trim();
  }
}

/**
 * Group students under a text heading, with the blanks collected at the end.
 *
 * Shared by the place and school sorts, which are the same operation over
 * different fields. Students with nothing recorded go under one heading last
 * rather than under "#", so the teacher can see at a glance how many are
 * missing it — which is usually why they reached for this sort.
 */
function bucketed(students: Student[], keyOf: (s: Student) => string, blank: string): Section[] {
  const buckets = new Map<string, Student[]>();
  const sorted = [...students].sort(
    (a, b) => keyOf(a).localeCompare(keyOf(b)) || a.name.localeCompare(b.name),
  );
  for (const s of sorted) {
    const key = keyOf(s) || blank;
    buckets.set(key, [...(buckets.get(key) ?? []), s]);
  }
  const entries = [...buckets.entries()];
  return [
    ...entries.filter(([k]) => k !== blank),
    ...entries.filter(([k]) => k === blank),
  ].map(([title, data]) => ({ title, data }));
}
