/**
 * The QR a teacher holds up in front of the class, and the phone that serves
 * the files behind it.
 *
 * This screen is the whole transfer. Opening it turns the teacher's phone into
 * a Wi-Fi access point and a file server; leaving it turns both off again. The
 * code on screen is not a link to anything — there is nothing on the far side
 * of it — it carries the assignment itself plus the network name, password,
 * port and token a student's phone needs to join and ask.
 *
 * ## Why the work happens here and not on the assignment screen
 *
 * Because the group only lives as long as this screen does, and the teacher
 * needs to see that. A phone quietly running an open access point after the
 * lesson ended is not something to leave to a stray `useEffect` somewhere else:
 * the thing that starts it is the thing on screen saying it is running, and the
 * back button is what stops it.
 *
 * ## The live count
 *
 * The teacher can see students arriving. That is not decoration — it is the
 * only feedback in the room that any of this worked. Without it a teacher holds
 * up a code and has no idea whether thirty phones got the worksheet or none
 * did, and has to ask.
 */
import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { Screen, TopBar } from '@/components/layout';
import { QrCode } from '@/components/QrCode';
import { Button, Card, EmptyState, Overline } from '@/components/ui';
import { useT } from '@/i18n/useT';
import { formatBytes } from '@/lib/attachments';
import { beamToken } from '@/lib/beam';
import {
  beamBlocker,
  BeamNotPermitted,
  BeamSettingOff,
  BeamTooBig,
  onBeamPeer,
  SETTINGS_INTENT,
  startBeam,
  stopBeam,
} from '@/lib/beamShare';
import { radius, space, useTheme, useThemedStyles, type Theme } from '@/theme';
import { body, text } from '@/theme/type';

type Arg = { uri: string; name: string; mime: string; size: number };

export default function HandoutScreen() {
  const t = useT();
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  const params = useLocalSearchParams<{
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

  const [payload, setPayload] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when the fix is a system switch, so the screen can offer the screen. */
  const [settingOff, setSettingOff] = useState<'wifiOff' | 'locationOff' | null>(null);
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

  /* ------------------------------------------------------- Start and stop */

  useFocusEffect(
    useCallback(() => {
      let cancelled = false;

      const run = async () => {
        setError(null);
        setSettingOff(null);
        setDetail(null);

        const blocker = beamBlocker();
        if (blocker) {
          if (blocker === 'wifiOff' || blocker === 'locationOff') setSettingOff(blocker);
          setError(t(`beam.${blocker}`));
          return;
        }
        try {
          const { payload: encoded } = await startBeam(assignment, files, token);
          // The teacher left while Android was bringing the group up. Take it
          // straight back down — the cleanup below already ran.
          if (cancelled) {
            void stopBeam();
            return;
          }
          setPayload(encoded);
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
        // Unconditional. Leaving this screen must take the access point down
        // whether it came up cleanly, failed halfway, or is still starting.
        void stopBeam();
      };
    }, [assignment, files, token, t, attempt]),
  );

  /* --------------------------------------------------- Students arriving */

  useEffect(
    () =>
      onBeamPeer((event) => {
        if (event.kind === 'started') setBusyPeers((n) => n + 1);
        else if (event.kind === 'done') {
          setBusyPeers((n) => Math.max(0, n - 1));
          setReceived(event.total);
        } else if (event.kind === 'failed' || event.kind === 'rejected') {
          setBusyPeers((n) => Math.max(0, n - 1));
        }
      }),
    [],
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

  return (
    <Screen>
      <TopBar title={t('beam.title')} dismiss />

      <ScrollView
        contentContainerStyle={{ padding: space.gutter, paddingBottom: insets.bottom + 32 }}
        showsVerticalScrollIndicator={false}>
        {/*
          The code first and large. Everything else here is for the teacher;
          this part is for a camera three metres away, and it gets the width of
          the screen because scannability is a function of how big each module
          lands on the sensor.
        */}
        <View style={styles.codeWrap}>
          {payload ? (
            <QrCode value={payload} size={300} />
          ) : (
            <View style={styles.starting}>
              <ActivityIndicator color={color.primary} />
              <Text style={styles.startingLabel}>{t('beam.starting')}</Text>
            </View>
          )}
        </View>

        <Text style={styles.scanHint}>{t('beam.scanHint')}</Text>

        {/*
          The only feedback in the room that any of this worked. A teacher
          holding up a code with no counter has to ask thirty people whether it
          arrived.
        */}
        {payload ? (
          <View style={styles.tally}>
            <Icon name="check" size={15} color={color.successDeep} />
            <Text style={styles.tallyLabel}>
              {t('beam.received', { count: received })}
              {busyPeers > 0 ? ` · ${t('beam.receiving', { count: busyPeers })}` : ''}
            </Text>
          </View>
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
          Said out loud, because "leave this screen open" is a requirement the
          teacher cannot guess and will otherwise break by tabbing away.
        */}
        <Text style={styles.note}>{t('beam.keepOpen')}</Text>
      </ScrollView>
    </Screen>
  );
}

const makeStyles = ({ color }: Theme) =>
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
    codeWrap: { alignItems: 'center', paddingVertical: 4, minHeight: 300, justifyContent: 'center' },
    starting: { alignItems: 'center', gap: 14 },
    startingLabel: { fontFamily: body[500], fontSize: 13, color: color.mutedLight },
    scanHint: {
      fontFamily: body[500],
      fontSize: 13,
      lineHeight: 19,
      color: color.mutedLight,
      textAlign: 'center',
      marginTop: 14,
    },

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

    note: {
      fontFamily: body[400],
      fontSize: 12,
      lineHeight: 18,
      color: color.mutedLight,
      marginTop: 16,
      textAlign: 'center',
    },
  });
