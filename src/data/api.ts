import type {
  Assessment,
  AssessmentType,
  MessageTemplate,
  AttendanceRecord,
  AttendanceStatus,
  Audience,
  CalendarEvent,
  Channel,
  DocumentKind,
  Grade,
  Group,
  GroupPatch,
  Message,
  Reply,
  SentMessageLog,
  Student,
  Weekday,
} from '@/data/types';
import type {
  AssessmentRow,
  AssessmentTypeRow,
  AttendanceRow,
  CalendarEventRow,
  GradeRow,
  GroupRow,
  GroupSlotRow,
  MessageTemplateRow,
  MessageRow,
  ReplyRow,
  StudentRow,
  TeacherRow,
} from '@/lib/database.types';
import { AppState } from 'react-native';

import { translateNow } from '@/i18n/useT';
import { documentKey } from '@/lib/studentDocs';
import { supabase } from '@/lib/supabase';

/**
 * The repository layer: the only place that knows about table names and row
 * shapes. Screens keep speaking the domain types in `data/types.ts`, so
 * swapping the local store for the network is a change confined to `store.ts`.
 */

/* -------------------------------------------------------------------------- */
/* Mappers                                                                    */
/* -------------------------------------------------------------------------- */

/** Postgres `time` comes back as `HH:MM:SS`; the app works in `HH:MM`. */
const hhmm = (t: string) => t.slice(0, 5);

const toGroup = (row: GroupRow, slots: GroupSlotRow[]): Group => ({
  id: row.id,
  name: row.name,
  subject: row.subject,
  room: row.room,
  accent: row.accent,
  // `undefined` rather than null, so an absent bound reads the same here as it
  // does on a group the device made itself and never sent.
  startsOn: row.starts_on ?? undefined,
  endsOn: row.ends_on ?? undefined,
  term: row.term ?? undefined,
  archivedAt: row.archived_at ?? undefined,
  slots: slots
    .filter((s) => s.group_id === row.id)
    .map((s) => ({
      day: s.weekday as Weekday,
      start: hhmm(s.starts_at),
      end: hhmm(s.ends_at),
    })),
});

const toStudent = (row: StudentRow, groupIds: string[]): Student => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  email: row.email ?? undefined,
  birthDate: row.birth_date ?? undefined,
  address: row.address ?? undefined,
  school: row.school ?? undefined,
  gender: (row.gender as Student['gender']) ?? undefined,
  surname: row.surname ?? undefined,
  patronymic: row.patronymic ?? undefined,
  documentId: row.document_id ?? undefined,
  documentKind: documentKindOf(row.document_kind),
  levelBase: row.level_base ?? undefined,
  parentName: row.parent_name ?? undefined,
  parentPhone: row.parent_phone ?? undefined,
  parentEmail: row.parent_email ?? undefined,
  parentWork: row.parent_work ?? undefined,
  parent2Name: row.parent2_name ?? undefined,
  parent2Phone: row.parent2_phone ?? undefined,
  parent2Email: row.parent2_email ?? undefined,
  parent2Work: row.parent2_work ?? undefined,
  accent: row.accent,
  photoPath: row.photo_path ?? undefined,
  note: row.note ?? undefined,
  avgScore: row.avg_score ?? undefined,
  groupIds,
});

const toMessage = (
  row: MessageRow,
  groupIds: string[],
  delivered: number,
  total: number,
): Message => ({
  id: row.id,
  groupIds,
  audience: row.audience,
  channels: row.channels,
  body: row.body,
  sentAt: new Date(row.sent_at).getTime(),
  delivered,
  total,
  announcement: row.announcement,
  isAssignment: row.is_assignment ?? false,
});

const toReply = (row: ReplyRow, accent: Reply['accent']): Reply => ({
  id: row.id,
  authorName: row.author_name,
  studentId: row.student_id ?? undefined,
  context: row.context,
  accent,
  body: row.body,
  at: new Date(row.received_at).getTime(),
  unread: row.read_at == null,
});

type PostgrestFailure = {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
};

/**
 * Supabase returns `{ data, error, status }`; throw so callers can use try/catch.
 *
 * The thrown error keeps the HTTP status and the Postgres code. It used to be a
 * bare `Error(message)`, which threw both away — so the sync queue could not
 * tell "the proxy is overloaded, try again" (a 503 from shared hosting under a
 * burst of writes) from "this row breaks a constraint". It treated both as
 * permanent and dropped the write, which is one of the ways a large import
 * reached the device and never the account. `describeError` reads `code` and
 * `status` off whatever it is given, so keeping them is all it takes.
 */
function unwrap<T>({
  data,
  error,
  status,
}: {
  data: T | null;
  error: PostgrestFailure | null;
  status?: number;
}): T {
  if (error) {
    const e = new Error(error.message) as Error & {
      code?: string;
      status?: number;
      details?: string | null;
    };
    e.code = error.code;
    e.status = status;
    e.details = error.details;
    throw e;
  }
  return data as T;
}

/**
 * Rows per request when reading a whole table.
 *
 * PostgREST answers any request with at most `max_rows` rows — 1000 on every
 * Supabase project unless somebody changed it — and says nothing about the
 * rest. Asking for exactly that much keeps each request as large as the server
 * allows.
 */
const PAGE = 1000;

type Page<T> = PromiseLike<{
  data: T[] | null;
  error: PostgrestFailure | null;
  status?: number;
  count?: number | null;
}>;

/**
 * Every row a query matches, however many there are.
 *
 * Each read here used to be a single request, and so silently stopped at 1000
 * rows. That ceiling is not far away for a tutor: 400 students in two or three
 * courses each is over a thousand memberships, and a term of registers is
 * thousands of attendance rows. The pull then *replaced* the device's copy with
 * the truncated one — students lost their courses and vanished from their
 * terms, registers emptied — some time after an import had reported success.
 *
 * The first page asks for the exact count, so a server configured with a lower
 * limit than `PAGE` is paged correctly too: the loop runs until it holds that
 * many, not until a page comes back short. Every query passed in must have a
 * total order (a unique column last), or rows can repeat or go missing at page
 * boundaries.
 */
async function everyRow<T>(page: (from: number, to: number, count: boolean) => Page<T>): Promise<T[]> {
  const out: T[] = [];
  let total: number | null = null;

  for (;;) {
    const result = await page(out.length, out.length + PAGE - 1, total === null);
    const rows = unwrap(result) ?? [];
    if (total === null) total = typeof result.count === 'number' ? result.count : -1;
    out.push(...rows);

    // An empty page ends it whatever the count said: rows deleted while the
    // pages were being read would otherwise leave this asking forever.
    if (!rows.length) break;
    if (total >= 0 ? out.length >= total : rows.length < PAGE) break;
  }
  return out;
}

/** `{ count: 'exact' }` on the first page only — see `everyRow`. */
const counted = (count: boolean) => (count ? ({ count: 'exact' } as const) : undefined);

/**
 * Who is signed in, without asking the server.
 *
 * `getUser()` looks local and is not: it posts to `/auth/v1/user` on every
 * call to have the token validated. On a connection that is down — which for
 * these teachers is a normal Tuesday — that request fails, the user comes back
 * null, and this threw "Not signed in", which `describeError` classifies as an
 * auth failure and puts on screen as a session that has expired. Nothing had
 * expired. The phone simply could not reach the internet.
 *
 * `getSession()` reads the stored session and only touches the network when
 * the access token has actually aged out, which is the question being asked.
 */
const requireUser = async () => {
  const { data } = await supabase.auth.getSession();
  const id = data.session?.user?.id;
  if (!id) throw new Error('Not signed in');
  return id;
};

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function fetchGroups(): Promise<Group[]> {
  const [groups, slots] = await Promise.all([
    /*
      Archived groups come down too.

      They used to be filtered out here, which made archiving and deleting the
      same thing as far as the device was concerned: the group vanished on the
      next sync and its marks and registers had nothing left to hang off. The
      archive is a place a teacher goes to *read* a finished course, so the rows
      have to be here to read. `useGroups` is what keeps them out of the
      teaching screens.
    */
    everyRow<GroupRow>((from, to, count) =>
      supabase
        .from('groups')
        .select('*', counted(count))
        .order('created_at')
        .order('id')
        .range(from, to),
    ),
    everyRow<GroupSlotRow>((from, to, count) =>
      supabase.from('group_slots').select('*', counted(count)).order('id').range(from, to),
    ),
  ]);

  // Indexed once: `toGroup` filtering the whole slot list per group was fine at
  // ten groups and quadratic at a few hundred.
  const slotsByGroup = new Map<string, GroupSlotRow[]>();
  for (const s of slots) {
    const list = slotsByGroup.get(s.group_id);
    if (list) list.push(s);
    else slotsByGroup.set(s.group_id, [s]);
  }
  return groups.map((g) => toGroup(g, slotsByGroup.get(g.id) ?? []));
}

export async function fetchStudents(): Promise<Student[]> {
  const [studentRows, linkRows] = await Promise.all([
    everyRow<StudentRow>((from, to, count) =>
      supabase
        .from('students')
        .select('*', counted(count))
        .is('archived_at', null)
        .order('name')
        .order('id')
        .range(from, to),
    ),
    /*
      The table most likely to cross the line first. Every membership is a row,
      so a few hundred students in two or three courses each is past a thousand
      — and a truncated answer here does not lose students, it silently takes
      their courses away, which is worse because they still look present.
    */
    everyRow<{ student_id: string; group_id: string }>((from, to, count) =>
      supabase
        .from('student_groups')
        .select('student_id, group_id', counted(count))
        .order('student_id')
        .order('group_id')
        .range(from, to),
    ),
  ]);

  const byStudent = new Map<string, string[]>();
  for (const l of linkRows) {
    const list = byStudent.get(l.student_id) ?? [];
    list.push(l.group_id);
    byStudent.set(l.student_id, list);
  }
  return studentRows.map((s) => toStudent(s, byStudent.get(s.id) ?? []));
}

/**
 * Saved attendance, keyed the same way the app keys it locally
 * (`groupId@YYYY-MM-DD#HH:MM`), so the store can merge server rows straight in.
 */
export async function fetchAttendance(since?: Date): Promise<Record<string, AttendanceRecord>> {
  /*
    Paged: one row per student per session, so a class of twenty passes a
    thousand rows inside a term. A single request stopped there, and the pull
    replaced the device's registers with whatever fitted — the oldest sessions
    simply emptied.
  */
  const rows = await everyRow<AttendanceRow>((from, to, count) => {
    let q = supabase.from('attendance').select('*', counted(count));
    if (since) q = q.gte('session_date', since.toISOString().slice(0, 10));
    return q.order('id').range(from, to);
  });

  const out: Record<string, AttendanceRecord> = {};
  for (const r of rows) {
    const key = `${r.group_id}@${r.session_date}#${hhmm(r.starts_at)}`;
    (out[key] ??= {})[r.student_id] = r.status;
  }
  return out;
}

/**
 * How much history a sync pulls back.
 *
 * Was 50, which is roughly a fortnight for a teacher with four groups — and a
 * hard ceiling that quietly deleted the rest. A backup carrying a term of sent
 * messages imported fine and then lost everything past the newest fifty at the
 * first sync, which reads exactly like the import having failed.
 *
 * 500 is more than a year for the same teacher, and these rows are small: a
 * body, a few delivery states, no attachments.
 */
const HISTORY_LIMIT = 500;

export async function fetchMessages(limit = HISTORY_LIMIT): Promise<Message[]> {
  const rows = unwrap(
    await supabase
      .from('messages')
      .select('*, message_groups(group_id), message_deliveries(state)')
      .order('sent_at', { ascending: false })
      .limit(limit),
  ) as (MessageRow & {
    message_groups: { group_id: string }[];
    message_deliveries: { state: string }[];
  })[];

  return rows.map((r) =>
    toMessage(
      r,
      r.message_groups.map((g) => g.group_id),
      r.message_deliveries.filter((d) => d.state === 'delivered' || d.state === 'sent').length,
      r.message_deliveries.length,
    ),
  );
}

export async function fetchReplies(limit = HISTORY_LIMIT): Promise<Reply[]> {
  const rows = unwrap(
    await supabase
      .from('replies')
      .select('*, students(accent)')
      .order('received_at', { ascending: false })
      .limit(limit),
  ) as (ReplyRow & { students: { accent: Reply['accent'] } | null })[];

  return rows.map((r) => toReply(r, r.students?.accent ?? 'blue'));
}

export type TeacherProfile = {
  id: string;
  name: string;
  email: string | null;
  avatarUrl: string | null;
  timezone: string;
  /** 'google' | 'apple' | 'email' — how this session was established. */
  provider: string;
  createdAt: string;
  /** Null until the teacher picks one; the device's choice then fills it in. */
  language: string | null;
  /** What a passing result says. Null until the teacher writes their own. */
  gradeTemplate: string | null;
  /** What a failing result says. Null until the teacher writes their own. */
  gradeTemplateFail: string | null;
  templateOverrides: Record<string, { title: string; body: string }>;
  hiddenTemplates: string[];
  /** Terms created before any course is in them. See migration 0022. */
  terms: string[];
};

/**
 * Whether this device holds a session, without asking the network.
 *
 * `getSession` reads what is stored; `getUser` would make a request, and on a
 * filtered connection a request that fails is indistinguishable here from a
 * teacher who is not signed in. Callers use this to decide whether a *pull* is
 * meaningful, and getting that wrong deletes data, so it must not depend on
 * whether the network happens to be up.
 */
export async function hasSession(): Promise<boolean> {
  const { data } = await supabase.auth.getSession();
  return Boolean(data.session);
}

export async function fetchTeacher(): Promise<TeacherProfile | null> {
  // The stored session, not `getUser()`, for the same reason as `requireUser`:
  // that call goes to the network and turns a dropped connection into a
  // teacher with no account.
  const { data: auth } = await supabase.auth.getSession();
  const user = auth.session?.user;
  if (!user) return null;

  // `maybeSingle`, not `single`: a missing row is a state to handle, and
  // `single` reports it as an error. That turned "no profile row" into a
  // rejected promise, which took the whole `Promise.all` in `hydrate()` with
  // it — so the app silently stopped reconciling with the server entirely and
  // ran on local state forever. The fallback below was never reached.
  const row = unwrap(
    await supabase.from('teachers').select('*').eq('id', user.id).maybeSingle(),
  ) as TeacherRow | null;

  if (!row) {
    const profile = {
      id: user.id,
      name: (user.user_metadata?.full_name as string) ?? '',
      email: user.email ?? null,
      avatarUrl: (user.user_metadata?.avatar_url as string) ?? null,
      timezone: 'UTC',
      provider: user.app_metadata?.provider ?? 'email',
      createdAt: user.created_at,
      // A row that does not exist yet has chosen nothing; the device's pick wins.
      language: null,
      gradeTemplate: null,
      gradeTemplateFail: null,
      templateOverrides: {},
      hiddenTemplates: [],
      terms: [],
    };

    // Create it rather than returning a convincing-looking profile that exists
    // nowhere. Every other table's `teacher_id` is a foreign key onto this row,
    // so without it the account can read fine and cannot save anything — which
    // surfaces much later as "New group could not be saved".
    //
    // The signup trigger normally does this; an account created before that
    // trigger existed never got one. RLS permits it: the `own profile` policy
    // checks `id = auth.uid()`, which is exactly this row.
    const { error } = await supabase.from('teachers').insert({
      id: profile.id,
      name: profile.name,
      email: profile.email,
      avatar_url: profile.avatarUrl,
    });
    // 23505 means another device won the race and created it first. Fine.
    if (error && error.code !== '23505') {
      console.warn('[classcare] could not create the profile row:', error.message);
    }

    return profile;
  }

  return {
    id: row.id,
    // The trigger copies the name from the provider at signup, but Apple only
    // sends it once — fall back to whatever auth still holds.
    name: row.name || (user.user_metadata?.full_name as string) || '',
    email: row.email ?? user.email ?? null,
    avatarUrl: row.avatar_url ?? (user.user_metadata?.avatar_url as string) ?? null,
    timezone: row.timezone,
    provider: user.app_metadata?.provider ?? 'email',
    createdAt: row.created_at,
    language: row.language ?? null,
    gradeTemplate: row.grade_template ?? null,
    gradeTemplateFail: row.grade_template_fail ?? null,
    templateOverrides: row.template_overrides ?? {},
    hiddenTemplates: row.hidden_templates ?? [],
    terms: row.terms ?? [],
  };
}

export async function updateTeacher(patch: {
  name?: string;
  timezone?: string;
  pushToken?: string;
  language?: string;
  /** Null clears it, which puts the teacher back on the translated default. */
  gradeTemplate?: string | null;
  gradeTemplateFail?: string | null;
  templateOverrides?: Record<string, { title: string; body: string }>;
  hiddenTemplates?: string[];
  terms?: string[];
}) {
  const teacherId = await requireUser();
  unwrap(
    await supabase
      .from('teachers')
      .update({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.timezone !== undefined && { timezone: patch.timezone }),
        ...(patch.pushToken !== undefined && { push_token: patch.pushToken }),
        ...(patch.language !== undefined && { language: patch.language }),
        ...(patch.gradeTemplate !== undefined && { grade_template: patch.gradeTemplate }),
        ...(patch.templateOverrides !== undefined && {
          template_overrides: patch.templateOverrides,
        }),
        ...(patch.hiddenTemplates !== undefined && {
          hidden_templates: patch.hiddenTemplates,
        }),
        ...(patch.terms !== undefined && { terms: patch.terms }),
        ...(patch.gradeTemplateFail !== undefined && {
          grade_template_fail: patch.gradeTemplateFail,
        }),
      })
      .eq('id', teacherId)
      .select(),
  );
  if (patch.name !== undefined) {
    await supabase.auth.updateUser({ data: { full_name: patch.name } });
  }
}

/**
 * Wipe everything this teacher owns.
 *
 * One delete is enough: every table cascades from `teachers`. The auth user
 * itself survives — removing that needs the admin API, which means a secret
 * key, which means a server. Documented rather than half-done.
 */
export async function deleteAccountData() {
  const teacherId = await requireUser();
  unwrap(await supabase.from('teachers').delete().eq('id', teacherId).select());
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Insert a group under the id the store already minted.
 *
 * The id is supplied rather than left to `gen_random_uuid()` so that the value
 * the UI navigated to is the value in the database. Letting Postgres choose
 * meant the client had to swap ids afterwards, and anything still holding the
 * old one — a route, a screen on the back stack — broke.
 */
export async function createGroup(group: Group): Promise<Group> {
  const teacherId = await requireUser();

  const row = unwrap(
    await supabase
      .from('groups')
      // Upsert rather than insert: a create can be replayed — a queued write
      // retried after a timeout that actually succeeded, or a row arriving from
      // an imported backup the server already has — and a duplicate key error
      // would stall the queue behind it.
      .upsert({
        id: group.id,
        teacher_id: teacherId,
        name: group.name,
        subject: group.subject,
        room: group.room,
        accent: group.accent,
        starts_on: group.startsOn ?? null,
        term: group.term ?? null,
        ends_on: group.endsOn ?? null,
      })
      .select()
      .single(),
  ) as GroupRow;

  if (group.slots.length) {
    // Cleared first, so a replayed create does not double every slot.
    unwrap(await supabase.from('group_slots').delete().eq('group_id', row.id));
    unwrap(
      await supabase
        .from('group_slots')
        .insert(
          distinctSlots(group.slots).map((s) => ({
            group_id: row.id,
            teacher_id: teacherId,
            weekday: s.day,
            starts_at: s.start,
            ends_at: s.end,
          })),
        )
        .select(),
    );
  }

  return { ...group, id: row.id };
}

/**
 * One slot per day and start time, which is what the table allows.
 *
 * `group_slots` is unique on `(group_id, weekday, starts_at)`. A form that
 * produced the same day twice — easily done by adding Monday, changing your
 * mind, and adding it again — used to reach the server as two identical rows
 * and come back as "Already exists" against the whole group, which reads as the
 * *group* being a duplicate and sends the teacher looking for a clash that is
 * not there.
 */
const distinctSlots = <T extends { day: number; start: string }>(slots: T[]): T[] => {
  const seen = new Set<string>();
  return slots.filter((s) => {
    const key = `${s.day}#${s.start}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/* -------------------------------------------------------------------------- */
/* Calendar events                                                            */
/* -------------------------------------------------------------------------- */

const toEvent = (r: CalendarEventRow): CalendarEvent => ({
  id: r.id,
  title: r.title,
  note: r.note ?? undefined,
  date: r.event_date,
  allDay: r.all_day,
  start: r.starts_at ?? undefined,
  end: r.ends_at ?? undefined,
  accent: r.accent,
});

export async function fetchEvents(): Promise<CalendarEvent[]> {
  const rows = await everyRow<CalendarEventRow>((from, to, count) =>
    supabase
      .from('calendar_events')
      .select('*', counted(count))
      .order('event_date')
      .order('id')
      .range(from, to),
  );
  return rows.map(toEvent);
}

/** Insert under the store's id — see `createGroup` for why. */
export async function createEvent(event: CalendarEvent): Promise<CalendarEvent> {
  const teacherId = await requireUser();
  const row = unwrap(
    await supabase
      .from('calendar_events')
      // Upsert rather than insert: a create can be replayed — a queued write
      // retried after a timeout that actually succeeded, or a row arriving from
      // an imported backup the server already has — and a duplicate key error
      // would stall the queue behind it.
      .upsert({
        id: event.id,
        teacher_id: teacherId,
        title: event.title,
        note: event.note ?? null,
        event_date: event.date,
        all_day: event.allDay,
        // The table's `times_present` constraint requires both or neither.
        starts_at: event.allDay ? null : (event.start ?? null),
        ends_at: event.allDay ? null : (event.end ?? null),
        accent: event.accent,
      })
      .select()
      .single(),
  ) as CalendarEventRow;
  return toEvent(row);
}

export async function updateEvent(id: string, patch: Partial<Omit<CalendarEvent, 'id'>>) {
  const teacherId = await requireUser();
  const fields: Partial<CalendarEventRow> = {};
  if (patch.title !== undefined) fields.title = patch.title;
  if (patch.note !== undefined) fields.note = patch.note ?? null;
  if (patch.date !== undefined) fields.event_date = patch.date;
  if (patch.accent !== undefined) fields.accent = patch.accent;
  if (patch.allDay !== undefined) {
    fields.all_day = patch.allDay;
    // Clearing the times alongside the flag keeps `times_present` satisfied
    // even when the caller only flips all-day on.
    if (patch.allDay) {
      fields.starts_at = null;
      fields.ends_at = null;
    }
  }
  if (patch.start !== undefined && !patch.allDay) fields.starts_at = patch.start ?? null;
  if (patch.end !== undefined && !patch.allDay) fields.ends_at = patch.end ?? null;

  if (!Object.keys(fields).length) return;
  unwrap(
    await supabase.from('calendar_events').update(fields).eq('id', id).eq('teacher_id', teacherId),
  );
}

export async function deleteEvent(id: string) {
  const teacherId = await requireUser();
  unwrap(await supabase.from('calendar_events').delete().eq('id', id).eq('teacher_id', teacherId));
}

/**
 * Edit a group in place.
 *
 * Slots are replaced wholesale rather than diffed. A group has at most a
 * handful, and the alternative — matching old rows to new by weekday — silently
 * does the wrong thing the moment a teacher moves a class from Tuesday to
 * Thursday. Delete-then-insert is unambiguous.
 *
 * Attendance is keyed by `groupId@date#start`, so moving a slot's start time
 * orphans that slot's history. That is the honest outcome: those records belong
 * to sessions that, as far as the schedule is now concerned, never happened.
 */
export async function updateGroup(id: string, patch: GroupPatch) {
  const teacherId = await requireUser();

  const fields: Partial<GroupRow> = {};
  if (patch.name !== undefined) fields.name = patch.name;
  if (patch.subject !== undefined) fields.subject = patch.subject;
  if (patch.room !== undefined) fields.room = patch.room;
  if (patch.accent !== undefined) fields.accent = patch.accent;
  /*
    Tested with `in`, not against `undefined`.

    Clearing an end date — "this course no longer has a finish" — is expressed
    as `endsOn: undefined`, which `!== undefined` reads as "not mentioned" and
    skips. The column kept its old date, and the next sync pulled it back down
    over the teacher's edit, so switching a course to Ongoing silently did
    nothing. `in` distinguishes an absent key from a present empty one.
  */
  if ('startsOn' in patch) fields.starts_on = patch.startsOn ?? null;
  if ('endsOn' in patch) fields.ends_on = patch.endsOn ?? null;
  if ('term' in patch) fields.term = patch.term ?? null;
  if ('archivedAt' in patch) fields.archived_at = patch.archivedAt ?? null;

  if (Object.keys(fields).length) {
    // The teacher_id filter is belt-and-braces: RLS already blocks other rows,
    // but this makes the intent explicit and fails loudly rather than silently
    // updating nothing.
    unwrap(await supabase.from('groups').update(fields).eq('id', id).eq('teacher_id', teacherId));
  }

  if (patch.slots) {
    unwrap(await supabase.from('group_slots').delete().eq('group_id', id));
    if (patch.slots.length) {
      unwrap(
        await supabase.from('group_slots').insert(
          distinctSlots(patch.slots).map((s) => ({
            group_id: id,
            teacher_id: teacherId,
            weekday: s.day,
            starts_at: s.start,
            ends_at: s.end,
          })),
        ),
      );
    }
  }
}

/**
 * Delete a group and everything hanging off it.
 *
 * `group_slots`, `student_groups`, `attendance` and `message_groups` all
 * declare `on delete cascade`, so this one statement removes the schedule, the
 * roster links and the attendance history. Students themselves survive — they
 * are people, not group members, and may well be in another class.
 */
export async function deleteGroup(id: string) {
  const teacherId = await requireUser();
  unwrap(await supabase.from('groups').delete().eq('id', id).eq('teacher_id', teacherId));
}

/* -------------------------------------------------------------------------- */
/* Students                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A change to a student as it travels to the server.
 *
 * A key that is present is a statement about that column: a value sets it, and
 * `null` clears it. `undefined` used to mean "clear" in the store and "leave
 * alone" here, so clearing a field on the edit form emptied it on the phone and
 * left it on the server — and the next sync put it back. `null` is used on the
 * wire because a queued change is written to disk with `JSON.stringify`, which
 * drops `undefined` keys entirely. See `studentForWire` in the store.
 */
export type StudentPatch = { [K in keyof Student]?: Student[K] | null };

/** Domain field to column, for every column the app writes as it is. */
const STUDENT_COLUMNS = [
  ['name', 'name'],
  ['phone', 'phone'],
  ['email', 'email'],
  ['birthDate', 'birth_date'],
  ['address', 'address'],
  ['school', 'school'],
  ['gender', 'gender'],
  ['surname', 'surname'],
  ['patronymic', 'patronymic'],
  ['documentId', 'document_id'],
  ['levelBase', 'level_base'],
  ['parentName', 'parent_name'],
  ['parentPhone', 'parent_phone'],
  ['parentEmail', 'parent_email'],
  ['parentWork', 'parent_work'],
  ['parent2Name', 'parent2_name'],
  ['parent2Phone', 'parent2_phone'],
  ['parent2Email', 'parent2_email'],
  ['parent2Work', 'parent2_work'],
  ['accent', 'accent'],
  ['photoPath', 'photo_path'],
  ['note', 'note'],
] as const satisfies readonly (readonly [keyof Student, string])[];

const DOCUMENT_KIND_COLUMN: Record<DocumentKind, string> = {
  passport: 'passport',
  birthCertificate: 'birth_certificate',
  generated: 'generated',
};

const documentKindOf = (value: string | null | undefined): DocumentKind | undefined =>
  value === 'passport'
    ? 'passport'
    : value === 'birth_certificate'
      ? 'birthCertificate'
      : value === 'generated'
        ? 'generated'
        : undefined;

/**
 * Students per request.
 *
 * A hundred rows is around fifty kilobytes of JSON — one request a teacher on a
 * slow connection can still finish — where a student at a time was three round
 * trips each, twelve hundred for an import of four hundred, through a proxy on
 * shared hosting that starts refusing a burst like that long before it ends.
 */
const WRITE_CHUNK = 100;

/**
 * Ids per `in.(…)` filter.
 *
 * That filter travels in the URL, and a UUID with its percent-encoded comma is
 * about forty characters. A hundred keeps the request line near four kilobytes,
 * comfortably under the eight most servers stop reading at.
 */
const ID_CHUNK = 100;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Whether the server has the two columns from migration 0024.
 *
 * Assumed until a write proves otherwise, and then never sent again in this
 * session. A project where the migration has not been run yet would otherwise
 * refuse every student the app saves — new ones, edits, imports — over two
 * columns it can live without until somebody runs it. The number itself is in
 * `document_id`, which has been there since 0014, so nothing is lost but the
 * kind and the uniqueness check.
 */
let documentColumns = true;

/**
 * "This column does not exist", and only that.
 *
 * Matching the column name alone would also catch the unique index — its name
 * contains `document_key` — and a duplicate would then be retried without the
 * key and go through, which is the one thing the index is there to stop.
 */
function missingDocumentColumns(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  const text = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (!/document_(kind|key)/.test(text)) return false;
  return (
    code === 'PGRST204' ||
    code === '42703' ||
    text.includes('schema cache') ||
    text.includes('does not exist')
  );
}

async function withDocumentColumns(write: (withDocs: boolean) => Promise<void>) {
  if (!documentColumns) return write(false);
  try {
    await write(true);
  } catch (e) {
    if (!missingDocumentColumns(e)) throw e;
    documentColumns = false;
    console.warn(
      '[classcare] the server has no document_kind/document_key yet — run migration 0024. ' +
        'Saving without them.',
    );
    await write(false);
  }
}

/** A whole student as a row, for inserting. Every column is written. */
function studentRow(student: Student, teacherId: string, withDocs: boolean) {
  return {
    id: student.id,
    teacher_id: teacherId,
    name: student.name,
    phone: student.phone ?? '',
    email: student.email ?? null,
    birth_date: student.birthDate ?? null,
    address: student.address ?? null,
    school: student.school ?? null,
    gender: student.gender ?? null,
    surname: student.surname ?? null,
    patronymic: student.patronymic ?? null,
    document_id: student.documentId ?? null,
    ...(withDocs && {
      document_kind: student.documentKind ? DOCUMENT_KIND_COLUMN[student.documentKind] : null,
      document_key: documentKey(student.documentId) || null,
    }),
    level_base: student.levelBase ?? 0,
    parent_name: student.parentName ?? null,
    parent_phone: student.parentPhone ?? null,
    parent_email: student.parentEmail ?? null,
    parent_work: student.parentWork ?? null,
    parent2_name: student.parent2Name ?? null,
    parent2_phone: student.parent2Phone ?? null,
    parent2_email: student.parent2Email ?? null,
    parent2_work: student.parent2Work ?? null,
    accent: student.accent,
    photo_path: student.photoPath ?? null,
    note: student.note ?? null,
  };
}

/**
 * The columns a change mentions, and nothing else.
 *
 * Tested with `in`, so a present key with no value clears its column — see
 * `StudentPatch`. The three columns that may not be null are the exception:
 * a name is never cleared, a phone clears to empty and a level to zero.
 */
function patchColumns(patch: StudentPatch, withDocs: boolean): Partial<StudentRow> {
  const out: Record<string, unknown> = {};

  for (const [field, column] of STUDENT_COLUMNS) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (field === 'name' || field === 'accent') {
      if (value) out[column] = value;
    } else if (field === 'phone') {
      out.phone = value ?? '';
    } else if (field === 'levelBase') {
      out.level_base = value ?? 0;
    } else {
      out[column] = value ?? null;
    }
  }

  if (withDocs) {
    if ('documentId' in patch) out.document_key = documentKey(patch.documentId) || null;
    if ('documentKind' in patch) {
      out.document_kind = patch.documentKind ? DOCUMENT_KIND_COLUMN[patch.documentKind] : null;
    }
  }
  // Built loosely because the column is chosen at run time; every key it can
  // hold is a `StudentRow` column from the table above.
  return out as Partial<StudentRow>;
}

/** Insert under the store's id — see `createGroup` for why. */
export async function createStudent(student: Student): Promise<void> {
  await createStudents([student]);
}

/**
 * Insert or overwrite students, a hundred at a time, and set exactly their
 * memberships.
 *
 * Upsert rather than insert: a create can be replayed — a queued write retried
 * after a timeout that actually succeeded, or a row arriving from an imported
 * backup the server already has — and a duplicate key error would stall the
 * queue behind it.
 *
 * No `select()` after the write. Asking for the rows back doubled every
 * response for nothing: the device minted the ids and already holds the rows.
 */
export async function createStudents(students: Student[]): Promise<void> {
  if (!students.length) return;
  const teacherId = await requireUser();

  await withDocumentColumns(async (withDocs) => {
    for (const chunk of chunked(students, WRITE_CHUNK)) {
      unwrap(
        await supabase
          .from('students')
          .upsert(
            chunk.map((s) => studentRow(s, teacherId, withDocs)),
            { onConflict: 'id' },
          ),
      );
    }
  });

  // Cleared first, and de-duplicated, for the same reason `createGroup` clears
  // its slots: a create can be replayed, and inserting the same (student,
  // group) pair twice is a duplicate key error that fails the whole batch.
  for (const ids of chunked(students.map((s) => s.id), ID_CHUNK)) {
    unwrap(await supabase.from('student_groups').delete().in('student_id', ids));
  }

  const links = students.flatMap((s) =>
    [...new Set(s.groupIds)].map((group_id) => ({
      student_id: s.id,
      group_id,
      teacher_id: teacherId,
    })),
  );
  for (const chunk of chunked(links, WRITE_CHUNK * 5)) {
    unwrap(await supabase.from('student_groups').insert(chunk));
  }
}

export async function updateStudent(id: string, patch: StudentPatch) {
  await withDocumentColumns(async (withDocs) => {
    const fields = patchColumns(patch, withDocs);
    // Nothing but memberships is a common change — a roster edit — and an
    // update with an empty body is a request with nothing to say.
    if (!Object.keys(fields).length) return;
    unwrap(await supabase.from('students').update(fields).eq('id', id).select('id'));
  });

  if (patch.groupIds) {
    const teacherId = await requireUser();
    unwrap(await supabase.from('student_groups').delete().eq('student_id', id).select());
    // De-duplicated: the same group listed twice is a duplicate key on the
    // (student, group) pair, and the whole edit fails on it.
    const groupIds = [...new Set(patch.groupIds)];
    if (groupIds.length) {
      unwrap(
        await supabase
          .from('student_groups')
          .insert(
            groupIds.map((group_id) => ({
              student_id: id,
              group_id,
              teacher_id: teacherId,
            })),
          )
          .select(),
      );
    }
  }
}

/**
 * Many students' changes in a handful of requests, and memberships only ever
 * added.
 *
 * What an import sends. Each row's changes are written as an upsert of just
 * those columns: PostgREST updates exactly the columns the payload names, so a
 * file that says nothing about photographs cannot touch one. An upsert writes
 * every column it names on every row, though, so rows are grouped by which
 * columns they carry — a row with no email in the file must not be sent beside
 * one that has, or its email would be written as null.
 *
 * An upsert inserts a row that is missing, and the server may be missing one:
 * a student whose create was refused before this fix exists on the phone and
 * nowhere else. That needs a name and a phone, which every import row carries;
 * a change without them is sent as a plain update instead.
 *
 * Memberships are inserted and duplicates ignored, never cleared and rewritten.
 * An import adds a student to classes and has no business removing them from
 * any, including ones joined on another phone that this one has not heard of.
 */
export async function updateStudents(
  patches: { id: string; patch: StudentPatch }[],
): Promise<void> {
  if (!patches.length) return;
  const teacherId = await requireUser();

  await withDocumentColumns(async (withDocs) => {
    const bySignature = new Map<string, Partial<StudentRow>[]>();
    const loose: { id: string; fields: Partial<StudentRow> }[] = [];

    for (const { id, patch } of patches) {
      const fields = patchColumns(patch, withDocs);
      if (!Object.keys(fields).length) continue;
      if (!('name' in fields) || !('phone' in fields)) {
        loose.push({ id, fields });
        continue;
      }
      const row: Partial<StudentRow> = { id, teacher_id: teacherId, ...fields };
      const signature = Object.keys(row).sort().join(',');
      const list = bySignature.get(signature);
      if (list) list.push(row);
      else bySignature.set(signature, [row]);
    }

    for (const rows of bySignature.values()) {
      for (const chunk of chunked(rows, WRITE_CHUNK)) {
        unwrap(await supabase.from('students').upsert(chunk, { onConflict: 'id' }));
      }
    }
    for (const { id, fields } of loose) {
      unwrap(await supabase.from('students').update(fields).eq('id', id).select('id'));
    }
  });

  const links = patches.flatMap(({ id, patch }) =>
    patch.groupIds
      ? [...new Set(patch.groupIds)].map((group_id) => ({
          student_id: id,
          group_id,
          teacher_id: teacherId,
        }))
      : [],
  );
  for (const chunk of chunked(links, WRITE_CHUNK * 5)) {
    unwrap(
      await supabase
        .from('student_groups')
        .upsert(chunk, { onConflict: 'student_id,group_id', ignoreDuplicates: true }),
    );
  }
}

/** Soft delete — history stays intact so past attendance still adds up. */
export async function archiveStudent(id: string) {
  await archiveStudents([id]);
}

/** Many at once, for a replacing import that removes a roster's worth. */
export async function archiveStudents(ids: string[]): Promise<void> {
  const at = new Date().toISOString();
  for (const chunk of chunked(ids, ID_CHUNK)) {
    unwrap(await supabase.from('students').update({ archived_at: at }).in('id', chunk));
  }
}

/**
 * Upsert a whole session's marks in one round trip. The unique constraint on
 * (group, date, start, student) makes re-saving idempotent, which matters
 * because attendance is often corrected mid-lesson.
 */
export async function saveAttendance(
  groupId: string,
  date: string,
  start: string,
  marks: Record<string, AttendanceStatus>,
) {
  const teacherId = await requireUser();
  const rows = Object.entries(marks).map(([student_id, status]) => ({
    teacher_id: teacherId,
    group_id: groupId,
    student_id,
    session_date: date,
    starts_at: start,
    status,
    marked_at: new Date().toISOString(),
  }));
  if (!rows.length) return;

  unwrap(
    await supabase
      .from('attendance')
      .upsert(rows, {
        onConflict: 'group_id,session_date,starts_at,student_id',
      })
      .select(),
  );
}

/**
 * What the Edge Function actually managed to do.
 *
 * `skipped` counts recipients dropped before dispatch because the contact
 * detail that channel needs is not on file — a student with no email address
 * cannot be emailed. That used to be invisible: the send returned 200 with
 * nothing queued and the teacher was told it went out.
 */
export type SendReport = {
  messageId: string;
  queued: number;
  sent: number;
  failed: number;
  skipped: { sms: number; email: number; push: number };
  /** Distinct gateway errors, deduplicated — one bad key repeats 11 times. */
  errors: string[];
};

/**
 * Hand a message to the server for fan-out over a gateway.
 *
 * This is the path for email, and for SMS when a commercial gateway is
 * configured. SMS sent from the teacher's own SIM does not come through here —
 * the device does the sending and `recordDeviceSms` writes down what happened.
 */
export async function sendMessage(input: {
  groupIds: string[];
  studentIds?: string[];
  audience: Audience;
  channels: Channel[];
  body: string;
  announcement?: boolean;
  /**
   * Storage paths in the `attachments` bucket, never URLs — the function signs
   * them itself after checking they belong to this teacher.
   */
  attachments?: { path: string; filename: string; mimeType: string; size: number }[];
  /** Marks the row as homework rather than an ordinary message. */
  isAssignment?: boolean;
}) {
  const { data, error } = await supabase.functions.invoke('send-message', {
    body: input,
  });
  if (error) throw new Error(await functionErrorMessage(error));
  return data as SendReport;
}

/**
 * Write down an SMS run that the device performed itself.
 *
 * The Edge Function normally creates the message and its deliveries as a side
 * effect of sending. When the teacher's own SIM does the sending there is no
 * server involved, so the log has to be written here — otherwise the Messages
 * tab would show nothing and the teacher would have no record of what the class
 * was told.
 *
 * Rows go in with their real outcome rather than `queued`: by the time this is
 * called every message has already succeeded or failed, and a row that says
 * `queued` forever is worse than no row.
 */
export async function recordDeviceSms(input: {
  groupIds: string[];
  audience: Audience;
  body: string;
  announcement?: boolean;
  deliveries: {
    studentId: string;
    recipient: 'student' | 'parent' | 'parent2';
    destination: string;
    rendered: string;
    /**
     * `queued` is the honest state for a message handed to the radio that never
     * reported back — cancelled mid-flight, or the network went quiet. It may
     * still arrive, and `markSmsDelivery` upgrades it if a report turns up.
     */
    state: 'sent' | 'failed' | 'queued';
    error?: string;
  }[];
}): Promise<string> {
  const teacherId = await requireUser();

  const message = unwrap(
    await supabase
      .from('messages')
      .insert({
        teacher_id: teacherId,
        body: input.body,
        audience: input.audience,
        channels: ['sms'],
        announcement: input.announcement ?? false,
      })
      .select()
      .single(),
  ) as MessageRow;

  if (input.groupIds.length) {
    unwrap(
      await supabase
        .from('message_groups')
        .insert(input.groupIds.map((id) => ({ message_id: message.id, group_id: id })))
        .select(),
    );
  }

  if (input.deliveries.length) {
    unwrap(
      await supabase
        .from('message_deliveries')
        .insert(
          input.deliveries.map((d) => ({
            message_id: message.id,
            teacher_id: teacherId,
            student_id: d.studentId,
            recipient: d.recipient,
            channel: 'sms' as const,
            destination: d.destination,
            rendered: d.rendered,
            state: d.state,
            error: d.error ?? null,
          })),
        )
        .select(),
    );
  }

  return message.id;
}

/**
 * Record what the network said about one SMS, minutes after it went out.
 *
 * The sent-broadcast only proves the tower accepted the message. Whether it
 * reached the handset is a second answer that arrives later, and it is the one
 * that catches a SIM out of credit or a number that no longer exists — both of
 * which look like a clean send at the moment of sending.
 *
 * Best-effort by design: the row already says `sent`, the teacher has moved on,
 * and a failed update here should not surface as an error over their work.
 */
export async function markSmsDelivery(input: {
  messageId: string;
  studentId: string;
  recipient: 'student' | 'parent' | 'parent2';
  delivered: boolean;
  reason?: string;
}): Promise<void> {
  const { error } = await supabase
    .from('message_deliveries')
    .update({
      state: input.delivered ? 'delivered' : 'failed',
      error: input.delivered ? null : (input.reason ?? 'not_delivered'),
    })
    .eq('message_id', input.messageId)
    .eq('student_id', input.studentId)
    .eq('recipient', input.recipient)
    .eq('channel', 'sms');

  if (error) console.warn('[classcare] could not record a delivery report:', error.message);
}

/**
 * Dig the real reason out of a failed Edge Function call.
 *
 * `FunctionsHttpError.message` is always the same sentence — "Edge Function
 * returned a non-2xx status code" — and the thing the teacher needs ("no email
 * address on file for these students") is in the response body, which
 * supabase-js hands over untouched as `context`.
 */
async function functionErrorMessage(error: unknown) {
  const response = (error as { context?: Response }).context;
  if (response && typeof response.json === 'function') {
    try {
      const body = await response.json();
      // A `code` means the server anticipated this and the app has words for
      // it; the English `error` is the fallback for anything it has not met.
      if (body?.code === 'sms_not_configured') return translateNow('sms.notConfigured');
      if (body?.error) return String(body.error);
    } catch {
      // Body was not JSON, or already consumed — fall back to the generic text.
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export type StoredAttachment = {
  id: string;
  storagePath: string;
  filename: string;
  mimeType: string;
  size: number;
};

/**
 * Files a student sent back with their reply.
 *
 * Fetched per reply rather than joined onto the inbox: most replies carry
 * nothing, and pulling every attachment row on every refresh to display a
 * paperclip on two of them is the wrong trade on a slow connection.
 */
export async function fetchReplyAttachments(replyId: string): Promise<StoredAttachment[]> {
  const rows = unwrap(
    await supabase
      .from('reply_attachments')
      .select('*')
      .eq('reply_id', replyId)
      .order('created_at'),
  ) as {
    id: string;
    storage_path: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    storagePath: r.storage_path,
    filename: r.filename,
    mimeType: r.mime_type,
    size: r.size_bytes,
  }));
}

/**
 * Files that went out attached to a message the teacher sent.
 *
 * The sent-message screen is the only lasting record of what a class was
 * actually given — the email is in the recipient's inbox, not the teacher's —
 * so this is what makes "which worksheet did I send them last Tuesday" a
 * question the app can answer.
 *
 * Fetched per message for the same reason as the reply version: most messages
 * carry nothing.
 */
export async function fetchMessageAttachments(messageId: string): Promise<StoredAttachment[]> {
  const rows = unwrap(
    await supabase
      .from('message_attachments')
      .select('*')
      .eq('message_id', messageId)
      .order('created_at'),
  ) as {
    id: string;
    storage_path: string;
    filename: string;
    mime_type: string;
    size_bytes: number;
  }[];

  return rows.map((r) => ({
    id: r.id,
    storagePath: r.storage_path,
    filename: r.filename,
    mimeType: r.mime_type,
    size: r.size_bytes,
  }));
}

/**
 * Put a reply on the server that this device already holds.
 *
 * Replies normally arrive the other way round — the inbound-email function
 * writes them and the app fetches them — so there was no path for one that came
 * in from a backup file. Without this an imported inbox is local-only, and the
 * first `hydrate` replaces it with the server's copy, which has never heard of
 * any of it. That is the "inbox is empty after refreshing" the teacher sees.
 *
 * `inbound_message_id` is left null on purpose. It is the natural key of the
 * *email* that produced the reply, unique across the table, and claiming the
 * original's would collide with the row the webhook already wrote in whichever
 * account exported the file.
 */
export async function createReply(reply: Reply) {
  const teacherId = await requireUser();

  unwrap(
    await supabase
      .from('replies')
      .upsert({
        id: reply.id,
        teacher_id: teacherId,
        student_id: reply.studentId ?? null,
        author_name: reply.authorName,
        context: reply.context,
        body: reply.body,
        received_at: new Date(reply.at).toISOString(),
        read_at: reply.unread ? null : new Date(reply.at).toISOString(),
      })
      .select(),
  );
}

export async function markRepliesRead() {
  unwrap(
    await supabase
      .from('replies')
      .update({ read_at: new Date().toISOString() })
      .is('read_at', null)
      .select(),
  );
}

/** Mark exactly one reply read — opening it is the receipt, not opening the tab. */
export async function markReplyRead(id: string) {
  unwrap(
    await supabase
      .from('replies')
      .update({ read_at: new Date().toISOString() })
      .eq('id', id)
      .is('read_at', null)
      .select(),
  );
}

export async function deleteReply(id: string) {
  const teacherId = await requireUser();
  unwrap(await supabase.from('replies').delete().eq('id', id).eq('teacher_id', teacherId));
}

/**
 * Record a send the phone made on its own.
 *
 * Only device SMS reaches this. Everything that goes through an Edge Function
 * is written down by that function as it sends, which is both closer to the
 * truth and impossible to do from here — the app cannot know a gateway's
 * verdict. But a text sent from the teacher's own SIM has no server in the
 * loop, so without this the message log simply had a hole in it where every
 * texted exam result should have been.
 *
 * Written with the id the device generated, and the delivery rows cleared
 * first, so a retry after a dropped connection replaces its own row instead of
 * filing the same send twice.
 */
export async function logSentMessage(entry: SentMessageLog) {
  const teacherId = await requireUser();

  unwrap(
    await supabase
      .from('messages')
      .upsert({
        id: entry.id,
        teacher_id: teacherId,
        body: entry.body,
        audience: entry.audience,
        channels: entry.channels,
        announcement: entry.groupIds.length === 0,
        sent_at: new Date(entry.sentAt).toISOString(),
      })
      .select(),
  );

  if (entry.groupIds.length) {
    unwrap(
      await supabase
        .from('message_groups')
        .upsert(entry.groupIds.map((group_id) => ({ message_id: entry.id, group_id }))),
    );
  }

  unwrap(await supabase.from('message_deliveries').delete().eq('message_id', entry.id));

  if (entry.deliveries.length) {
    unwrap(
      await supabase.from('message_deliveries').insert(
        entry.deliveries.map((d) => ({
          message_id: entry.id,
          teacher_id: teacherId,
          student_id: d.studentId,
          recipient: d.recipient,
          channel: d.channel,
          destination: d.destination,
          rendered: d.rendered,
          state: d.state,
          error: d.error ?? null,
        })),
      ),
    );
  }
}

/**
 * Put a message from a backup back in the history, without touching receipts.
 *
 * Deliberately not `logSentMessage`. That one owns the delivery rows and clears
 * them before writing its own, which is right for a send the phone just made
 * and catastrophic for a restore: a message the server already holds would have
 * its real per-recipient receipts deleted and replaced with nothing, because a
 * backup does not carry them — the device only ever stored the two counts.
 *
 * So this writes the message and the groups it went to, and leaves
 * `message_deliveries` exactly as it found it. A message the server already had
 * keeps its receipts; one that is genuinely new arrives with none, and shows a
 * recipient count of zero. That is the truthful answer — the file never knew
 * who it went to — and it beats inventing rows to make a number look right.
 */
export async function restoreMessage(message: Message) {
  const teacherId = await requireUser();

  unwrap(
    await supabase
      .from('messages')
      .upsert({
        id: message.id,
        teacher_id: teacherId,
        body: message.body,
        audience: message.audience,
        channels: message.channels,
        announcement: message.announcement ?? message.groupIds.length === 0,
        sent_at: new Date(message.sentAt).toISOString(),
      })
      .select(),
  );

  if (message.groupIds.length) {
    unwrap(
      await supabase
        .from('message_groups')
        .upsert(message.groupIds.map((group_id) => ({ message_id: message.id, group_id }))),
    );
  }
}

/**
 * Remove a sent message from the history.
 *
 * `message_groups` and `message_deliveries` both cascade from `messages`, so
 * this takes the delivery receipts with it. Nothing is unsent — the SMS and the
 * email have already left — this only clears the teacher's own record of it.
 */
export async function deleteMessage(id: string) {
  const teacherId = await requireUser();
  unwrap(await supabase.from('messages').delete().eq('id', id).eq('teacher_id', teacherId));
}

/**
 * Delete many at once.
 *
 * One statement rather than a loop of single deletes: clearing a term's worth
 * of history over a Turkmen mobile connection would otherwise be forty round
 * trips, any of which can fail and leave the list half-cleared.
 */
export async function deleteMessages(ids: string[]) {
  if (!ids.length) return;
  const teacherId = await requireUser();
  unwrap(await supabase.from('messages').delete().in('id', ids).eq('teacher_id', teacherId));
}

export async function deleteReplies(ids: string[]) {
  if (!ids.length) return;
  const teacherId = await requireUser();
  unwrap(await supabase.from('replies').delete().in('id', ids).eq('teacher_id', teacherId));
}

/* -------------------------------------------------------------------------- */
/* Message templates                                                          */
/* -------------------------------------------------------------------------- */

const toTemplate = (row: MessageTemplateRow): MessageTemplate => ({
  id: row.id,
  title: row.title,
  body: row.body,
});

export async function fetchTemplates(): Promise<MessageTemplate[]> {
  const rows = await everyRow<MessageTemplateRow>((from, to, count) =>
    supabase
      .from('message_templates')
      .select('*', counted(count))
      .order('created_at')
      .order('id')
      .range(from, to),
  );
  return rows.map(toTemplate);
}

/** Insert under the store's id — see `createGroup` for why. */
export async function createTemplate(template: MessageTemplate) {
  const teacherId = await requireUser();
  unwrap(
    await supabase
      .from('message_templates')
      // Upsert rather than insert: a create can be replayed — a queued write
      // retried after a timeout that actually succeeded, or a row arriving from
      // an imported backup the server already has — and a duplicate key error
      // would stall the queue behind it.
      .upsert({
        id: template.id,
        teacher_id: teacherId,
        title: template.title,
        body: template.body,
      })
      .select(),
  );
}

export async function updateTemplate(id: string, patch: Partial<MessageTemplate>) {
  unwrap(
    await supabase
      .from('message_templates')
      .update({
        ...(patch.title !== undefined && { title: patch.title }),
        ...(patch.body !== undefined && { body: patch.body }),
      })
      .eq('id', id)
      .select(),
  );
}

export async function deleteTemplate(id: string) {
  const teacherId = await requireUser();
  unwrap(
    await supabase.from('message_templates').delete().eq('id', id).eq('teacher_id', teacherId),
  );
}

/* -------------------------------------------------------------------------- */
/* Grading                                                                    */
/* -------------------------------------------------------------------------- */

const toAssessment = (row: AssessmentRow): Assessment => ({
  id: row.id,
  groupId: row.group_id,
  kind: row.kind,
  kindLabel: row.kind_label ?? undefined,
  title: row.title,
  passMark: row.pass_mark == null ? undefined : Number(row.pass_mark),
  maxScore: Number(row.max_score),
  takenOn: row.taken_on,
});

const toGrade = (row: GradeRow): Grade => ({
  id: row.id,
  assessmentId: row.assessment_id,
  studentId: row.student_id,
  // `numeric` arrives as a string over PostgREST; a string here would sort and
  // average as text, which is the kind of bug that shows up as 9 > 80.
  score: Number(row.score),
  notifiedAt: row.notified_at ? new Date(row.notified_at).getTime() : undefined,
});

export async function fetchAssessments(): Promise<Assessment[]> {
  const rows = await everyRow<AssessmentRow>((from, to, count) =>
    supabase
      .from('assessments')
      .select('*', counted(count))
      .order('taken_on', { ascending: false })
      .order('id')
      .range(from, to),
  );
  return rows.map(toAssessment);
}

/** Paged for the same reason as attendance: a mark per student per test. */
export async function fetchGrades(): Promise<Grade[]> {
  const rows = await everyRow<GradeRow>((from, to, count) =>
    supabase.from('grades').select('*', counted(count)).order('id').range(from, to),
  );
  return rows.map(toGrade);
}

/**
 * Save an assessment and its marks in one go.
 *
 * Upserted on `(assessment_id, student_id)`, which is what turns re-entering a
 * mark into a correction rather than a second row. Teachers fix typos.
 */
export async function saveAssessment(
  assessment: Assessment,
  scores: { studentId: string; score: number }[],
): Promise<void> {
  const teacherId = await requireUser();

  unwrap(
    await supabase
      .from('assessments')
      .upsert({
        id: assessment.id,
        teacher_id: teacherId,
        group_id: assessment.groupId,
        kind: assessment.kind,
        kind_label: assessment.kindLabel ?? null,
        title: assessment.title,
        pass_mark: assessment.passMark ?? null,
        max_score: assessment.maxScore,
        taken_on: assessment.takenOn,
      })
      .select(),
  );

  if (!scores.length) return;

  unwrap(
    await supabase
      .from('grades')
      .upsert(
        scores.map((s) => ({
          teacher_id: teacherId,
          assessment_id: assessment.id,
          student_id: s.studentId,
          score: s.score,
        })),
        { onConflict: 'assessment_id,student_id' },
      )
      .select(),
  );
}

/* ----------------------------- Assessment types ------------------------- */

const toAssessmentType = (row: AssessmentTypeRow): AssessmentType => ({
  id: row.id,
  groupId: row.group_id,
  name: row.name,
  position: row.position,
});

export async function fetchAssessmentTypes(): Promise<AssessmentType[]> {
  const rows = await everyRow<AssessmentTypeRow>((from, to, count) =>
    supabase
      .from('assessment_types')
      .select('*', counted(count))
      .order('position')
      .order('id')
      .range(from, to),
  );
  return rows.map(toAssessmentType);
}

export async function createAssessmentType(type: AssessmentType) {
  const teacherId = await requireUser();
  unwrap(
    await supabase
      .from('assessment_types')
      // Upsert rather than insert: a create can be replayed — a queued write
      // retried after a timeout that actually succeeded, or a row arriving from
      // an imported backup the server already has — and a duplicate key error
      // would stall the queue behind it.
      .upsert({
        id: type.id,
        teacher_id: teacherId,
        group_id: type.groupId,
        name: type.name,
        position: type.position,
      })
      .select(),
  );
}

export async function deleteAssessmentType(id: string) {
  const teacherId = await requireUser();
  unwrap(await supabase.from('assessment_types').delete().eq('id', id).eq('teacher_id', teacherId));
}

export async function deleteAssessment(id: string) {
  const teacherId = await requireUser();
  unwrap(await supabase.from('assessments').delete().eq('id', id).eq('teacher_id', teacherId));
}

export type GradeReport = {
  assessmentId: string;
  notified: number;
  failed: number;
  skipped: number;
  errors: string[];
};

/** Tell each graded student (or their guardian) what they scored. */
export async function sendGrades(input: {
  assessmentId: string;
  audience: Audience;
  /**
   * The teacher's own wording, rendered per recipient by the function.
   *
   * Passed up rather than read from `teachers.grade_template` on the server so
   * that the default, when they have not written one, is the app's translated
   * text in the language they are actually using. The server has no business
   * guessing that.
   */
  template: string;
  /**
   * The wording for a mark below `passMark`.
   *
   * Sent alongside the pass wording rather than instead of it, because one
   * send covers a whole class and the two halves of it need different words.
   */
  failTemplate: string;
  /** Null means no threshold was set, and every result is reported as a pass. */
  passMark: number | null;
  /**
   * The sentences that are not the teacher's: why this address is receiving
   * the message, and how to stop. Translated here and filled in by the
   * function, which holds no catalogue of its own.
   */
  labels: { whyStudent: string; whyParent: string; stop: string; reply: string };
}): Promise<GradeReport> {
  const { data, error } = await supabase.functions.invoke('send-grades', { body: input });
  if (error) throw new Error(await functionErrorMessage(error));
  return data as GradeReport;
}

/**
 * Stamp results the phone itself texted out.
 *
 * `send-grades` marks what it emailed. Nothing marks what went by SMS from the
 * teacher's own SIM, and without this the grading screen keeps calling those
 * marks unreported, which invites the teacher to send them a second time.
 */
export async function markGradesNotified(assessmentId: string, studentIds: string[]) {
  if (!studentIds.length) return;
  const teacherId = await requireUser();
  unwrap(
    await supabase
      .from('grades')
      .update({ notified_at: new Date().toISOString() })
      .eq('assessment_id', assessmentId)
      .eq('teacher_id', teacherId)
      .in('student_id', studentIds)
      .select(),
  );
}

/* -------------------------------------------------------------------------- */
/* Realtime                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Replies and delivery receipts arrive from webhooks, not from anything the
 * teacher did — so the only way the badge is ever right is to subscribe.
 */
/**
 * Watch for inbound replies and delivery-state changes.
 *
 * Uses Realtime where it is available, and falls back to polling where it is
 * not. That fallback exists because the app reaches Supabase through a PHP
 * reverse proxy on shared hosting (see `docs/reverse-proxy.md`) — PHP cannot
 * hold a WebSocket open, so `/realtime/v1` is not carried.
 *
 * Polling costs one small query per interval, and only while the app is in the
 * foreground: a background timer would drain battery to learn about a reply the
 * teacher cannot see anyway.
 */
export function subscribeToInbox(onChange: () => void) {
  if (realtimeAvailable()) {
    const channel = supabase
      .channel('inbox')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'replies' }, onChange)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'message_deliveries' },
        onChange,
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  // Only refire `onChange` when something actually changed, so a poll that
  // finds nothing new does not re-render the inbox every 30 seconds.
  let lastSeen: string | null = null;

  const check = async () => {
    try {
      const { data } = await supabase
        .from('replies')
        .select('id, received_at')
        .order('received_at', { ascending: false })
        .limit(1);
      const newest = data?.[0]?.received_at ?? null;
      if (newest !== lastSeen) {
        // Skip the very first read: it establishes the baseline rather than
        // signalling an arrival.
        if (lastSeen !== null) onChange();
        lastSeen = newest;
      }
    } catch {
      // Offline or proxy hiccup. The next tick tries again.
    }
  };

  const start = () => {
    if (timer) return;
    void check();
    timer = setInterval(check, POLL_MS);
  };
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const sub = AppState.addEventListener('change', (s) => (s === 'active' ? start() : stop()));
  if (AppState.currentState === 'active') start();

  return () => {
    stop();
    sub.remove();
  };
}

/** How often to check for replies when Realtime is unavailable. */
const POLL_MS = 30_000;

/**
 * Realtime needs a WebSocket. The PHP proxy cannot carry one, so it is disabled
 * whenever the configured URL is not a `*.supabase.co` host.
 */
function realtimeAvailable() {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
  return /\.supabase\.(co|in)$/.test(new URL(url).hostname);
}
