/**
 * Saying that something is happening.
 *
 * Two shapes, for two genuinely different waits:
 *
 * `<FullScreenBusy>` is the first launch. A teacher signing in on a new phone
 * waits while a term of students, groups, registers and marks comes down, and
 * until now the app showed them an empty roster the whole time — indistinguishable
 * from an account with nothing in it. Several people have concluded their data
 * was gone and started typing it in again.
 *
 * `busyWhile()` is everything else: an operation the teacher started, that
 * takes long enough to doubt, and that they must not interrupt halfway. It is
 * imperative for the same reason `showDialog` is — the code that knows how long
 * a spreadsheet import takes is a function in `lib`, not a component, and
 * threading a `busy` boolean up to a screen and back down would be a prop that
 * exists only to be forgotten at the next call site.
 *
 * ## What deliberately does not get one
 *
 * Adding a student. Saving a group. Marking a register. Those mint an id on the
 * device and queue the write to disk — they are done before the finger leaves
 * the screen, and there is no network in the path at all. A spinner there would
 * either flash for one frame or, worse, teach a teacher that saving needs
 * signal, which is the opposite of what this app is for.
 *
 * A progress indicator on something instant is not reassurance. It is a lie
 * about where the time goes.
 */
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, StyleSheet, Text, View } from 'react-native';

import { Logo } from '@/components/ui';
import { useT } from '@/i18n/useT';
import { radius, useTheme, useThemedStyles, type Theme } from '@/theme';
import { body, text } from '@/theme/type';

/* -------------------------------------------------------------------------- */
/* Imperative overlay                                                         */
/* -------------------------------------------------------------------------- */

type BusyRequest = { label: string; hint?: string } | null;

let present: ((request: BusyRequest) => void) | null = null;

/**
 * Run `work` behind a blocking overlay.
 *
 * Always clears, including when `work` throws — the overlay swallows touches,
 * so one that outlives its operation is an app the teacher has to force-quit.
 * The error is re-thrown so the caller still handles it; this only owns the
 * spinner.
 *
 * `update` lets long work say where it has got to ("42 of 130 students"), which
 * on a slow phone is the difference between waiting and giving up.
 */
export async function busyWhile<T>(
  label: string,
  work: (update: (label: string, hint?: string) => void) => Promise<T>,
  hint?: string,
): Promise<T> {
  present?.({ label, hint });
  try {
    return await work((next, nextHint) => present?.({ label: next, hint: nextHint }));
  } finally {
    present?.(null);
  }
}

/** Mounted once, at the root, beside `DialogHost`. */
export function BusyHost() {
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const [request, setRequest] = useState<BusyRequest>(null);

  useEffect(() => {
    present = setRequest;
    return () => {
      present = null;
    };
  }, []);

  return (
    <Modal visible={!!request} transparent animationType="fade" statusBarTranslucent>
      {/* `onRequestClose` is deliberately absent: Android's back button must
          not dismiss this. The work carries on either way, and a teacher who
          dismissed it would be left with no sign that an import was still
          rewriting their roster. */}
      <View style={styles.scrim}>
        <View style={styles.card}>
          <ActivityIndicator size="large" color={color.primary} />
          <Text style={styles.label}>{request?.label}</Text>
          {request?.hint ? <Text style={styles.hint}>{request.hint}</Text> : null}
        </View>
      </View>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* First launch                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The whole screen, while the account comes down for the first time.
 *
 * Branded rather than a bare spinner: this is the first thing a teacher sees
 * after signing in, and on a Turkmen connection they may be looking at it for a
 * while. It should read as the app working, not as the app stuck.
 */
export function FullScreenBusy({ label, hint }: { label?: string; hint?: string }) {
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const t = useT();

  return (
    <View style={styles.full}>
      <Logo size={64} />
      <ActivityIndicator size="large" color={color.primary} style={{ marginTop: 30 }} />
      <Text style={styles.fullLabel}>{label ?? t('sync.firstPull')}</Text>
      <Text style={styles.fullHint}>{hint ?? t('sync.firstPullHint')}</Text>
    </View>
  );
}

const makeStyles = ({ color, shadow }: Theme) =>
  StyleSheet.create({
    scrim: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: 'rgba(12,23,41,0.5)',
    },
    card: {
      minWidth: 200,
      maxWidth: '80%',
      alignItems: 'center',
      gap: 14,
      paddingHorizontal: 28,
      paddingVertical: 26,
      borderRadius: radius.lg,
      backgroundColor: color.surface,
      ...shadow.card,
    },
    label: { ...text.body, color: color.ink, textAlign: 'center' },
    hint: {
      fontFamily: body[400],
      fontSize: 12.5,
      lineHeight: 18,
      color: color.mutedLight,
      textAlign: 'center',
    },

    full: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: 40,
      backgroundColor: color.bg,
    },
    fullLabel: {
      ...text.body,
      color: color.ink,
      textAlign: 'center',
      marginTop: 22,
    },
    fullHint: {
      fontFamily: body[400],
      fontSize: 13,
      lineHeight: 19,
      color: color.mutedLight,
      textAlign: 'center',
      marginTop: 8,
    },
  });
