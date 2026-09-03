/**
 * The QR a teacher holds up in front of the class.
 *
 * Reached from the assignment screen once the files are uploaded and signed.
 * The whole handout — the title, the instructions, a link per file — is inside
 * the code itself, so this screen holds no state and needs no network: it is
 * handed the encoded string as a route parameter and draws it.
 *
 * That also means it can be reached again later with the same parameter and
 * will produce exactly the same code, which matters more than it sounds. A
 * teacher who dismissed this by accident, or whose class was still getting
 * their cameras out, can come back to the identical handout rather than
 * re-uploading and re-signing.
 */
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Share, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Icon } from '@/components/Icon';
import { Screen, TopBar } from '@/components/layout';
import { QrCode } from '@/components/QrCode';
import { Button, Card, EmptyState, Overline } from '@/components/ui';
import { useT } from '@/i18n/useT';
import { decodeHandout, HANDOUT_URL } from '@/lib/handout';
import { formatBytes } from '@/lib/attachments';
import { LINK_DAYS } from '@/lib/handoutShare';
import { radius, space, useTheme, useThemedStyles, type Theme } from '@/theme';
import { body, text } from '@/theme/type';

export default function HandoutScreen() {
  const t = useT();
  const router = useRouter();
  const { color } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const insets = useSafeAreaInsets();

  const { data } = useLocalSearchParams<{ data?: string }>();
  const handout = data ? decodeHandout(data) : null;

  if (!handout) {
    return (
      <Screen>
        <TopBar title={t('handout.title')} dismiss />
        <EmptyState title={t('handout.tooBig')} hint={t('handout.needSomething')} />
      </Screen>
    );
  }

  const link = `${HANDOUT_URL}#${data}`;

  return (
    <Screen>
      <TopBar title={t('handout.title')} dismiss />

      <ScrollView
        contentContainerStyle={{
          padding: space.gutter,
          paddingBottom: insets.bottom + 32,
        }}
        showsVerticalScrollIndicator={false}>
        {/*
          The code first and large. Everything else on this screen is for the
          teacher; this part is for a camera three metres away, and it gets the
          width of the screen because scannability is a function of how big each
          module lands on the sensor.
        */}
        <View style={styles.codeWrap}>
          <QrCode value={link} size={300} />
        </View>

        <Text style={styles.scanHint}>{t('handout.scanHint')}</Text>

        <Card style={styles.details}>
          <Text style={styles.title}>{handout.t}</Text>
          {handout.w ? (
            <Text style={styles.from}>{t('handout.from', { name: handout.w })}</Text>
          ) : null}
          {handout.b ? <Text style={styles.instructions}>{handout.b}</Text> : null}
        </Card>

        <Overline style={styles.label}>{t('handout.files')}</Overline>
        {handout.f.length ? (
          <Card style={styles.fileList}>
            {handout.f.map((file, i) => (
              <View key={`${file.n}-${i}`} style={styles.fileRow}>
                <View style={[styles.fileGlyph, { backgroundColor: color.primaryTint }]}>
                  <Icon name="paperclip" size={15} color={color.primary} />
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.fileName} numberOfLines={1}>
                    {file.n}
                  </Text>
                  <Text style={styles.fileMeta}>{formatBytes(file.s)}</Text>
                </View>
              </View>
            ))}
          </Card>
        ) : (
          <Card style={styles.emptyFiles}>
            <Text style={styles.fileMeta}>{t('handout.noFiles')}</Text>
          </Card>
        )}

        {/*
          Said out loud, because the two halves of a handout expire differently
          and a teacher who does not know that will be surprised in a week.
        */}
        {handout.f.length ? (
          <Text style={styles.expiry}>{t('handout.expires', { days: LINK_DAYS })}</Text>
        ) : null}

        {/*
          For the student whose camera will not focus, or who is not in the
          room. The same link, through whatever the phone can send.
        */}
        <Button
          label={t('handout.shareLink')}
          icon="send"
          variant="outline"
          style={{ marginTop: 18 }}
          onPress={() => void Share.share({ message: link })}
        />
      </ScrollView>
    </Screen>
  );
}

const makeStyles = ({ color }: Theme) =>
  StyleSheet.create({
    codeWrap: { alignItems: 'center', paddingVertical: 4 },
    scanHint: {
      fontFamily: body[500],
      fontSize: 13,
      lineHeight: 19,
      color: color.mutedLight,
      textAlign: 'center',
      marginTop: 14,
      marginBottom: 20,
    },

    details: { padding: 16, marginBottom: 22 },
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

    expiry: {
      fontFamily: body[400],
      fontSize: 12,
      lineHeight: 18,
      color: color.mutedLight,
      marginTop: 14,
    },
  });
