/**
 * The QR a teacher holds up in front of the class, and the phone that serves
 * the files behind it.
 *
 * This screen is the whole transfer. Opening it starts a file server on the
 * teacher's phone — and, where there is no network to use, an access point as
 * well; leaving it stops both. The code on screen is not a link to anything —
 * there is nothing on the far side of it — it carries the assignment itself
 * plus everything a student's phone needs to reach this one.
 *
 * Which network that is over is not fixed, and the screen says which it turned
 * out to be: the teacher's own hotspot if it is running, a Wi-Fi Direct group
 * otherwise, and the Wi-Fi they are both on as a last resort. The teacher is
 * the one talking to the room, so they need the sentence that goes with it.
 *
 * ## Why the work starts here and not on the assignment screen
 *
 * Because the teacher needs to see that it is running. A phone quietly running
 * an open access point after the lesson ended is not something to leave to a
 * stray `useEffect` somewhere else: the thing that starts it is the thing on
 * screen saying it is running, and leaving this screen — or Stop, here or on
 * the notification — is what ends it.
 *
 * Leaving the *app* is not. Pressing Home to check the time used to freeze the
 * transfer for every student mid-file, because Android freezes an app nobody is
 * looking at. Sharing now runs in a foreground service with a notification, so
 * the teacher can put the phone in a pocket and the class still gets the work.
 *
 * ## The live count
 *
 * The teacher can see students arriving. That is not decoration — it is the
 * only feedback in the room that any of this worked. Without it a teacher holds
 * up a code and has no idea whether thirty phones got the worksheet or none
 * did, and has to ask.
 */
import { useFocusEffect, useLocalSearchParams, useNavigation } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { confirm } from '@/components/Dialog';
import { Icon } from '@/components/Icon';
import { Screen, TopBar } from '@/components/layout';
import { QrCode } from '@/components/QrCode';
import { Button, Card, EmptyState, Overline, Press } from '@/components/ui';
import { useT } from '@/i18n/useT';
import { formatBytes } from '@/lib/attachments';
import { beamToken } from '@/lib/beam';
import { recordHandout } from '@/lib/handoutLog';
import {
  beamBlocker,
  BeamNotPermitted,
  BeamSettingOff,
  BeamTooBig,
  type BeamNotifyText,
  type BeamRoute,
  onBeamHostStopped,
  onBeamPeer,
  SETTINGS_INTENT,
  type SettingOff,
  startBeam,
  stopBeam,
} from '@/lib/beamShare';
import { radius, space, useTheme, useThemedStyles, type Theme } from '@/theme';
import { body, text } from '@/theme/type';

type Arg = { uri: string; name: string; mime: string; size: number };

export default function HandoutScreen() {
  const t = useT();
  const { color, status } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  const params = useLocalSearchParams<{
    /**
     * The handout's identity, minted by whoever sent us here.
     *
     * Passed in rather than made here so that re-sharing from the history
     * updates the same record — and finds the same folder of files — instead
     * of filing a second copy of last week's worksheet.
     */
    id?: string;
    title?: string;
    instructions?: string;
    teacher?: string;
    files?: string;
  }>();

  const files = useMemo<Arg[]>(() => {
    try {
      const parsed = JSON.parse(params.files || '[]') as Arg[];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }, [params.files]);

  /**
   * Fixed for the life of the screen.
   *
   * A token regenerated on re-render would invalidate the code the class is
   * currently pointing their cameras at, which is the sort of bug that only
   * shows up in front of thirty people.
   */
  const token = useRef(beamToken()).current;
  const madeAt = useRef(Math.floor(Date.now() / 1000)).current;
  /** Falls back for a handout opened without one — nothing else depends on it. */
  const handoutId = useRef(params.id || `${madeAt}-${token.slice(0, 6)}`).current;

  const [payload, setPayload] = useState<string | null>(null);
  /**
   * Which of the three ways this turned out to be reached on.
   *
   * On screen, because it changes what the teacher has to say out loud. A
   * Wi-Fi Direct group is one the students' phones join by themselves; a
   * hotspot is one they have to be on already. Telling a room "just scan" when
   * half of them are not on the network is the difference between a transfer
   * and a minute of confusion.
   */
  const [route, setRoute] = useState<BeamRoute | null>(null);
  const [network, setNetwork] = useState<{ ssid: string; passphrase: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when the fix is a system switch, so the screen can offer the screen. */
  const [settingOff, setSettingOff] = useState<SettingOff | null>(null);
  /**
   * The native trace, shown small under the message.
   *
   * Ugly on purpose and only present when something failed. This is the class
   * of bug that reproduces on one handset and no other, and a teacher who can
   * photograph six words of trace has given a far better report than one who
   * can only say it did not work.
   */
  const [detail, setDetail] = useState<string | null>(null);
  /** Bumped to re-run the effect after the teacher has been to Settings. */
  const [attempt, setAttempt] = useState(0);
  const [received, setReceived] = useState(0);
  const [busyPeers, setBusyPeers] = useState(0);
  /**
   * The last student whose transfer went wrong, and why.
   *
   * The teacher is the only one holding both phones' side of the story, and
   * until now their screen said nothing at all when a transfer failed — the
   * counter simply did not go up. The student saw an error, the teacher saw a
   * QR code, and neither could tell the other what had happened.
   */
  const [peerFailure, setPeerFailure] = useState<string | null>(null);
  /**
   * Sharing ended by Stop — here, or on the notification while the teacher was
   * elsewhere. Holds the final count, which is what they come back to read.
   */
  const [stopped, setStopped] = useState<{ received: number } | null>(null);
  /** The network written out, folded away until somebody needs it. */
  const [showNetwork, setShowNetwork] = useState(false);

  /**
   * The count, in a ref as well as in state.
   *
   * The cleanup function that writes the history runs after the last render,
   * and a `useState` value captured in that closure is the one from when the
   * effect was set up — zero. A ref reads what is true now.
   */
  const tally = useRef({ started: false, received: 0 });
  /** Read by the leave guard, which is registered once. */
  const busyNow = useRef(0);
  busyNow.current = busyPeers;

  const assignment = useMemo(
    () => ({
      v: 1 as const,
      t: params.title || t('assign.new'),
      b: params.instructions || '',
      w: params.teacher || '',
      d: madeAt,
      f: files.map((f) => ({ n: f.name, m: f.mime, s: f.size })),
    }),
    [params.title, params.instructions, params.teacher, files, madeAt, t],
  );

  /**
   * The notification's words. Native has no translations of its own, so they
   * travel with the start call; the placeholders are filled in natively as
   * students arrive.
   */
  const notify = useMemo<BeamNotifyText>(
    () => ({
      channel: t('beam.notify.channel'),
      channelResult: t('beam.notify.channelResult'),
      title: t('beam.notify.title'),
      waiting: t('beam.notify.waiting'),
      received: t('beam.notify.received'),
      receiving: t('beam.notify.receiving'),
      stop: t('beam.notify.stop'),
    }),
    [t],
  );

  /**
   * Written down as soon as the code is up, and again with the count when
   * sharing ends. A teacher who shares a worksheet and closes the app without
   * waiting still has a record that they shared it — which is the question
   * the assignments tab is opened to answer.
   */
  const record = useCallback(
    (received: number) =>
      recordHandout({
        id: handoutId,
        title: assignment.t,
        body: assignment.b,
        sharedAt: madeAt * 1000,
        // The uri too, so the history can hand the same files out again.
        files: files.map((f) => ({ name: f.name, size: f.size, uri: f.uri, mime: f.mime })),
        received,
      }),
    [handoutId, assignment, madeAt, files],
  );

  /* ------------------------------------------------------- Start and stop */

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      const run = async () => {
        setError(null);
        setSettingOff(null);
        setDetail(null);
        /*
          Every share starts at nobody.

          The tally belongs to the handout on screen, not to the app. A teacher
          who shares a worksheet, goes back, and shares a different one must not
          see the first one's count sitting under the second one's code — they
          read that number and stop holding the code up. Reset here rather than
          on mount, because "Try again" re-runs this without remounting.
        */
        setReceived(0);
        setBusyPeers(0);
        setPeerFailure(null);
        setStopped(null);
        setPayload(null);
        tally.current = { started: false, received: 0 };

        const blocker = beamBlocker();
        if (blocker) {
          if (blocker !== 'needsRebuild' && blocker !== 'unsupported') setSettingOff(blocker);
          setError(t(`beam.${blocker}`));
          return;
        }
        try {
          const started = await startBeam(assignment, files, token, notify);
          // The teacher left while Android was bringing the group up. Take it
          // straight back down — the cleanup below already ran.
          if (cancelled) {
            void stopBeam();
            return;
          }
          record(0);
          tally.current = { started: true, received: 0 };
          setRoute(started.route);
          setNetwork(started.ssid ? { ssid: started.ssid, passphrase: started.passphrase } : null);
          setPayload(started.payload);
        } catch (e) {
          if (cancelled) return;
          if (e instanceof BeamTooBig) setError(t('beam.tooBig'));
          else if (e instanceof BeamNotPermitted) setError(t('beam.permission'));
          else if (e instanceof BeamSettingOff) {
            setSettingOff(e.setting);
            setError(t(`beam.${e.setting}`));
          } else if (e instanceof Error && e.message.startsWith('timeout')) {
            // The group never materialised. Almost always a Wi-Fi stack that
            // needs bouncing — say that rather than showing the raw word, and
            // keep the trace underneath for when it is not.
            setError(t('beam.timeout'));
            setDetail(e.message);
          } else {
            setError(e instanceof Error ? e.message : String(e));
            if (e instanceof Error) setDetail(e.message);
          }
        }
      };

      void run();

      return () => {
        cancelled = true;
        // The tally as it finally stood. Nothing arrives later to correct it —
        // there is no server to hear from — so this is the last chance to
        // record how many phones took the handout.
        if (tally.current.started) record(tally.current.received);
        // Unconditional. Leaving this screen must take the access point down
        // whether it came up cleanly, failed halfway, or is still starting.
        void stopBeam();
      };
    }, [assignment, files, token, t, attempt, notify, record]),
  );

  /**
   * Stop, from the button here.
   *
   * Asked first only when somebody is mid-file: stopping then cuts them off,
   * and a teacher tapping Stop as the bell goes may not have seen the two
   * phones still pulling. With nobody receiving it just stops.
   */
  const stopNow = async () => {
    if (busyNow.current > 0) {
      const ok = await confirm({
        title: t('beam.stopAsk'),
        message: t('beam.stopAskBusy', { count: busyNow.current }),
        confirmLabel: t('beam.stop'),
        cancelLabel: t('beam.keepSharing'),
      });
      if (!ok) return;
    }
    await stopBeam();
    record(tally.current.received);
    setStopped({ received: tally.current.received });
    setPayload(null);
    setBusyPeers(0);
  };

  /*
    The same question on the way out of the screen.

    Leaving stops sharing — that is how the teacher ends it — so leaving while
    a student is halfway through a file deserves the same "are you sure" the
    Stop button gets. Leaving the *app* is a different thing and asks nothing:
    sharing carries on in the background.
  */
  const navigation = useNavigation();
  const leaving = useRef(false);
  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e) => {
        if (leaving.current || busyNow.current === 0) return;
        e.preventDefault();
        void confirm({
          title: t('beam.stopAsk'),
          message: t('beam.stopAskBusy', { count: busyNow.current }),
          confirmLabel: t('beam.stop'),
          cancelLabel: t('beam.keepSharing'),
        }).then((ok) => {
          if (!ok) return;
          leaving.current = true;
          navigation.dispatch(e.data.action);
        });
      }),
    [navigation, t],
  );

  /*
    Stop pressed on the notification, with this screen in the background. The
    code it is showing no longer leads anywhere, so it goes, and the count
    stays for the teacher to read when they come back.
  */
  useEffect(
    () =>
      onBeamHostStopped(({ received: final }) => {
        const count = Math.max(final, tally.current.received);
        record(count);
        setStopped({ received: count });
        setPayload(null);
        setBusyPeers(0);
      }),
    [record],
  );

  /* --------------------------------------------------- Students arriving */

  useEffect(
    () =>
      onBeamPeer((event) => {
        if (event.kind === 'started') {
          setBusyPeers((n) => n + 1);
          setPeerFailure(null);
        } else if (event.kind === 'done') {
          setBusyPeers((n) => Math.max(0, n - 1));
          setReceived(event.total);
          tally.current.received = event.total;
        } else if (event.kind === 'failed') {
          setBusyPeers((n) => Math.max(0, n - 1));
          setPeerFailure(event.message);
        } else if (event.kind === 'rejected') {
          setBusyPeers((n) => Math.max(0, n - 1));
          // A code from a previous lesson, or an app too old to speak to this
          // one. Both look identical from here, and both are worth saying.
          setPeerFailure(t('beam.peerRejected'));
        } else if (event.kind === 'error') {
          setPeerFailure(event.message);
        }
      }),
    [t],
  );

  /* ------------------------------------------------------------- Render */

  if (error) {
    return (
      <Screen>
        <TopBar title={t('beam.title')} dismiss />
        <EmptyState title={t('beam.cannotShare')} hint={error} />
        {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        {/*
          A way out, not just a diagnosis. Both of these are one switch away,
          and a teacher standing in front of a class should not have to guess
          which of the phone's many settings screens holds it.
        */}
        <View style={styles.rescue}>
          {settingOff ? (
            <Button
              label={t('beam.openSettings')}
              icon="gear"
              onPress={() => void Linking.sendIntent(SETTINGS_INTENT[settingOff]).catch(() => {})}
            />
          ) : null}
          <Button
            label={t('beam.tryAgain')}
            variant="outline"
            onPress={() => setAttempt((n) => n + 1)}
          />
        </View>
      </Screen>
    );
  }

  if (stopped) {
    return (
      <Screen>
        <TopBar title={t('beam.title')} dismiss />
        <View style={styles.stoppedWrap}>
          <View style={[styles.stoppedBadge, { backgroundColor: color.primaryTint }]}>
            <Icon name="check" size={26} color={color.primary} />
          </View>
          <Text style={styles.stoppedTitle}>{t('beam.stopped')}</Text>
          <Text style={styles.stoppedHint}>
            {t('beam.stoppedHint', { count: stopped.received })}
          </Text>
        </View>
        <View style={styles.rescue}>
          <Button label={t('beam.shareAgain')} icon="qr" onPress={() => setAttempt((n) => n + 1)} />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <TopBar title={t('beam.title')} dismiss />

      <ScrollView
        contentContainerStyle={{ padding: space.gutter, paddingBottom: insets.bottom + 32 }}
        showsVerticalScrollIndicator={false}>
        {/*
          Whether it is live, before anything else. A teacher glancing down
          mid-sentence needs one word: is this thing working.
        */}
        <View style={styles.statusRow}>
          {payload ? (
            <View style={[styles.statusPill, { backgroundColor: status.present.tint }]}>
              <View style={[styles.liveDot, { backgroundColor: color.success }]} />
              <Text style={[styles.statusLabel, { color: color.successDeep }]}>
                {t('beam.live')}
              </Text>
            </View>
          ) : (
            <View style={[styles.statusPill, { backgroundColor: color.fill }]}>
              <ActivityIndicator size="small" color={color.mutedLight} />
              <Text style={[styles.statusLabel, { color: color.mutedLight }]}>
                {t('beam.starting')}
              </Text>
            </View>
          )}
        </View>

        {/*
          The code large. Everything else here is for the teacher; this part is
          for a camera three metres away, and scannability is a function of how
          big each module lands on the sensor.
        */}
        <View style={styles.codeWrap}>
          {payload ? (
            <QrCode value={payload} size={300} />
          ) : (
            <View style={styles.starting}>
              <ActivityIndicator color={color.primary} />
            </View>
          )}
        </View>

        {/*
          The only feedback in the room that any of this worked. Two numbers,
          big: who has it, and who is getting it right now.
        */}
        {payload ? (
          <View style={styles.tallyRow}>
            <View style={[styles.tallyCard, { backgroundColor: status.present.tint }]}>
              <Icon name="check" size={16} color={color.successDeep} />
              <Text style={[styles.tallyNumber, { color: color.successDeep }]}>{received}</Text>
              <Text style={[styles.tallyCaption, { color: color.successDeep }]}>
                {t('beam.gotIt')}
              </Text>
            </View>
            <View style={[styles.tallyCard, { backgroundColor: color.primaryTint }]}>
              {busyPeers > 0 ? (
                <ActivityIndicator size="small" color={color.primaryInk} />
              ) : (
                <Icon name="refresh" size={16} color={color.primaryInk} />
              )}
              <Text style={[styles.tallyNumber, { color: color.primaryInk }]}>{busyPeers}</Text>
              <Text style={[styles.tallyCaption, { color: color.primaryInk }]}>
                {t('beam.inProgress')}
              </Text>
            </View>
          </View>
        ) : null}

        {/*
          What went wrong for the student standing in front of them. The
          teacher is the one who can act on it: an out-of-date app, a file this
          phone could not read, a code from last lesson.
        */}
        {peerFailure ? (
          <View style={styles.peerFailure}>
            <Icon name="warning" size={15} color={color.dangerDeep} />
            <Text style={styles.peerFailureText}>{peerFailure}</Text>
          </View>
        ) : null}

        {/*
          The sentence to say to the room, as three steps. On the direct route
          the students' phones join by themselves, which is the third step; on
          the other two they have to be on the network already, which the route
          note underneath says.
        */}
        <Card style={styles.steps}>
          <Overline style={{ marginBottom: 10 }}>{t('beam.stepsTitle')}</Overline>
          {[t('beam.step1'), t('beam.step2'), t(route === 'direct' ? 'beam.step3' : 'beam.step3Same')].map(
            (line, i) => (
              <View key={i} style={styles.stepRow}>
                <View style={[styles.stepNumber, { backgroundColor: color.primaryTint }]}>
                  <Text style={[styles.stepNumberLabel, { color: color.primaryInk }]}>{i + 1}</Text>
                </View>
                <Text style={styles.stepText}>{line}</Text>
              </View>
            ),
          )}
          {route && route !== 'direct' ? (
            <Text style={styles.routeLabel}>{t(`beam.route.${route}`)}</Text>
          ) : null}
        </Card>

        {/*
          The network written out, folded away. Students' phones join on their
          own now; this is for the one phone in thirty that will not, and a
          password printed under the code by default read as an instruction to
          type it.
        */}
        {network ? (
          <>
            <Press onPress={() => setShowNetwork((v) => !v)} style={styles.networkToggle}>
              <Icon name="info" size={14} color={color.mutedLight} />
              <Text style={styles.networkToggleLabel}>{t('beam.cantConnect')}</Text>
              <Icon
                name="disclosure"
                size={14}
                color={color.mutedLight}
                style={{ transform: [{ rotate: showNetwork ? '90deg' : '0deg' }] }}
              />
            </Press>
            {showNetwork ? (
              <Card style={styles.network}>
                <Text style={styles.networkHint}>{t('beam.manualHint')}</Text>
                <View style={styles.networkRow}>
                  <Text style={styles.networkKey}>{t('beam.networkName')}</Text>
                  <Text style={styles.networkValue} selectable>
                    {network.ssid}
                  </Text>
                </View>
                <View style={styles.networkRow}>
                  <Text style={styles.networkKey}>{t('beam.networkPassword')}</Text>
                  <Text style={styles.networkValue} selectable>
                    {network.passphrase}
                  </Text>
                </View>
              </Card>
            ) : null}
          </>
        ) : null}

        <Card style={styles.details}>
          <Text style={styles.title}>{assignment.t}</Text>
          {assignment.w ? (
            <Text style={styles.from}>{t('beam.from', { name: assignment.w })}</Text>
          ) : null}
          {assignment.b ? <Text style={styles.instructions}>{assignment.b}</Text> : null}
        </Card>

        <Overline style={styles.label}>{t('beam.files')}</Overline>
        {files.length ? (
          <Card style={styles.fileList}>
            {files.map((file, i) => (
              <View key={`${file.name}-${i}`} style={styles.fileRow}>
                <View style={[styles.fileGlyph, { backgroundColor: color.primaryTint }]}>
                  <Icon name="paperclip" size={15} color={color.primary} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.fileName} numberOfLines={1}>
                    {file.name}
                  </Text>
                  <Text style={styles.fileMeta}>{formatBytes(file.size)}</Text>
                </View>
              </View>
            ))}
          </Card>
        ) : (
          <Card style={styles.emptyFiles}>
            <Text style={styles.fileMeta}>{t('beam.noFiles')}</Text>
          </Card>
        )}

        {/*
          Said out loud, because a teacher who learned "keep this screen open"
          from the last version will otherwise stand there holding the phone.
        */}
        <View style={styles.backgroundNote}>
          <Icon name="bell" size={15} color={color.mutedLight} />
          <Text style={styles.note}>{t('beam.background')}</Text>
        </View>

        {payload ? (
          <Button
            label={t('beam.stop')}
            icon="close"
            variant="outline"
            onPress={() => void stopNow()}
            style={{ marginTop: 14 }}
          />
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const makeStyles = ({ accents, color }: Theme) =>
  StyleSheet.create({
    rescue: { paddingHorizontal: space.gutter, paddingBottom: 28, gap: 10 },
    detail: {
      fontFamily: body[400],
      fontSize: 11,
      lineHeight: 16,
      color: color.mutedLight,
      textAlign: 'center',
      paddingHorizontal: space.gutter,
      paddingBottom: 14,
    },
    statusRow: { alignItems: 'center', marginBottom: 12 },
    statusPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      height: 30,
      borderRadius: 15,
    },
    liveDot: { width: 8, height: 8, borderRadius: 4 },
    statusLabel: { fontFamily: body[700], fontSize: 12.5 },

    codeWrap: { alignItems: 'center', paddingVertical: 4, minHeight: 300, justifyContent: 'center' },
    starting: { alignItems: 'center', gap: 14 },

    tallyRow: { flexDirection: 'row', gap: 10, marginTop: 16 },
    tallyCard: {
      flex: 1,
      alignItems: 'center',
      gap: 2,
      paddingVertical: 12,
      borderRadius: radius.control,
    },
    tallyNumber: { fontFamily: body[700], fontSize: 24, ...text.tabular },
    tallyCaption: { fontFamily: body[600], fontSize: 12 },

    steps: { padding: 16, marginTop: 16 },
    stepRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6 },
    stepNumber: {
      width: 26,
      height: 26,
      borderRadius: 13,
      alignItems: 'center',
      justifyContent: 'center',
    },
    stepNumberLabel: { fontFamily: body[700], fontSize: 13 },
    stepText: { flex: 1, fontFamily: body[500], fontSize: 14, lineHeight: 20, color: color.ink },
    routeLabel: {
      fontFamily: body[400],
      fontSize: 12.5,
      lineHeight: 18.5,
      color: color.mutedLight,
      marginTop: 8,
    },

    networkToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      marginTop: 12,
      paddingVertical: 8,
    },
    networkToggleLabel: { fontFamily: body[600], fontSize: 13, color: color.mutedLight },

    stoppedWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 10 },
    stoppedBadge: {
      width: 64,
      height: 64,
      borderRadius: 32,
      alignItems: 'center',
      justifyContent: 'center',
      marginBottom: 6,
    },
    stoppedTitle: { ...text.section, color: color.ink, textAlign: 'center' },
    stoppedHint: {
      fontFamily: body[400],
      fontSize: 14,
      lineHeight: 21,
      color: color.mutedLight,
      textAlign: 'center',
    },

    peerFailure: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 9,
      marginTop: 12,
      paddingHorizontal: 13,
      paddingVertical: 11,
      borderRadius: radius.control,
      backgroundColor: accents.rose.tint,
    },
    peerFailureText: {
      flex: 1,
      fontFamily: body[500],
      fontSize: 12.5,
      lineHeight: 18.5,
      color: accents.rose.ink,
    },

    network: { marginTop: 4, gap: 8, padding: 14 },
    networkHint: {
      fontFamily: body[400],
      fontSize: 12,
      lineHeight: 17.5,
      color: color.mutedLight,
    },
    networkRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    networkKey: { width: 92, fontFamily: body[400], fontSize: 12.5, color: color.mutedLight },
    networkValue: { flex: 1, fontFamily: body[700], fontSize: 14, color: color.ink },

    tally: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      marginTop: 14,
    },
    tallyLabel: { fontFamily: body[600], fontSize: 13, color: color.inkSoft },

    details: { padding: 16, marginTop: 22, marginBottom: 22 },
    title: { ...text.section, color: color.ink },
    from: { fontFamily: body[500], fontSize: 12.5, color: color.mutedLight, marginTop: 3 },
    instructions: {
      fontFamily: body[400],
      fontSize: 14,
      lineHeight: 21,
      color: color.inkSoft,
      marginTop: 12,
    },

    label: { marginBottom: 10 },
    fileList: { paddingVertical: 4 },
    emptyFiles: { padding: 16 },
    fileRow: { flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12 },
    fileGlyph: {
      width: 34,
      height: 34,
      borderRadius: radius.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    fileName: { fontFamily: body[600], fontSize: 14, color: color.ink },
    fileMeta: { fontFamily: body[400], fontSize: 12, color: color.mutedLight, marginTop: 2 },

    backgroundNote: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 9,
      marginTop: 18,
      paddingHorizontal: 13,
      paddingVertical: 11,
      borderRadius: radius.control,
      backgroundColor: color.fill,
    },
    note: {
      flex: 1,
      fontFamily: body[400],
      fontSize: 12.5,
      lineHeight: 18.5,
      color: color.inkSoft,
    },
  });
