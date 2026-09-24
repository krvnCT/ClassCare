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
import { useAllGroups, useGroups, useStudents } from '@/data/store';
import { refreshAll } from '@/data/sync';
import type { Gender, Student } from '@/data/types';
import { useT } from '@/i18n/useT';
import type { TranslationKey } from '@/i18n';
import { callNumber, smsNumber } from '@/lib/contact';
import { ageFrom, toKey } from '@/lib/date';
import { levelOf } from '@/lib/courses';
import { exportStudentsSheet, importStudentsSheet } from '@/lib/sheetFlow';
import {
  AGE_BANDS,
  buildSections,
  MISSING_FILTERS,
  schoolKey,
  schoolsOf,
  type AgeBand,
  type GenderFilter,
  type MissingFilter,
  type Section,
  type SortMode,
} from '@/lib/studentFilter';
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

export default function Students() {
  const t = useT();
  const { color, scheme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const bottomInset = useTabInset(24);
  const router = useRouter();

  const students = useStudents();
  const groups = useGroups();
  /*
    The teaching list and the whole list are both needed, and they answer
    different questions.

    `groups` is what is being taught now — the headline count, the tags on a
    row. `allGroups` is the student's history, and three things here are about
    history rather than this week: which terms exist, which of them a student
    was in, and what level they are at. `levelOf` counts *finished* courses and
    an archived course is finished by definition, so feeding it the teaching
    list alone made the students tab read a level lower than the student's own
    page did for anybody whose courses had been filed away.
  */
  const allGroups = useAllGroups();
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

  /**
   * Terms the teacher actually has, newest first. No term, no chip.
   *
   * Finished terms included: "who was in the autumn lot" is a question about a
   * term that is over, and it is the one asked when results go out or the next
   * intake opens. Without the archived groups the filter offered this term and
   * nothing else, and a student whose courses had all ended matched no term at
   * all.
   */
  const terms = useMemo(() => {
    const seen = new Set<string>();
    for (const g of allGroups) {
      const key = termFor(g);
      if (key) seen.add(key);
    }
    return [...seen].sort((a, b) => compareTerms(b, a));
  }, [allGroups, termFor]);

  /** Which terms each student belongs to, through their groups. */
  const termsByStudent = useMemo(() => {
    const groupTerm = new Map(allGroups.map((g) => [g.id, termFor(g)]));
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
  }, [students, allGroups, termFor]);

  /**
   * The group names each student is in, as one string for the search.
   *
   * So "matematika" finds the students in the maths class, which is how a
   * teacher looks for a class they have not got the name of exactly right.
   */
  const groupNamesByStudent = useMemo(() => {
    const nameById = new Map(allGroups.map((g) => [g.id, `${g.name} ${g.subject}`]));
    return new Map(
      students.map((s) => [
        s.id,
        s.groupIds
          .map((id) => nameById.get(id))
          .filter(Boolean)
          .join(' '),
      ]),
    );
  }, [students, allGroups]);

  /** Schools the teacher actually has. Shared with the sort — see `schoolsOf`. */
  const schools = useMemo(() => schoolsOf(students), [students]);

  /**
   * Every student's level, computed once.
   *
   * `levelOf` walks the student's groups and counts the finished ones, so doing
   * it inside the filter would walk every group for every student on every
   * keystroke in the search box.
   */
  const levelByStudent = useMemo(() => {
    const today = toKey(new Date());
    return new Map(students.map((s) => [s.id, levelOf(s, allGroups, today)]));
  }, [students, allGroups]);

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
        groupNamesByStudent,
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
      groupNamesByStudent,
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
