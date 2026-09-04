import { useRouter } from 'expo-router';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  RefreshControl,
  ScrollView,
  SectionList,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { AlphabetIndex } from '@/components/AlphabetIndex';
import { Icon } from '@/components/Icon';
import { Screen, useTabInset } from '@/components/layout';
import { Avatar, EmptyState, IconButton, Press, SelectChip } from '@/components/ui';
import { useGroups, useStudents } from '@/data/store';
import { refreshAll } from '@/data/sync';
import type { Gender, Student } from '@/data/types';
import { useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n';
import { callNumber, smsNumber } from '@/lib/contact';
import { ageFrom, toKey } from '@/lib/date';
import { levelOf } from '@/lib/courses';
import { genderOf } from '@/lib/names';
import { exportStudentsSheet, importStudentsSheet } from '@/lib/sheetFlow';
import { compareTerms, termLabel, termOf } from '@/lib/term';
import { radius, space, useTheme, useThemedStyles, type AccentName, type Theme } from '@/theme';
import { body, text } from '@/theme/type';

/**
 * The full address book.
 *
 * Long lists are the point of this screen: a tutor with sixty students cannot
 * find one by scrolling, so everything here is about narrowing. Search on the
 * text, filters on the facts, a letter rail for the last few centimetres.
 *
 * ## Row and header heights are constants, deliberately
 *
 * `scrollToLocation` — what the rail calls — has to know where a section starts
 * before it has been rendered. Without `getItemLayout` it guesses from whatever
 * has been measured so far and lands in the wrong place on a list this long.
 * So the row height is fixed and the group tags are capped at two with a "+3"
 * for the rest, which is also the reason the rows stay a tidy grid rather than
 * growing a line whenever a child joins a fourth group.
 */

/** Row box: 42 avatar, 11 padding each side, 1 border each side, 8 gap below. */
const ROW_H = 74;
/** Section letter: 14 above, ~14 of text, 8 below. */
const HEADER_H = 36;
/** `contentContainerStyle.paddingTop`, above the first header. */
const LIST_TOP = 14;
/** Group tags on a row before the rest become a count. */
const TAGS_SHOWN = 2;

type GenderFilter = 'any' | Gender | 'none';
type SortMode = 'name' | 'place' | 'school' | 'level' | 'score';

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
type MissingFilter = 'any' | 'phone' | 'parent' | 'birthday' | 'school';

const MISSING_FILTERS = [
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
const SCORE_BANDS = [
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
const schoolKey = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Age bands rather than a slider.
 *
 * A tutor thinks in school stages — the little ones, the exam years — not in
 * "students aged 11 to 14". Bands make the common questions one tap, and a
 * slider would make every one of them a fiddle.
 */
const AGE_BANDS = [
  { key: 'under10', labelKey: 'students.ageUnder' as TranslationKey, params: { age: 10 }, min: 0, max: 9 },
  { key: '10to13', labelKey: 'students.ageBetween' as TranslationKey, params: { from: 10, to: 13 }, min: 10, max: 13 },
  { key: '14to17', labelKey: 'students.ageBetween' as TranslationKey, params: { from: 14, to: 17 }, min: 14, max: 17 },
  { key: '18plus', labelKey: 'students.ageOver' as TranslationKey, params: { age: 18 }, min: 18, max: 200 },
] as const;

type AgeBand = (typeof AGE_BANDS)[number]['key'] | 'any';

export default function Students() {
  const t = useT();
  const { color, scheme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const bottomInset = useTabInset(24);
  const router = useRouter();

  const students = useStudents();
  const groups = useGroups();
  const [query, setQuery] = useState('');

  const [gender, setGender] = useState<GenderFilter>('any');
  const [term, setTerm] = useState<string>('any');
  const [age, setAge] = useState<AgeBand>('any');
  const [school, setSchool] = useState<string>('any');
  const [level, setLevel] = useState<string>('any');
  const [missing, setMissing] = useState<MissingFilter>('any');
  const [sort, setSort] = useState<SortMode>('name');
  const [showFilters, setShowFilters] = useState(false);

  const listRef = useRef<SectionList<Student, Section>>(null);

  const activeCount =
    (gender === 'any' ? 0 : 1) +
    (term === 'any' ? 0 : 1) +
    (age === 'any' ? 0 : 1) +
    (school === 'any' ? 0 : 1) +
    (level === 'any' ? 0 : 1) +
    (missing === 'any' ? 0 : 1);

  const clearFilters = () => {
    setGender('any');
    setTerm('any');
    setAge('any');
    setSchool('any');
    setLevel('any');
    setMissing('any');
    setSort('name');
  };

  /*
    Pull down to pull the account down.

    Only the inbox had this, so a teacher who suspected the list was out of date
    — a student added on another phone, a face that had not come through — had
    no way to ask for a fresh copy short of killing the app. `hydrate` also
    fetches any pictures this device is missing, which is the half of it people
    actually notice.
  */
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refreshAll();
    } catch {
      // Offline, or the proxy is down. The list keeps what it had; an alert
      // would fire on every pull made on a bad connection, which is most of
      // them here.
    } finally {
      setRefreshing(false);
    }
  }, []);

  /*
    A group's term, falling back to the one its start date implies.

    Only groups created or edited since terms existed carry one, and a teacher
    who has been using this app for a year would otherwise open the filter to
    find no terms at all — every course they have ever run invisible to it until
    they went through and re-saved each one. The start date already says which
    season a course belongs to; `termOf` is the same reading of it the group
    form offers as its default, so the filter and the form agree.

    Derived on read rather than written back: a stored term is the teacher's
    answer and a derived one is a guess, and quietly turning the second into the
    first would overwrite a deliberate choice on the next sync.
  */
  const thisTerm = useMemo(() => termOf(toKey(new Date())), []);

  const termFor = useCallback(
    (g: { term?: string; startsOn?: string }) =>
      // A group with neither is one that predates dates entirely, and a group
      // with no first and no last day is by definition still running — so the
      // term it belongs to is this one. Without this last step a teacher whose
      // groups all predate migration 0016 opens the filter to an empty row,
      // which is the bug this whole fallback exists to prevent.
      g.term ?? (g.startsOn ? termOf(g.startsOn) : thisTerm),
    [thisTerm],
  );

  /** Terms the teacher actually has, newest first. No term, no chip. */
  const terms = useMemo(() => {
    const seen = new Set<string>();
    for (const g of groups) {
      const key = termFor(g);
      if (key) seen.add(key);
    }
    return [...seen].sort((a, b) => compareTerms(b, a));
  }, [groups, termFor]);

  /** Which terms each student belongs to, through their groups. */
  const termsByStudent = useMemo(() => {
    const groupTerm = new Map(groups.map((g) => [g.id, termFor(g)]));
    const out = new Map<string, Set<string>>();
    for (const s of students) {
      const set = new Set<string>();
      for (const id of s.groupIds) {
        const gt = groupTerm.get(id);
        if (gt) set.add(gt);
      }
      out.set(s.id, set);
    }
    return out;
  }, [students, groups, termFor]);

  /**
   * Schools the teacher actually has, with the spelling they used most.
   *
   * Built from the data rather than a fixed list, the same as terms: a tutor's
   * students come from four or five schools and nobody is going to maintain a
   * table of them. The label shown is the commonest spelling of each key, so a
   * school typed once with a stray capital does not decide how the chip reads.
   */
  const schools = useMemo(() => {
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
  }, [students]);

  /**
   * Every student's level, computed once.
   *
   * `levelOf` walks the student's groups and counts the finished ones, so doing
   * it inside the filter would walk every group for every student on every
   * keystroke in the search box.
   */
  const levelByStudent = useMemo(() => {
    const today = toKey(new Date());
    return new Map(students.map((s) => [s.id, levelOf(s, groups, today)]));
  }, [students, groups]);

  /** Levels anybody is actually at, low to high. No students, no chip. */
  const levels = useMemo(
    () => [...new Set(levelByStudent.values())].sort((a, b) => a - b),
    [levelByStudent],
  );

  const sections = useMemo(
    () =>
      buildSections({
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
        t,
      }),
    [
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
      t,
    ],
  );

  /** Where every cell sits, so the rail can jump to one that has never rendered. */
  const layout = useMemo(() => offsetsFor(sections), [sections]);

  const letters = useMemo(() => {
    const out: string[] = [];
    for (const s of sections) {
      const first = s.title[0]?.toUpperCase() ?? '#';
      if (out[out.length - 1] !== first) out.push(first);
    }
    return out;
  }, [sections]);

  const jumpTo = useCallback(
    (letterIndex: number) => {
      const letter = letters[letterIndex];
      const sectionIndex = sections.findIndex((s) => (s.title[0]?.toUpperCase() ?? '#') === letter);
      if (sectionIndex < 0) return;
      listRef.current?.scrollToLocation({
        sectionIndex,
        // Cell 0 of a section is its *header*, not its first row —
        // `VirtualizedSectionList` reserves a header and a footer slot for
        // every section, and `scrollToLocation` counts both. So this already
        // lands on the letter, and the only offset wanted is a little air
        // above it.
        itemIndex: 0,
        viewOffset: 6,
        animated: false,
      });
    },
    [letters, sections],
  );

  return (
    <Screen>
      <View style={[styles.header, { paddingTop: insets.top + 6 }]}>
        <View style={styles.headerRow}>
          <View style={{ flex: 1 }}>
            <Text style={[text.pageTitle, styles.ink]}>{t('nav.students')}</Text>
            <Text style={styles.count}>
              {t('students.acrossGroups', { count: students.length, groups: groups.length })}
            </Text>
          </View>
          <IconButton
            name="grades"
            iconSize={18}
            fg={color.inkSoft}
            accessibilityLabel={t('nav.grades')}
            onPress={() => router.push('/grades')}
            style={{ marginRight: 8 }}
          />
          <IconButton
            name="plusLarge"
            iconSize={19}
            tint={color.primary}
            fg="#fff"
            onPress={() => router.push('/student/new')}
          />
        </View>

        <View style={styles.search}>
          <Icon name="search" size={17} color={color.mutedLight} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('students.searchPlaceholder')}
            placeholderTextColor={color.mutedLight}
            style={styles.searchInput}
            autoCorrect={false}
            clearButtonMode="while-editing"
            selectionColor={color.primary}
            keyboardAppearance={scheme === 'dark' ? 'dark' : 'light'}
          />
        </View>

        {/*
          One button, not a permanent wall of chips.

          Filters are a rare gesture and the search field is a daily one; four
          rows of options sitting open above the list would push the students
          themselves off the screen every time somebody opened this tab. The
          count on the button is what stops a filter being left on by accident
          and read as an empty address book.
        */}
        <View style={styles.filterBar}>
          <Press
            haptic
            onPress={() => setShowFilters((v) => !v)}
            style={[styles.filterButton, activeCount > 0 && styles.filterButtonOn]}>
            <Icon
              name="sliders"
              size={15}
              color={activeCount > 0 ? color.primaryInk : color.inkSoft}
            />
            <Text style={[styles.filterLabel, activeCount > 0 && { color: color.primaryInk }]}>
              {activeCount > 0
                ? t('students.filterCount', { count: activeCount })
                : t('students.filters')}
            </Text>
          </Press>
          {activeCount > 0 || sort !== 'name' ? (
            <Press haptic onPress={clearFilters} style={styles.clearButton}>
              <Text style={styles.clearLabel}>{t('students.clearFilters')}</Text>
            </Press>
          ) : null}
        </View>
      </View>

      {showFilters ? (
        <View style={styles.panel}>
          <FilterRow label={t('student.gender')}>
            <SelectChip
              height={32}
              label={t('students.anyGender')}
              selected={gender === 'any'}
              onPress={() => setGender('any')}
            />
            <SelectChip
              height={32}
              label={t('students.female')}
              selected={gender === 'female'}
              onPress={() => setGender('female')}
            />
            <SelectChip
              height={32}
              label={t('students.male')}
              selected={gender === 'male'}
              onPress={() => setGender('male')}
            />
            <SelectChip
              height={32}
              label={t('students.notRecorded')}
              selected={gender === 'none'}
              onPress={() => setGender('none')}
            />
          </FilterRow>

          {terms.length ? (
            <FilterRow label={t('groups.term')}>
              <SelectChip
                height={32}
                label={t('students.anyTerm')}
                selected={term === 'any'}
                onPress={() => setTerm('any')}
              />
              {terms.map((key) => (
                <SelectChip
                  key={key}
                  height={32}
                  label={termLabel(key, t)}
                  selected={term === key}
                  onPress={() => setTerm(key)}
                />
              ))}
            </FilterRow>
          ) : null}

          <FilterRow label={t('students.age')}>
            <SelectChip
              height={32}
              label={t('students.anyAge')}
              selected={age === 'any'}
              onPress={() => setAge('any')}
            />
            {AGE_BANDS.map((b) => (
              <SelectChip
                key={b.key}
                height={32}
                label={t(b.labelKey, b.params)}
                selected={age === b.key}
                onPress={() => setAge(b.key)}
              />
            ))}
          </FilterRow>

          {schools.length ? (
            <FilterRow label={t('student.school')}>
              <SelectChip
                height={32}
                label={t('students.anySchool')}
                selected={school === 'any'}
                onPress={() => setSchool('any')}
              />
              {schools.map((s) => (
                <SelectChip
                  key={s.key}
                  height={32}
                  label={s.label}
                  selected={school === s.key}
                  onPress={() => setSchool(s.key)}
                />
              ))}
              <SelectChip
                height={32}
                label={t('students.noSchool')}
                selected={school === 'none'}
                onPress={() => setSchool('none')}
              />
            </FilterRow>
          ) : null}

          {/* One level means nobody has finished a course yet, and a row with a
              single chip in it is a row that only takes up space. */}
          {levels.length > 1 ? (
            <FilterRow label={t('students.level')}>
              <SelectChip
                height={32}
                label={t('students.anyLevel')}
                selected={level === 'any'}
                onPress={() => setLevel('any')}
              />
              {levels.map((n) => (
                <SelectChip
                  key={n}
                  height={32}
                  label={t('students.levelN', { level: n })}
                  selected={level === String(n)}
                  onPress={() => setLevel(String(n))}
                />
              ))}
            </FilterRow>
          ) : null}

          <FilterRow label={t('students.missing')}>
            <SelectChip
              height={32}
              label={t('students.missingNone')}
              selected={missing === 'any'}
              onPress={() => setMissing('any')}
            />
            {MISSING_FILTERS.map((m) => (
              <SelectChip
                key={m.key}
                height={32}
                label={t(m.labelKey)}
                selected={missing === m.key}
                onPress={() => setMissing(m.key)}
              />
            ))}
          </FilterRow>

          <FilterRow label={t('students.sortBy')}>
            <SelectChip
              height={32}
              label={t('students.sortName')}
              selected={sort === 'name'}
              onPress={() => setSort('name')}
            />
            <SelectChip
              height={32}
              label={t('students.sortPlace')}
              selected={sort === 'place'}
              onPress={() => setSort('place')}
            />
            <SelectChip
              height={32}
              label={t('students.sortSchool')}
              selected={sort === 'school'}
              onPress={() => setSort('school')}
            />
            <SelectChip
              height={32}
              label={t('students.sortLevel')}
              selected={sort === 'level'}
              onPress={() => setSort('level')}
            />
            <SelectChip
              height={32}
              label={t('students.sortScore')}
              selected={sort === 'score'}
              onPress={() => setSort('score')}
            />
          </FilterRow>
        </View>
      ) : null}

      {/*
        Under the search, not in the header.

        The header bar is where "add one student" lives, and a spreadsheet is
        the opposite gesture — a rare, deliberate, whole-list action. Putting it
        in the same row would crowd the one button teachers press every day.
      */}
      <View style={styles.sheetRow}>
        <Press onPress={() => void importStudentsSheet()} style={styles.sheetButton}>
          <Icon name="paperclip" size={15} color={color.primary} />
          <Text style={styles.sheetLabel}>{t('csv.import')}</Text>
        </Press>
        <Press onPress={() => void exportStudentsSheet()} style={styles.sheetButton}>
          <Icon name="send" size={15} color={color.primary} />
          <Text style={styles.sheetLabel}>{t('csv.export')}</Text>
        </Press>
      </View>

      <View style={{ flex: 1 }}>
        <SectionList
          ref={listRef}
          sections={sections}
          keyExtractor={(s) => s.id}
          stickySectionHeadersEnabled={false}
          keyboardShouldPersistTaps="handled"
          getItemLayout={layout}
          contentContainerStyle={{
            paddingHorizontal: space.gutter,
            paddingTop: LIST_TOP,
            paddingBottom: bottomInset,
          }}
          // The rail needs somewhere to live that is not on top of a row's
          // call button, and the letters are legible against the gutter.
          style={{ paddingRight: 18 }}
          showsVerticalScrollIndicator={false}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={color.muted}
              colors={[color.primary]}
              progressBackgroundColor={color.surface}
            />
          }
          ListEmptyComponent={
            <EmptyState
              title={activeCount > 0 ? t('students.noneMatch') : t('students.noMatches')}
              hint={t('students.tryAnother')}
            />
          }
          renderSectionHeader={({ section }) => (
            <Text style={styles.sectionLetter} numberOfLines={1}>
              {section.title}
            </Text>
          )}
          renderItem={({ item }) => (
            <StudentRow
              student={item}
              groupNames={groups
                .filter((g) => item.groupIds.includes(g.id))
                .map((g) => ({ name: g.name, accent: g.accent }))}
              onPress={() => router.push(`/student/${item.id}`)}
            />
          )}
        />

        <AlphabetIndex letters={letters} onPick={jumpTo} />
      </View>
    </Screen>
  );
}

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  const styles = useThemedStyles(makeStyles);
  return (
    <View style={styles.filterRow}>
      <Text style={styles.filterRowLabel}>{label}</Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.filterChips}>
        {children}
      </ScrollView>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Filtering, sorting, sectioning                                             */
/* -------------------------------------------------------------------------- */

type Section = { title: string; data: Student[] };

/**
 * Where a student lives, as a heading.
 *
 * The first comma-separated part of the address, which is how people write
 * these — "Aşgabat, Görogly köçesi 12" is a city and a street, and the city is
 * the useful bucket. An address with no comma is its own heading, which for a
 * tutor whose students all live in one town is exactly right: the streets
 * become the groups.
 */
const placeOf = (s: Student) => (s.address ?? '').split(',')[0]?.trim() ?? '';

function buildSections({
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
  t: (key: TranslationKey, vars?: Record<string, string | number>) => string;
}): Section[] {
  const q = query.trim().toLowerCase();
  const digits = q.replace(/\s/g, '');
  const band = AGE_BANDS.find((b) => b.key === age);

  const matches = students.filter((s) => {
    if (q) {
      // The school is searched too, so a teacher who remembers where a child
      // goes but not how their surname is spelled can still find them — which
      // is the commoner of the two by some way.
      const hit =
        s.name.toLowerCase().includes(q) ||
        s.phone.replace(/\s/g, '').includes(digits) ||
        (s.address ?? '').toLowerCase().includes(q) ||
        (s.school ?? '').toLowerCase().includes(q);
      if (!hit) return false;
    }

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

    if (term !== 'any' && !termsByStudent.get(s.id)?.has(term)) return false;

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
    return bucketed(matches, (s) => s.school?.trim() ?? '', t('students.noSchool'));
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
function isMissing(s: Student, what: Exclude<MissingFilter, 'any'>): boolean {
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

/**
 * A `getItemLayout` for the section list, from constant row and header heights.
 *
 * `SectionList` reserves a header *and* a footer cell for every section whether
 * or not either is rendered, so the flattened index this is called with counts
 * both. The footer is given zero height because nothing is drawn in it —
 * getting that wrong shifts every section below it by a row.
 *
 * Offsets are computed once per list rather than walked on each call: this is
 * asked for every cell, and the walk would make rendering quadratic in a list
 * whose whole problem is that it is long.
 */
function offsetsFor(sections: Section[]) {
  const offsets: number[] = [];
  const heights: number[] = [];
  let offset = LIST_TOP;

  for (const section of sections) {
    offsets.push(offset);
    heights.push(HEADER_H);
    offset += HEADER_H;

    for (let i = 0; i < section.data.length; i += 1) {
      offsets.push(offset);
      heights.push(ROW_H);
      offset += ROW_H;
    }

    offsets.push(offset);
    heights.push(0);
  }

  return (_data: unknown, index: number) => ({
    length: heights[index] ?? 0,
    offset: offsets[index] ?? offset,
    index,
  });
}

/* -------------------------------------------------------------------------- */
/* Row                                                                        */
/* -------------------------------------------------------------------------- */

function StudentRow({
  student,
  groupNames,
  onPress,
}: {
  student: Student;
  groupNames: { name: string; accent: AccentName }[];
  onPress: () => void;
}) {
  const t = useT();
  const { accents, color, status } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const shown = groupNames.slice(0, TAGS_SHOWN);
  const extra = groupNames.length - shown.length;

  return (
    <Press onPress={onPress} style={styles.row}>
      <Avatar
        name={student.name}
        accent={student.accent}
        photoId={student.id}
        size={42}
        radius={radius.button}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[text.rowTitleSm, styles.ink]} numberOfLines={1}>
          {student.name}
        </Text>
        <View style={styles.tagRow}>
          {shown.length ? (
            <>
              {shown.map((g) => (
                <View
                  key={g.name}
                  style={[styles.tag, { backgroundColor: accents[g.accent].tint }]}>
                  <Text
                    style={[styles.tagLabel, { color: accents[g.accent].inkDeep }]}
                    numberOfLines={1}>
                    {g.name}
                  </Text>
                </View>
              ))}
              {extra > 0 ? <Text style={styles.moreTag}>{`+${extra}`}</Text> : null}
            </>
          ) : (
            <Text style={styles.noGroup}>{t('messages.noGroupSelected')}</Text>
          )}
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <IconButton
          name="phone"
          size={40}
          iconSize={15}
          radius={radius.control}
          tint={status.present.tint}
          fg={color.success}
          onPress={() => callNumber(student.phone)}
        />
        <IconButton
          name="chat"
          size={40}
          iconSize={15}
          radius={radius.control}
          tint={color.bg}
          fg={color.inkSoft}
          onPress={() => smsNumber(student.phone)}
        />
      </View>
    </Press>
  );
}

const makeStyles = ({ color, shadow }: Theme) =>
  StyleSheet.create({
    sheetRow: {
      flexDirection: 'row',
      gap: 10,
      paddingHorizontal: space.gutter,
      paddingTop: 12,
    },
    sheetButton: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      height: 40,
      borderRadius: radius.field,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
    },
    sheetLabel: { fontFamily: body[700], fontSize: 13, color: color.primaryInk },

    /** Default body ink. Text does not inherit colour from a parent View. */
    ink: { color: color.ink },
    header: {
      backgroundColor: color.surface,
      borderBottomWidth: 1,
      borderBottomColor: color.border,
      paddingHorizontal: space.gutter,
      paddingBottom: 14,
      ...shadow.card,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingBottom: 14,
    },
    count: {
      fontFamily: body[400],
      fontSize: 12.5,
      color: color.mutedLight,
      marginTop: 3,
    },
    search: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      height: 44,
      paddingHorizontal: 14,
      borderRadius: radius.field,
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.border,
    },
    searchInput: {
      flex: 1,
      minWidth: 0,
      fontFamily: body[400],
      fontSize: 15,
      color: color.ink,
      padding: 0,
    },

    filterBar: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 10 },
    filterButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      height: 34,
      paddingHorizontal: 12,
      borderRadius: radius.field,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
    },
    filterButtonOn: { borderColor: color.primary, backgroundColor: color.primaryTint },
    filterLabel: { fontFamily: body[600], fontSize: 13, color: color.inkSoft },
    clearButton: { height: 34, justifyContent: 'center', paddingHorizontal: 8 },
    clearLabel: { fontFamily: body[600], fontSize: 13, color: color.primary },

    panel: {
      paddingTop: 12,
      paddingBottom: 4,
      backgroundColor: color.surface,
      borderBottomWidth: 1,
      borderBottomColor: color.border,
    },
    filterRow: { marginBottom: 10 },
    filterRowLabel: {
      fontFamily: body[700],
      fontSize: 11,
      letterSpacing: 0.66,
      textTransform: 'uppercase',
      color: color.mutedLight,
      paddingHorizontal: space.gutter,
      marginBottom: 7,
    },
    filterChips: { gap: 8, paddingHorizontal: space.gutter },

    sectionLetter: {
      fontFamily: body[700],
      fontSize: 11.5,
      letterSpacing: 1.38,
      color: color.mutedLight,
      height: HEADER_H,
      lineHeight: HEADER_H - 8,
      paddingTop: 14,
      marginLeft: 2,
    },
    row: {
      height: ROW_H - 8,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: color.surface,
      borderWidth: 1,
      borderColor: color.border,
      borderRadius: radius.tile,
      paddingLeft: 13,
      paddingRight: 12,
      marginBottom: 8,
    },
    tagRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 5 },
    tag: {
      maxWidth: 110,
      paddingHorizontal: 7,
      paddingVertical: 3,
      borderRadius: radius.xs + 1,
    },
    tagLabel: { fontFamily: body[600], fontSize: 10.5 },
    moreTag: { fontFamily: body[600], fontSize: 10.5, color: color.mutedLight },
    noGroup: { fontFamily: body[400], fontSize: 12.5, color: color.mutedLight },
  });
