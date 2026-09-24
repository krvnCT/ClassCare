import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { showAlert, showDialog, showError } from '@/components/Dialog';
import { Icon, type IconName } from '@/components/Icon';
import { FooterSummary, Screen, StickyFooter, TopBar } from '@/components/layout';
import {
  Avatar,
  Button,
  Card,
  Divider,
  Overline,
  Press,
  SelectChip,
  Segmented,
  Txt,
} from '@/components/ui';
import { SmsRunSheet } from '@/components/SmsRunSheet';
import {
  fetchMessages,
  markSmsDelivery,
  recordDeviceSms,
  sendMessage as apiSendMessage,
} from '@/data/api';
import { useAllGroups, useStore, useStudents, useTemplates } from '@/data/store';
import type { Audience, Channel, Group } from '@/data/types';
import type { TranslationKey } from '@/i18n';
import { useT } from '@/i18n/useT';
import {
  buildRecipients,
  countSegments,
  deviceSmsSupported,
  hasSmsPermission,
  newSmsBatchId,
  requestSmsPermission,
  sendSmsBatch,
  subscribeSmsDelivery,
  SYSTEM_CONFIRM_THRESHOLD,
  type ParentTarget,
  type SmsOutcome,
} from '@/lib/deviceSms';
import { PLACEHOLDERS } from '@/lib/messageVars';
import { planRecipients } from '@/lib/recipients';
import { compareTerms, termLabel, termOfGroup } from '@/lib/term';
import { describeError } from '@/lib/errors';
import { useKeyboardInset } from '@/lib/useKeyboardInset';
import { builtInTemplates } from '@/lib/templates';
import { hasSupabase } from '@/lib/supabase';
import { isReachable } from '@/data/sync';
import { radius, space, useTheme, useThemedStyles, type Theme } from '@/theme';
import { body, text } from '@/theme/type';

/**
 * No push channel. ClassCare is the teacher's app — students and parents never
 * install it, so there is no device to push to and the server's `sendPush` is a
 * documented no-op. Offering the button only ever produced deliveries that
 * reported "sent" while reaching nobody. `Channel` keeps `'push'` because the
 * database enum and older message rows still carry it.
 */
/**
 * Push one delivery report into the log row the run was written to.
 *
 * The recipient key is `${studentId}:${'student' | 'parent'}`, which is exactly
 * what identifies a delivery row — the same student can be two rows when the
 * message went to both them and their guardian.
 */
const writeDelivery = (
  messageId: string,
  report: { key: string; delivered: boolean; reason?: string },
) => {
  const [studentId, recipient] = report.key.split(':');
  return markSmsDelivery({
    messageId,
    studentId,
    // Three now: the student, the mother, the father. Anything else is a key
    // this build did not write, and the student is the safe reading.
    recipient:
      recipient === 'parent' ? 'parent' : recipient === 'parent2' ? 'parent2' : 'student',
    delivered: report.delivered,
    reason: report.reason,
  });
};

const CHANNELS: { key: Channel; labelKey: TranslationKey; icon: IconName }[] = [
  { key: 'sms', labelKey: 'messages.channelSms', icon: 'chat' },
  { key: 'email', labelKey: 'messages.channelEmail', icon: 'envelope' },
];

const AUDIENCES: { key: Audience; labelKey: TranslationKey }[] = [
  { key: 'students', labelKey: 'messages.audienceStudents' },
  { key: 'parents', labelKey: 'messages.audienceParents' },
  { key: 'both', labelKey: 'messages.audienceBoth' },
];

const PARENTS: { key: ParentTarget; labelKey: TranslationKey }[] = [
  { key: 'mother', labelKey: 'messages.mother' },
  { key: 'father', labelKey: 'messages.father' },
  { key: 'both', labelKey: 'messages.bothParents' },
];



export default function Compose() {
  const t = useT();
  const scroller = useRef<ScrollView>(null);
  const { accents, color, scheme } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const params = useLocalSearchParams<{
    group?: string;
    /**
     * Terms to open with every course ticked, comma separated.
     *
     * How the archive sends a teacher here: "message everybody who was in the
     * autumn lot" is one term, and it is a question about people rather than
     * about the eight separate courses they happened to be split across.
     */
    terms?: string;
    audience?: Audience;
    students?: string;
    template?: string;
    /** `1` to arrive with the template sheet already open. */
    pick?: string;
    /** `1` to open with finished terms already showing. */
    archived?: string;
  }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const allGroups = useAllGroups();
  const students = useStudents();
  const savedTemplates = useTemplates();
  const templateOverrides = useStore((s) => s.templateOverrides);
  const hiddenTemplates = useStore((s) => s.hiddenTemplates);
  const starterTemplates = builtInTemplates(t, {
    overrides: templateOverrides,
    hidden: hiddenTemplates,
  });
  const sendMessage = useStore((s) => s.sendMessage);
  const logSentMessage = useStore((s) => s.logSentMessage);

  /** When arriving from attendance, the message targets specific students. */
  const focusIds = useMemo(
    () => (params.students ? params.students.split(',').filter(Boolean) : []),
    [params.students],
  );
  const focused = useMemo(
    () => students.filter((s) => focusIds.includes(s.id)),
    [focusIds, students],
  );

  /** The terms the caller asked to open with, if any. */
  const askedTerms = useMemo(
    () => (params.terms ? params.terms.split(',').filter(Boolean) : []),
    [params.terms],
  );

  /*
    Finished terms are off by default and one tap away.

    The picker is the list of who a teacher is teaching, and a year of archived
    courses at the bottom of it would bury this week's. But messaging a finished
    class is a real thing — results are ready, the next intake is open, a
    certificate is waiting — which is why it is a toggle rather than a rule.

    On by default when the caller named a term that has been filed away: the
    archive links straight here, and opening on a picker with nothing in it
    would read as the link being broken.
  */
  const [showArchived, setShowArchived] = useState(
    () =>
      params.archived === '1' ||
      useStore
        .getState()
        .groups.some((g) => g.archivedAt && askedTerms.includes(termOfGroup(g))),
  );

  /** The courses on offer. Selecting is only ever over these — see `selectedGroups`. */
  const offered = useMemo(
    () => (showArchived ? allGroups : allGroups.filter((g) => !g.archivedAt)),
    [allGroups, showArchived],
  );

  /**
   * The picker, in terms.
   *
   * A tutor with thirty courses does not think of them as thirty. They think
   * "the autumn lot", which is what a term is — so the term is the row, and
   * tapping it takes the whole intake at once. That is the difference between
   * messaging a term and ticking eight chips and missing the ninth.
   */
  const byTerm = useMemo(() => {
    const buckets = new Map<string, Group[]>();
    for (const g of offered) {
      const key = termOfGroup(g);
      const list = buckets.get(key);
      if (list) list.push(g);
      else buckets.set(key, [g]);
    }
    return [...buckets.entries()]
      .sort((a, b) => compareTerms(b[0], a[0]))
      .map(([term, list]) => ({
        term,
        groups: [...list].sort((a, b) => a.name.localeCompare(b.name)),
        /** Every course in it is filed away, so the heading can say so. */
        archived: list.every((g) => !!g.archivedAt),
      }));
  }, [offered]);

  /**
   * `null` until the teacher touches a chip, so the default can follow the data
   * instead of being frozen at mount.
   *
   * Seeding this from the first course in a `useState` initialiser looked equivalent
   * and was not: the initialiser runs once, and opening the composer before the
   * store has hydrated from Supabase left it holding a key that matches no
   * group. The chips then rendered with nothing selected and the footer read
   * "No group selected" with no way to explain itself.
   */
  const [picked, setPicked] = useState<Record<string, boolean> | null>(null);

  const fallbackSelection = useMemo(() => {
    if (askedTerms.length) {
      const out: Record<string, boolean> = {};
      for (const g of offered) if (askedTerms.includes(termOfGroup(g))) out[g.id] = true;
      return out;
    }
    if (params.group) return { [params.group]: true };
    // Never an archived course by accident: arriving with nothing asked for,
    // the composer opens on something the teacher is actually teaching.
    const first = offered.find((g) => !g.archivedAt);
    return first ? { [first.id]: true } : {};
  }, [askedTerms, params.group, offered]);

  const selection = picked ?? fallbackSelection;
  const toggleGroup = (id: string) => setPicked({ ...selection, [id]: !selection[id] });

  /**
   * Take or drop a whole term.
   *
   * Takes it unless it is already whole, which is the behaviour of every
   * select-all anybody has used: a term with six of its eight courses ticked
   * completes rather than empties.
   */
  const toggleTerm = (list: Group[]) => {
    const whole = list.every((g) => selection[g.id]);
    const next = { ...selection };
    for (const g of list) next[g.id] = !whole;
    setPicked(next);
  };
  const [audience, setAudience] = useState<Audience>(params.audience ?? 'students');
  /*
    Which guardian, when the audience includes them.

    Both by default: a teacher who has entered two numbers for a family entered
    them because both are worth having, and quietly picking one of them is a
    decision the app has no basis for. The fallback in `buildRecipients` makes
    the other two choices safe — asking for the mother on a child whose only
    number is the father's sends to the father rather than dropping it.
  */
  const [parents, setParents] = useState<ParentTarget>('both');
  const [channels, setChannels] = useState<Record<Channel, boolean>>({
    // SMS unless the phone cannot send it, in which case email is the only way
    // out and starting with nothing chosen would just be a step to nowhere.
    sms: deviceSmsSupported(),
    email: !deviceSmsSupported(),
    push: false,
  });
  // The starters are translations, so the opening draft has to be resolved
  // through the translator rather than read off a constant.
  const [draft, setDraft] = useState(() => {
    // The teacher's edits to the starters count here too: the register links
    // straight to the absence wording, and it should open with whatever they
    // rewrote it to say. A starter they removed leaves the draft empty rather
    // than silently substituting a different message.
    const { templateOverrides, hiddenTemplates } = useStore.getState();
    const starters = builtInTemplates(t, {
      overrides: templateOverrides,
      hidden: hiddenTemplates,
    });
    return (starters.find((x) => x.id === params.template) ?? starters[0])?.body ?? '';
  });
  /*
    Open on arrival when the caller asked for it.

    A birthday on the calendar sends the teacher here to pick their wording,
    and landing on a composer holding the lesson reminder — with the templates
    a tap away behind a row they have not noticed — is landing on the wrong
    message. The sheet is the first thing they see instead.
  */
  const [templatesOpen, setTemplatesOpen] = useState(params.pick === '1');

  /** Room to scroll while the keyboard is up — see `useKeyboardInset`. */
  const keyboard = useKeyboardInset(
    useCallback(() => scroller.current?.scrollToEnd({ animated: true }), []),
  );
  const [sending, setSending] = useState(false);

  /**
   * Sending SMS from the teacher's own SIM.
   *
   * Only offered where it can actually work — Android, with a radio, on a build
   * that contains the native module. Everywhere else the choice is not shown at
   * all rather than shown and disabled, because "why is this greyed out" is a
   * question with no answer the teacher can act on.
   *
   * Defaulted on where available: these teachers have a SIM with a bundle and
   * no commercial gateway account, so the phone is the route that works.
   */
  const deviceSms = deviceSmsSupported();

  /*
    SMS goes from the teacher's own number, or it is not offered.

    There used to be a second route — hand the list to the server and let a
    commercial gateway send it — and a control for picking between them. It is
    gone. Nobody here has a gateway account, the messages that matter go to
    parents on the same network as the teacher, and a text from a shortcode the
    parent does not recognise is a text the parent ignores. A choice where one
    option never works is not a choice; it is a way to get it wrong.

    So on a phone that cannot text, SMS disappears from the channel row rather
    than sitting there quietly routing somewhere else. Email still works, and
    still says so.
  */
  const channelsHere = (deviceSms ? CHANNELS : CHANNELS.filter((c) => c.key !== 'sms')).filter(
    // Email leaves through the server, so it is not on offer without an
    // account. Shown-and-broken is worse than absent.
    (c) => c.key !== 'email' || !localOnly,
  );

  /** Live state of a device send, or null when none is in flight or finished. */
  const [run, setRun] = useState<{
    total: number;
    results: SmsOutcome[];
    running: boolean;
  } | null>(null);
  const cancelled = useRef(false);

  /**
   * The run delivery reports belong to, and the message row they should be
   * written to. Refs rather than state: reports arrive from a native listener
   * that must not be torn down and re-subscribed every time a row updates.
   */
  const batchId = useRef<string | null>(null);
  const loggedMessageId = useRef<string | null>(null);
  const heldReports = useRef<{ key: string; delivered: boolean; reason?: string }[]>([]);

  /**
   * Delivery reports arrive after the sending is over — seconds later on a good
   * network, a minute or more otherwise. They are the only signal that
   * distinguishes "the tower took it" from "the parent's phone got it", which
   * is what a SIM out of credit or a dead number looks like.
   *
   * Subscribed for as long as the composer is open, so the sheet the teacher is
   * still reading updates underneath them.
   */
  useEffect(
    () =>
      subscribeSmsDelivery(({ batch, key, delivered, reason }) => {
        if (batch !== batchId.current) return;

        setRun((r) =>
          r
            ? {
                ...r,
                results: r.results.map((row) =>
                  row.key === key
                    ? {
                        ...row,
                        // A report proves the message left, whatever we had
                        // concluded when nothing answered in time.
                        state: row.state === 'unknown' ? 'sent' : row.state,
                        delivery: delivered ? 'delivered' : 'undelivered',
                        deliveryReason: delivered ? undefined : reason,
                      }
                    : row,
                ),
              }
            : r,
        );

        // The log row is written once the whole batch is done, so early
        // reports — and on a good network the first one lands within seconds —
        // have nowhere to go yet. Held rather than dropped.
        if (!loggedMessageId.current) {
          heldReports.current.push({ key, delivered, reason });
          return;
        }
        void writeDelivery(loggedMessageId.current, { key, delivered, reason });
      }),
    [],
  );

  /**
   * Whether a server is involved at all.
   *
   * Two separate questions, and they used to be one. `hasSupabase` says the
   * build has a project; `offline` says this teacher has no account behind it.
   * Email needs both, because it goes out through an Edge Function. Texting
   * needs neither: it leaves from the teacher's own SIM, which is precisely why
   * a teacher with no account and no internet can still tell a parent their
   * child was absent this morning.
   */
  const localOnly = useStore((s) => s.offline);
  const liveSend = hasSupabase && !localOnly;

  /**
   * Gated on having real students, not on having an account.
   *
   * Without a project the store holds seed students whose numbers are invented,
   * and texting them would cost the teacher money and land real messages on
   * whatever real numbers those happen to be. An offline teacher's students are
   * ones they typed in themselves, so there is nothing to protect them from.
   */
  const viaPhone = deviceSms && channels.sms && hasSupabase;

  // Over what is on screen, so hiding the finished terms also drops them from
  // the send. A tick the teacher cannot see is a tick they cannot untick.
  const selectedGroups = useMemo(
    () => offered.filter((g) => selection[g.id]),
    [offered, selection],
  );
  // From what this phone actually offers, so the server can never be handed an
  // SMS to send on the teacher's behalf.
  const activeChannels = channelsHere.filter((c) => channels[c.key]);

  /**
   * Everybody the message is about — each of them once.
   *
   * A student in two of the selected groups, or in two terms of them, is one
   * student. `filter` over the roster rather than a concatenation of the
   * groups' rosters is what makes that true by construction.
   */
  const targeted = useMemo(
    () =>
      focusIds.length
        ? focused
        : students.filter((s) => selectedGroups.some((g) => s.groupIds.includes(g.id))),
    [focusIds.length, focused, students, selectedGroups],
  );

  /**
   * How many messages this actually is.
   *
   * Counted from the recipient list rather than `students × 2`, so it drops the
   * students with no number and counts a mother reached on one phone for two of
   * her children once. The footer used to promise a class of forty and the run
   * sheet then showed thirty-one.
   */
  const plan = useMemo(
    () => planRecipients({ students: targeted, audience, parents }),
    [targeted, audience, parents],
  );
  const reach = plan.rows.length;

  /**
   * Recipients the email channel cannot reach.
   *
   * The server drops these silently — it has no address to send to — so say so
   * before the teacher taps Send rather than after. Email is the channel where
   * this bites: a phone number is required on every student, an address is not.
   */
  const noEmail = channels.email
    ? targeted.reduce((n, s) => {
        let missing = 0;
        if (audience !== 'parents' && !s.email) missing += 1;
        // A guardian only counts as a recipient at all if we hold some way to
        // reach them, which mirrors how the function builds its list.
        if (
          audience !== 'students' &&
          (s.parentPhone || s.parentEmail || s.parentName) &&
          !s.parentEmail
        ) {
          missing += 1;
        }
        return n + missing;
      }, 0)
    : 0;

  /**
   * Why Send is unavailable, in the teacher's terms.
   *
   * "No group selected" used to cover all of these, including the case where a
   * group *is* ticked and simply has nobody in it — which reads as the app
   * ignoring the tap. The focus case matters too: arriving from attendance the
   * chip picker is not rendered at all, so an empty group list there is not
   * something the teacher can see, let alone fix.
   */
  const blocker =
    selectedGroups.length === 0
      ? focusIds.length
        ? t('messages.notInAnyGroup')
        : t('messages.noGroupSelected')
      : reach === 0
        ? // A roster with people in it and nobody reachable is a different
          // problem from an empty group, and "this group has no students" sent
          // teachers looking for students who were sitting right there. What is
          // missing is the numbers.
          targeted.length
          ? t('messages.nobodyReachable')
          : selectedGroups.length > 1
            ? t('messages.groupHasNoStudents', { name: '' }).trim()
            : t('messages.groupHasNoStudents', { name: selectedGroups[0].name })
        : activeChannels.length === 0
          ? t('messages.pickChannel')
          : null;

  const canSend = !blocker && draft.trim().length > 0;
  // From the platform where possible, because the naive `length / 160` is wrong
  // for every message containing a Turkmen letter — those cost 70 per segment.
  const seg = countSegments(draft);

  /**
   * Sending is the one action that must not be optimistic. Everywhere else a
   * queued write is invisible and harmless; here, showing "Delivered 8/8" for a
   * message that never left would have the teacher believe the class was told.
   * So against a real backend we await the Edge Function and report failure.
   */
  /**
   * Send the SMS half of the message from this phone.
   *
   * Kept apart from the gateway path rather than hidden behind a flag inside
   * it: nothing is shared. There is no server call, failures are per-recipient
   * rather than per-batch, it takes half a minute of watched progress, and the
   * message log has to be written by hand afterwards.
   */
  const sendFromPhone = async (body: string) => {
    if (!hasSmsPermission()) {
      const ok = await showDialog({
        title: t('sms.permissionTitle'),
        message: t('sms.permissionBody'),
        actions: [
          { label: t('common.cancel'), value: 'no', intent: 'quiet' },
          { label: t('sms.continue'), value: 'yes', intent: 'primary' },
        ],
      });
      if (ok !== 'yes') return;

      const granted = await requestSmsPermission();
      if (!granted.granted) {
        // `canAskAgain` false means Android will never show the dialog again,
        // so the only remaining route is Settings — say so rather than letting
        // the next tap fail silently.
        await showAlert(t('sms.permissionTitle'), t('sms.permissionDenied'), 'danger');
        return;
      }
    }

    const { recipients } = buildRecipients({
      students: targeted,
      groups: selectedGroups,
      audience,
      parents,
      body,
    });
    if (recipients.length === 0) return;

    // Android starts asking the teacher to confirm every message past roughly
    // thirty an hour. Better they hear it from us, before the first one.
    if (recipients.length > SYSTEM_CONFIRM_THRESHOLD) {
      const go = await showDialog({
        title: t('sms.manyTitle', { count: recipients.length }),
        message: t('sms.manyBody'),
        actions: [
          { label: t('common.cancel'), value: 'no', intent: 'quiet' },
          { label: t('sms.continue'), value: 'yes', intent: 'primary' },
        ],
      });
      if (go !== 'yes') return;
    }

    cancelled.current = false;
    batchId.current = newSmsBatchId();
    loggedMessageId.current = null;
    heldReports.current = [];
    setRun({ total: recipients.length, results: [], running: true });

    const results = await sendSmsBatch(recipients, {
      batch: batchId.current,
      shouldStop: () => cancelled.current,
      onProgress: ({ latest }) =>
        setRun((r) => (r ? { ...r, results: [...r.results, latest] } : r)),
    });

    // Merged rather than replaced: a delivery report can land while the last
    // few messages are still going out, and overwriting the list with the
    // batch's own return value would throw those updates away.
    setRun((r) =>
      r
        ? {
            ...r,
            running: false,
            results: results.map((res) => {
              const seen = r.results.find((row) => row.key === res.key);
              return seen?.delivery ? { ...res, ...seen } : res;
            }),
          }
        : r,
    );

    // Write the log even when every message failed: "we tried and nobody got
    // it" is exactly the thing a teacher needs to be able to look up later.
    if (liveSend && results.length) {
      try {
        loggedMessageId.current = await recordDeviceSms({
          groupIds: selectedGroups.map((g) => g.id),
          audience,
          body,
          deliveries: results.map((r) => ({
            studentId: r.studentId,
            recipient: r.kind,
            destination: r.phone,
            rendered: r.body,
            // `unknown` is not a state the log has. `queued` says the same
            // thing — handed over, no answer yet — and a delivery report
            // arriving later upgrades the row.
            state: r.state === 'unknown' ? 'queued' : r.state,
            error: r.reason,
          })),
        });

        // Anything the network answered while the batch was still running.
        const held = heldReports.current;
        heldReports.current = [];
        for (const report of held) await writeDelivery(loggedMessageId.current, report);

        useStore.setState({ messages: await fetchMessages() });
      } catch (e) {
        // The messages went out. Failing to write them down is worth a line in
        // the log, not an alert over the top of the result the teacher is
        // reading.
        console.warn('[classcare] could not record device SMS:', e);
      }
    }

    /*
      With no account, write the record here instead.

      The texts still went — they left the teacher's own SIM and never needed a
      server — but `recordDeviceSms` does, so without this an offline teacher
      messages a whole class and Messages stays empty. `logSentMessage` keeps it
      on the device now and, because it goes through the store, it is one of the
      things that travels up the day they sign in.
    */
    if (!liveSend && results.length) {
      logSentMessage({
        id: newSmsBatchId(),
        groupIds: selectedGroups.map((g) => g.id),
        audience,
        channels: ['sms'],
        body,
        sentAt: Date.now(),
        deliveries: results.map((r) => ({
          studentId: r.studentId,
          recipient: r.kind,
          channel: 'sms' as const,
          destination: r.phone,
          rendered: r.body,
          state: r.state === 'unknown' ? ('queued' as const) : r.state,
          error: r.reason,
        })),
      });
    }
  };

  /**
   * Refuse to start a send there is no connection for.
   *
   * Sending is not like saving a register. A register is the teacher's own
   * record and can wait for signal; a message is an act with a recipient, and
   * "it will go out later" is not what anybody means when they press Send on a
   * reminder about tonight's class.
   *
   * The check also has to happen *before* the request rather than after it
   * fails: an Edge Function call is allowed three minutes, so an offline send
   * used to sit on a spinner for the whole of it before saying anything.
   */
  const send = async () => {
    const body = draft.trim();

    /*
      Texting from the teacher's own SIM needs no internet at all, so the check
      is only about the half that does. With both channels chosen and the
      connection down, the texts should still go — abandoning them because the
      email cannot be sent would be the wrong trade for the class waiting to
      hear about tonight's lesson.
    */
    let skipEmail = false;
    if (liveSend && (!viaPhone || channels.email) && !(await isReachable(6000))) {
      if (!viaPhone) {
        await showAlert(t('error.offlineTitle'), t('messages.offlineSend'), 'danger');
        return;
      }

      const go = await showDialog({
        title: t('error.offlineTitle'),
        message: t('messages.offlineSmsOnly'),
        actions: [
          { label: t('common.cancel'), value: 'no', intent: 'quiet' },
          { label: t('sms.continue'), value: 'yes', intent: 'primary' },
        ],
      });
      if (go !== 'yes') return;
      skipEmail = true;
    }

    if (viaPhone) {
      setSending(true);
      // Held rather than thrown: the email failing is no reason to abandon the
      // texts, and the teacher gets told once the queue is done.
      let emailError: unknown = null;

      try {
        // Email first. It is one server call and takes a second, where the SMS
        // queue is a minute of watched progress — running it after would leave
        // the email sitting behind the whole class list for no reason. The SMS
        // channel is dropped from this call so nothing is sent twice.
        if (channels.email && !skipEmail) {
          try {
            await apiSendMessage({
              groupIds: selectedGroups.map((g) => g.id),
              studentIds: focusIds.length ? focusIds : undefined,
              audience,
              channels: ['email'],
              body,
            });
            useStore.setState({ messages: await fetchMessages() });
          } catch (e) {
            emailError = e;
          }
        }

        await sendFromPhone(body);
      } catch (e) {
        void showError(e, t('messages.nothingSentTitle'));
      } finally {
        setSending(false);
      }

      if (emailError) void showError(emailError, t('messages.nothingSentTitle'));
      return;
    }

    const payload = {
      groupIds: selectedGroups.map((g) => g.id),
      audience,
      channels: activeChannels.map((c) => c.key),
      body,
    };

    if (!liveSend) {
      sendMessage({ ...payload, total: reach });
      router.replace('/(tabs)/messages');
      return;
    }

    setSending(true);
    try {
      const report = await apiSendMessage({
        ...payload,
        studentIds: focusIds.length ? focusIds : undefined,
      });
      useStore.setState({ messages: await fetchMessages() });

      const skipped = report.skipped.sms + report.skipped.email + report.skipped.push;
      // Every delivery rejected. The message is in the log but nobody was told
      // anything, so stay on the composer rather than dropping the teacher on a
      // Messages list that looks like the class has been informed.
      if (report.sent === 0) {
        await showAlert(
          t('messages.nothingSentTitle'),
          [t('messages.allRejected', { count: report.failed }), ...report.errors].join('\n\n'),
          'danger',
        );
        return;
      }

      router.replace('/(tabs)/messages');

      if (report.failed || skipped) {
        void showAlert(
          t('messages.sentOf', {
            sent: report.sent,
            total: report.sent + report.failed + skipped,
          }),
          [
            skipped
              ? t(
                  audience === 'parents' ? 'grades.skippedNoParentEmail' : 'grades.skippedNoEmail',
                  { count: skipped },
                )
              : '',
            report.failed ? `${report.failed} rejected by the provider.` : '',
            ...report.errors,
          ]
            .filter(Boolean)
            .join('\n\n'),
        );
      }
    } catch (e) {
      const described = describeError(e);
      // The one case worth overriding: a 404 here is not "not found" to the
      // teacher, it means the function was never deployed. Nobody using the app
      // can fix that, but whoever set it up can, and the message names the step.
      const notDeployed = described.kind === 'notFound';
      void showAlert(
        t('messages.nothingSentTitle'),
        notDeployed ? t('error.serverMessage') : described.message,
        'danger',
      );
    } finally {
      setSending(false);
    }
  };

  return (
    <Screen>
      <TopBar
        title={t('messages.newMessage')}
        dismiss
        trailing={
          <Press onPress={() => setTemplatesOpen(true)}>
            <Text style={styles.templatesLink}>{t('messages.templates')}</Text>
          </Press>
        }
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top + 60}>
        <ScrollView
          ref={scroller}
          automaticallyAdjustKeyboardInsets
          contentContainerStyle={{
            padding: space.gutter,
            paddingTop: 18,
            paddingBottom: insets.bottom + 140 + keyboard,
          }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <Overline style={styles.label}>{t('messages.to')}</Overline>

          {focusIds.length ? (
            <Card style={styles.focusCard}>
              <View style={styles.focusHead}>
                <Icon name="warning" size={16} color={color.warningDeep} />
                <Text style={styles.focusTitle}>
                  {t('messages.absenteesToday', { count: focused.length })}
                </Text>
              </View>
              <View style={styles.focusList}>
                {focused.map((s) => (
                  <View key={s.id} style={styles.focusChip}>
                    <Avatar
                      name={s.name}
                      accent={s.accent}
                      photoId={s.id}
                      size={24}
                      radius={8}
                      fontSize={9.5}
                    />
                    <Text style={styles.focusName}>{s.name}</Text>
                  </View>
                ))}
              </View>
            </Card>
          ) : (
            <>
              {byTerm.map(({ term, groups: list, archived }) => {
                const whole = list.every((g) => selection[g.id]);
                const some = !whole && list.some((g) => selection[g.id]);
                const ids = new Set(list.map((g) => g.id));
                const heads = students.filter((st) =>
                  st.groupIds.some((id) => ids.has(id)),
                ).length;

                return (
                  <View key={term} style={styles.termBlock}>
                    {/*
                      The heading is the control. A teacher who wants the whole
                      intake should not have to tick eight chips and then count
                      them to check they got all eight.
                    */}
                    <Press
                      haptic
                      onPress={() => toggleTerm(list)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: whole }}
                      style={styles.termHead}>
                      <View
                        style={[
                          styles.termBox,
                          {
                            backgroundColor: whole ? color.primary : 'transparent',
                            borderColor: whole || some ? color.primary : color.border,
                          },
                        ]}>
                        {whole ? (
                          <Icon name="check" size={11} color={color.onDark} strokeWidth={2.6} />
                        ) : some ? (
                          <View style={styles.termDash} />
                        ) : null}
                      </View>
                      <Text style={styles.termName} numberOfLines={1}>
                        {termLabel(term, t)}
                      </Text>
                      {archived ? (
                        <View style={styles.termBadge}>
                          <Text style={styles.termBadgeLabel}>{t('archive.section')}</Text>
                        </View>
                      ) : null}
                      <Text style={styles.termCount}>{t('students.count', { count: heads })}</Text>
                    </Press>

                    <View style={[styles.chipWrap, styles.termChips]}>
                      {list.map((g) => (
                        <SelectChip
                          key={g.id}
                          label={g.name}
                          dot={accents[g.accent].dot}
                          count={students.filter((s) => s.groupIds.includes(g.id)).length}
                          selected={!!selection[g.id]}
                          onPress={() => toggleGroup(g.id)}
                        />
                      ))}
                    </View>
                  </View>
                );
              })}

              {/*
                Only where there is something to show. A teacher who has never
                archived a course is not helped by a switch for the archive.
              */}
              {showArchived || allGroups.some((g) => g.archivedAt) ? (
                <Press
                  onPress={() => {
                    // The ticks on the terms about to disappear go with them —
                    // see `selectedGroups`, which reads off what is on screen.
                    setShowArchived((on) => !on);
                  }}
                  style={styles.archiveToggle}>
                  <Icon
                    name="archive"
                    size={15}
                    color={showArchived ? color.primaryInk : color.mutedLight}
                  />
                  <Text
                    style={[
                      styles.archiveToggleLabel,
                      { color: showArchived ? color.primaryInk : color.mutedLight },
                    ]}>
                    {t(showArchived ? 'messages.hideFinished' : 'messages.showFinished')}
                  </Text>
                </Press>
              ) : null}
            </>
          )}

          <Overline style={styles.label}>{t('messages.recipients')}</Overline>
          <View style={{ marginBottom: audience === 'students' ? 20 : 12 }}>
            <Segmented
              options={AUDIENCES.map((a) => ({ key: a.key, label: t(a.labelKey) }))}
              value={audience}
              onChange={setAudience}
            />
          </View>

          {/*
            Only where it can change anything. On a message to students alone
            there is no guardian in the send, and a control that does nothing is
            a control the teacher has to work out the irrelevance of.
          */}
          {audience !== 'students' ? (
            <View style={{ marginBottom: 20 }}>
              <Overline style={styles.label}>{t('messages.whichParent')}</Overline>
              <Segmented
                options={PARENTS.map((p) => ({ key: p.key, label: t(p.labelKey) }))}
                value={parents}
                onChange={setParents}
              />
              <Text style={[styles.infoText, { marginTop: 8 }]}>
                {t('messages.parentFallback')}
              </Text>
            </View>
          ) : null}

          <Overline style={styles.label}>{t('messages.sendVia')}</Overline>
          <View style={styles.channelRow}>
            {channelsHere.map((c) => {
              const on = channels[c.key];
              return (
                <Press
                  key={c.key}
                  haptic
                  onPress={() => setChannels((x) => ({ ...x, [c.key]: !x[c.key] }))}
                  style={[
                    styles.channel,
                    {
                      backgroundColor: on ? color.primaryTint : color.surface,
                      borderColor: on ? color.primary : color.border,
                    },
                  ]}>
                  <Icon
                    name={c.icon}
                    size={20}
                    strokeWidth={1.6}
                    color={on ? color.primaryInk : color.inkSoft}
                  />
                  <Text
                    style={[styles.channelLabel, { color: on ? color.primaryInk : color.inkSoft }]}>
                    {t(c.labelKey)}
                  </Text>
                </Press>
              );
            })}
          </View>

          {/* One route, stated rather than chosen. See `CHANNELS` above. */}
          {deviceSms && channels.sms ? (
            <Text style={styles.transportHint}>{t('sms.viaPhoneHint')}</Text>
          ) : null}

          {noEmail > 0 ? (
            <View style={styles.warn}>
              <Icon name="info" size={18} color={color.warningDeep} />
              <Text style={styles.warnText}>{t('messages.noEmailWarn', { count: noEmail })}</Text>
            </View>
          ) : null}

          {/*
            Why the count is lower than the register.

            Two children on one mother's number is one message, and a teacher
            who reads "reaches 41" over a roster of 44 is owed the reason before
            they go looking for the three they think were dropped.
          */}
          {plan.merged > 0 ? (
            <View style={styles.info}>
              <Icon name="info" size={18} color={color.primary} />
              <Text style={styles.infoText}>
                {t('messages.sharedNumbers', { count: plan.merged })}
              </Text>
            </View>
          ) : null}

          <Overline style={styles.label}>{t('messages.message')}</Overline>
          <Card style={styles.editor}>
            <TextInput
              value={draft}
              onChangeText={setDraft}
              multiline
              placeholder={t('messages.typeMessage')}
              placeholderTextColor={color.mutedLight}
              style={styles.editorInput}
              textAlignVertical="top"
              selectionColor={color.primary}
              keyboardAppearance={scheme === 'dark' ? 'dark' : 'light'}
            />
            <View style={styles.editorFoot}>
              <View style={styles.placeholderRow}>
                {PLACEHOLDERS.map((p) => (
                  <Press
                    key={p}
                    onPress={() => setDraft((d) => `${d}${d.endsWith(' ') || !d ? '' : ' '}${p}`)}
                    style={styles.placeholderChip}>
                    <Text style={styles.placeholderLabel}>{p}</Text>
                  </Press>
                ))}
              </View>
              <Text style={styles.charCount}>
                {draft.length} · {t('sms.segments', { count: seg.segments })}
              </Text>
            </View>
          </Card>

          {/* Only worth saying once the message is long enough for it to cost
              something — a two-word draft in Turkmen is still one segment. */}
          {channels.sms && seg.encoding === 'ucs2' && seg.segments > 1 ? (
            <View style={styles.warn}>
              <Icon name="info" size={18} color={color.warningDeep} />
              <Text style={styles.warnText}>{t('sms.ucs2Warn')}</Text>
            </View>
          ) : null}

          <View style={styles.info}>
            <Icon name="info" size={18} color={color.primary} />
            <Text style={styles.infoText}>{t('messages.placeholderHint')}</Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <StickyFooter>
        <FooterSummary
          title={blocker ?? t('messages.reaches', { count: reach })}
          hint={
            activeChannels.length
              ? activeChannels.map((c) => t(c.labelKey)).join(' + ')
              : t('messages.pickChannel')
          }
        />
        <Button
          label={sending ? t('common.sending') : t('messages.send')}
          icon="send"
          onPress={send}
          disabled={!canSend || sending}
        />
      </StickyFooter>

      <SmsRunSheet
        visible={run !== null}
        total={run?.total ?? 0}
        results={run?.results ?? []}
        running={run?.running ?? false}
        onCancel={() => {
          // Stops the queue between messages. The one already handed to the
          // radio still goes — there is no unsending it.
          cancelled.current = true;
        }}
        onClose={() => {
          const sentSomething = (run?.results.length ?? 0) > 0;
          setRun(null);
          // Cancelled before anything went out: leave the teacher on their
          // draft rather than on a Messages list with nothing new in it.
          if (sentSomething) router.replace('/(tabs)/messages');
        }}
      />

      <Modal
        visible={templatesOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setTemplatesOpen(false)}>
        <Press style={styles.scrim} onPress={() => setTemplatesOpen(false)} />
        {/*
          Capped as a fraction of the screen, not at a pixel height.

          The sheet used to be however tall its contents were, which was fine
          with three starters and stopped being fine at five plus whatever the
          teacher has written: the rows ran off the bottom of the screen and
          took "Manage templates" with them, and nothing scrolled. A fixed
          `maxHeight` would only move the problem to the next phone — 85% of
          whatever this screen is leaves the scrim visible to tap on, and is
          shorter than that whenever the list is.
        */}
        <View
          style={[
            styles.sheet,
            { maxHeight: '85%', paddingBottom: Math.max(insets.bottom, 16) + 12 },
          ]}>
          <View style={styles.grabber} />
          <Text style={[text.sheetTitle, styles.ink, { marginBottom: 4 }]}>
            {t('messages.templates')}
          </Text>
          <Txt style={styles.sheetHint}>{t('messages.placeholderHint')}</Txt>

          {/*
            Only the list scrolls. The title says what the sheet is and "Manage
            templates" is the way out of it; both scrolling away would leave a
            teacher halfway down a list of their own wording with no heading and
            no exit.
          */}
          <ScrollView style={styles.templateList} keyboardShouldPersistTaps="handled">
            {[...savedTemplates, ...starterTemplates].map((template, i) => (
              <View key={template.id}>
                {i > 0 ? <Divider /> : null}
                <Press
                  onPress={() => {
                    setDraft(template.body);
                    setTemplatesOpen(false);
                  }}
                  style={styles.templateRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.templateTitle}>{template.title}</Text>
                    <Text style={styles.templateBody} numberOfLines={2}>
                      {template.body}
                    </Text>
                  </View>
                  <Icon name="disclosure" size={16} color={color.chevron} />
                </Press>
              </View>
            ))}
          </ScrollView>

          <Divider />
          <Press
            onPress={() => {
              setTemplatesOpen(false);
              router.push('/templates');
            }}
            style={styles.manageRow}>
            <Icon name="pencil" size={15} color={color.primary} />
            <Text style={styles.manageLabel}>{t('template.manage')}</Text>
          </Press>
        </View>
      </Modal>
    </Screen>
  );
}

const makeStyles = ({ color, accents }: Theme) =>
  StyleSheet.create({
    /** Default body ink. Text does not inherit colour from a parent View. */
    ink: { color: color.ink },
    templatesLink: {
      fontFamily: body[700],
      fontSize: 13,
      color: color.primary,
    },
    label: { marginBottom: 10 },

    /* The term picker — a heading that is itself the select-all, then its chips. */
    termBlock: { marginBottom: 16 },
    /* `chipWrap`'s own gap below would stack with the block's. */
    termChips: { marginBottom: 0 },
    termHead: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 9,
      paddingVertical: 7,
      paddingHorizontal: 2,
    },
    termBox: {
      width: 19,
      height: 19,
      borderRadius: 6,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent: 'center',
    },
    /* Part of a term taken. A dash rather than a tick, because a tick here
       would say the whole intake is going and it is not. */
    termDash: { width: 9, height: 2, borderRadius: 1, backgroundColor: color.primary },
    termName: { flexShrink: 1, fontFamily: body[700], fontSize: 13.5, color: color.inkSoft },
    termBadge: {
      paddingHorizontal: 6,
      paddingVertical: 2,
      borderRadius: radius.xs,
      backgroundColor: color.fill,
    },
    termBadgeLabel: { fontFamily: body[700], fontSize: 10, color: color.mutedLight },
    termCount: { marginLeft: 'auto', fontFamily: body[400], fontSize: 12, color: color.mutedLight },

    archiveToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      alignSelf: 'flex-start',
      paddingVertical: 7,
      paddingHorizontal: 2,
      marginBottom: 12,
    },
    archiveToggleLabel: { fontFamily: body[700], fontSize: 12.5 },

    chipWrap: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
      marginBottom: 20,
    },

    focusCard: { padding: 14, marginBottom: 20, gap: 10 },
    focusHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    focusTitle: { fontFamily: body[700], fontSize: 13.5, color: color.ink },
    focusList: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    focusChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 7,
      backgroundColor: color.fill,
      borderRadius: radius.lg,
      paddingLeft: 5,
      paddingRight: 10,
      paddingVertical: 5,
    },
    focusName: { fontFamily: body[600], fontSize: 12.5, color: color.inkSoft },

    channelRow: { flexDirection: 'row', gap: 8, marginBottom: 20 },
    channel: {
      flex: 1,
      height: 74,
      borderRadius: radius.button,
      borderWidth: 1.5,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
    },
    channelLabel: { fontFamily: body[600], fontSize: 12.5 },

    editor: { paddingHorizontal: 15, paddingTop: 14, paddingBottom: 11 },
    editorInput: {
      fontFamily: body[400],
      fontSize: 14.5,
      lineHeight: 22.5,
      color: color.ink,
      minHeight: 112,
      padding: 0,
    },
    editorFoot: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      marginTop: 8,
      paddingTop: 10,
      borderTopWidth: 1,
      borderTopColor: color.divider,
    },
    // Eight of them now rather than three, so they wrap instead of running off
    // the side of the card.
    placeholderRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7, flex: 1 },
    placeholderChip: {
      height: 30,
      paddingHorizontal: 10,
      borderRadius: radius.md,
      backgroundColor: color.fill,
      justifyContent: 'center',
    },
    placeholderLabel: {
      fontFamily: body[600],
      fontSize: 12,
      color: color.inkSoft,
    },
    charCount: {
      fontFamily: body[600],
      fontSize: 11.5,
      color: color.mutedLight,
      ...text.tabular,
    },

    info: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: color.primaryTint,
      borderRadius: radius.button,
      paddingHorizontal: 15,
      paddingVertical: 13,
      marginTop: 14,
    },
    warn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      backgroundColor: accents.amber.tint,
      borderRadius: radius.button,
      paddingHorizontal: 15,
      paddingVertical: 13,
      marginBottom: 20,
    },
    warnText: {
      flex: 1,
      fontFamily: body[400],
      fontSize: 12.5,
      lineHeight: 18.1,
      color: accents.amber.ink,
    },
    transportHint: {
      fontFamily: body[400],
      fontSize: 12.5,
      lineHeight: 18,
      color: color.mutedLight,
      marginBottom: 20,
    },
    infoText: {
      flex: 1,
      fontFamily: body[400],
      fontSize: 12.5,
      lineHeight: 18.1,
      color: color.primaryInk,
    },

    scrim: { flex: 1, backgroundColor: color.scrim },
    sheet: {
      backgroundColor: color.sheet,
      borderTopLeftRadius: radius.sheet,
      borderTopRightRadius: radius.sheet,
      paddingHorizontal: space.gutter,
      paddingTop: 10,
    },
    grabber: {
      alignSelf: 'center',
      width: 40,
      height: 4,
      borderRadius: 2,
      backgroundColor: color.dashed,
      marginBottom: 14,
    },
    sheetHint: { fontSize: 13, color: color.muted, marginBottom: 8 },
    /*
      Shrinks, never grows.

      `flexGrow: 0` so a sheet with two templates in it stays two templates
      tall rather than stretching to the cap, and `flexShrink: 1` so a long one
      gives way to the header and the footer instead of pushing them out.
    */
    templateList: { flexGrow: 0, flexShrink: 1 },
    templateRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingVertical: 14,
    },
    templateTitle: { fontFamily: body[700], fontSize: 14.5, color: color.ink },
    manageRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      paddingVertical: 14,
      marginTop: 4,
    },
    manageLabel: { fontFamily: body[700], fontSize: 14, color: color.primary },
    templateBody: {
      fontFamily: body[400],
      fontSize: 12.5,
      color: color.muted,
      marginTop: 3,
    },
  });
