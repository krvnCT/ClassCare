// ClassCare — server-side message fan-out.
//
// Why this exists: neither iOS nor Android lets an app send an SMS without the
// user tapping send in the native composer. A "message all 11 students, each
// with their own name filled in" flow is therefore impossible on-device — it
// would open the composer eleven times. So the app posts the draft here, and
// this function renders it per recipient and calls the gateways.
//
// Deploy:  supabase functions deploy send-message
// Secrets: supabase secrets set RESEND_API_KEY=... RESEND_FROM=... \
//            RESEND_REPLY_TO=... ESKIZ_EMAIL=... ESKIZ_PASSWORD=... ESKIZ_SENDER=...
//          (SUPABASE_URL / _ANON_KEY / _SERVICE_ROLE_KEY are injected automatically)

import { createClient } from 'jsr:@supabase/supabase-js@2';

import { asLanguage, childNoun, fullDate } from '../_shared/messageVars.ts';

type Audience = 'students' | 'parents' | 'both';
type Channel = 'sms' | 'email' | 'push';

type Payload = {
  groupIds: string[];
  /** Optional narrowing — e.g. only today's absentees. */
  studentIds?: string[];
  audience: Audience;
  channels: Channel[];
  body: string;
  announcement?: boolean;
  /**
   * Storage paths inside the `attachments` bucket, never URLs.
   *
   * Deliberately not a URL: accepting one would let any signed-in caller point
   * Resend at an arbitrary host and have our sender fetch it. The path is
   * checked against this teacher's own folder below and signed here.
   */
  attachments?: { path: string; filename: string; mimeType: string; size: number }[];
  /** An assignment is a message with work attached, sent to students only. */
  isAssignment?: boolean;
};

/** What Resend is handed once the paths above have been signed. */
type ResolvedAttachment = { filename: string; path: string };

type Recipient = {
  studentId: string;
  kind: 'student' | 'parent';
  /**
   * The *student's* name, on a parent's copy as much as on their own.
   *
   * This used to be the parent's own name on a parent row, which meant one
   * draft said two different things depending on the channel: the device has
   * always put the student's name here, because "your daughter Aýgül" reads
   * correctly and "your daughter Maýa Berdiýewa" does not. The parent's name is
   * `{parent_name}`, which now exists.
   */
  name: string;
  phone: string | null;
  email: string | null;
  groupName: string;
  time: string;
  /** "your daughter" / "your son" / "your child", already in the right language. */
  gender: string;
  parentName: string;
  studentPhone: string;
  address: string;
  birthDate: string;
  /** Absences recorded for the course this message is about. */
  missedClasses: number;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...cors },
  });

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

/**
 * Substitute the placeholders the composer offers — all nine of them, plus the
 * two aliases a teacher writing in Turkmen reaches for.
 *
 * The same set and the same order as `renderBody` in `src/lib/messageVars.ts`,
 * which does this for SMS. They have to agree: one draft, two channels, and a
 * teacher who sends by both should not be sending two different messages.
 */
function render(template: string, r: Recipient) {
  return template
    .replaceAll('{name}', r.name)
    .replaceAll('{group}', r.groupName)
    .replaceAll('{time}', r.time)
    .replaceAll('{gender}', r.gender)
    .replaceAll('{parent_name}', r.parentName)
    .replaceAll('{phone}', r.studentPhone)
    .replaceAll('{address}', r.address)
    .replaceAll('{birthdate}', r.birthDate)
    .replaceAll('{missed_classes}', String(r.missedClasses))
    .replaceAll('{parent}', r.parentName)
    .replaceAll('{jynsy}', r.gender)
    .replaceAll('{jyns}', r.gender);
}

/** E.164-ish: Uzbek numbers are stored spaced, gateways want digits only. */
const normalizePhone = (p: string) => p.replace(/[^\d]/g, '');

/** Next occurrence of a weekly slot, for `{time}`. */
function nextSlotTime(slots: { weekday: number; starts_at: string }[], now: Date) {
  if (!slots.length) return '';
  const today = now.getDay();
  const sorted = [...slots].sort((a, b) => {
    const da = (a.weekday - today + 7) % 7;
    const db = (b.weekday - today + 7) % 7;
    return da - db || a.starts_at.localeCompare(b.starts_at);
  });
  return sorted[0].starts_at.slice(0, 5);
}

/* -------------------------------------------------------------------------- */
/* Gateways                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * SMS gateways.
 *
 * Which one is live is chosen by `SMS_PROVIDER`, because the right answer
 * depends on the country the teacher is in and that is not knowable here:
 *
 *  - `twilio`  — global. Covers Turkmenistan (+993, Altyn Asyr / TM CELL,
 *                >90% of the market). Most expensive per message.
 *  - `telnyx`  — global, usually cheaper than Twilio on the same routes.
 *  - `eskiz`   — Uzbekistan only. Far cheaper for +998 traffic, useless for
 *                anything else.
 *
 * Alphanumeric sender IDs do NOT survive to Turkmenistan: carriers there
 * overwrite them with a long code or a generic ID, so recipients see a number
 * rather than "ClassCare". Nothing to configure — just do not promise the
 * teacher a branded sender.
 */
type SmsProvider = 'twilio' | 'telnyx' | 'eskiz';
const smsProvider = () => (Deno.env.get('SMS_PROVIDER') ?? 'twilio') as SmsProvider;

/** E.164 for the gateways: digits with a leading `+`. */
/**
 * A number a gateway will accept.
 *
 * The old version tested `digits.startsWith('+')` after stripping every
 * non-digit, so the test could never be true and a bare national number came
 * out as `+65123456` — a plausible-looking address in another country
 * entirely. Turkmenistan is +993, national numbers are eight digits, and a
 * leading 8 is the domestic trunk prefix people still write.
 *
 * Kept in step with `src/lib/phone.ts` on the app side, which does the same
 * job for messages sent from the teacher's own SIM.
 */
const toE164 = (p: string) => {
  const trimmed = p.trim();
  const hadPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return '';

  if (hadPlus) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  if (digits.startsWith('993') && digits.length === 11) return `+${digits}`;
  if (digits.startsWith('8') && digits.length === 9) return `+993${digits.slice(1)}`;
  if (digits.length === 8) return `+993${digits}`;

  // Not a shape we recognise. Guessing a country code onto it would send
  // somebody's message to a stranger.
  return digits;
};

async function sendViaTwilio(phone: string, text: string) {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_FROM');
  if (!sid || !token || !from) throw new Error('Twilio is not configured');

  const form = new URLSearchParams({ To: toE164(phone), From: from, Body: text });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${sid}:${token}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? `Twilio failed: ${res.status}`);
  return String(body?.sid ?? '');
}

async function sendViaTelnyx(phone: string, text: string) {
  const key = Deno.env.get('TELNYX_API_KEY');
  const from = Deno.env.get('TELNYX_FROM');
  if (!key || !from) throw new Error('Telnyx is not configured');

  const res = await fetch('https://api.telnyx.com/v2/messages', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: toE164(phone), text }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.errors?.[0]?.detail ?? `Telnyx failed: ${res.status}`);
  return String(body?.data?.id ?? '');
}

let eskizToken: { value: string; expires: number } | null = null;

async function eskizAuth() {
  if (eskizToken && eskizToken.expires > Date.now()) return eskizToken.value;

  const form = new FormData();
  form.append('email', Deno.env.get('ESKIZ_EMAIL') ?? '');
  form.append('password', Deno.env.get('ESKIZ_PASSWORD') ?? '');

  const res = await fetch('https://notify.eskiz.uz/api/auth/login', {
    method: 'POST',
    body: form,
  });
  if (!res.ok) throw new Error(`Eskiz auth failed: ${res.status}`);

  const body = await res.json();
  const token = body?.data?.token as string;
  // Eskiz tokens last 30 days; refresh well inside that.
  eskizToken = { value: token, expires: Date.now() + 24 * 3600_000 };
  return token;
}

async function sendViaEskiz(phone: string, text: string) {
  const token = await eskizAuth();
  const form = new FormData();
  form.append('mobile_phone', normalizePhone(phone));
  form.append('message', text);
  form.append('from', Deno.env.get('ESKIZ_SENDER') ?? '4546');

  const res = await fetch('https://notify.eskiz.uz/api/message/sms/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.message ?? `SMS failed: ${res.status}`);
  return String(body?.id ?? '');
}

/**
 * Whether the selected gateway actually has credentials.
 *
 * Checked before anything is created, because the alternative is what used to
 * happen: a message row, thirty delivery rows, thirty identical
 * "Twilio is not configured" failures, and a teacher looking at 0 of 30 sent
 * with no idea that the problem is on the server and not with their class.
 */
function smsConfigured(): boolean {
  switch (smsProvider()) {
    case 'telnyx':
      return !!(Deno.env.get('TELNYX_API_KEY') && Deno.env.get('TELNYX_FROM'));
    case 'eskiz':
      return !!(Deno.env.get('ESKIZ_EMAIL') && Deno.env.get('ESKIZ_PASSWORD'));
    case 'twilio':
    default:
      return !!(
        Deno.env.get('TWILIO_ACCOUNT_SID') &&
        Deno.env.get('TWILIO_AUTH_TOKEN') &&
        Deno.env.get('TWILIO_FROM')
      );
  }
}

/** Route one message through whichever gateway is configured. */
function sendSms(phone: string, text: string) {
  switch (smsProvider()) {
    case 'telnyx':
      return sendViaTelnyx(phone, text);
    case 'eskiz':
      // Uzbekistan only. A +993 number handed to Eskiz will simply be rejected.
      return sendViaEskiz(phone, text);
    case 'twilio':
    default:
      return sendViaTwilio(phone, text);
  }
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/**
 * Render one notification as plain text and HTML.
 *
 * Written to reach the inbox rather than the promotions tab or spam. The rules
 * that actually move the needle, in rough order of weight:
 *
 *  - Authenticated domain (SPF + DKIM + DMARC on the sending domain).
 *  - A real `From` name and a working `Reply-To`. A parent replying to a school
 *    notification and hitting a black hole is both bad manners and a spam
 *    signal, because "never replied to" correlates with unwanted mail.
 *  - Both text/plain and text/html parts. HTML-only is a classic spam shape.
 *  - `List-Unsubscribe`, which Gmail and Yahoo have required of bulk senders
 *    since February 2024.
 *  - A specific subject naming the class. No ALL CAPS, no "!!!", no "FREE",
 *    no emoji in the subject line.
 *  - Plain, letter-like HTML: no images, no tracking pixel, no link shorteners,
 *    no giant CTA button. This looks like a person wrote it, because one did.
 *  - Say who is writing and why this address is receiving it.
 */
function renderEmail(opts: {
  body: string;
  teacherName: string;
  groupName: string;
  isAnnouncement: boolean;
  recipientKind: 'student' | 'parent';
}) {
  const { body, teacherName, groupName, isAnnouncement, recipientKind } = opts;

  const subject = isAnnouncement
    ? `Announcement from ${teacherName}`
    : `${groupName} — note from ${teacherName}`;

  const why =
    recipientKind === 'parent'
      ? `You are receiving this because you are listed as the parent or guardian contact for a student in ${groupName}.`
      : `You are receiving this because you are enrolled in ${groupName}.`;

  const signoff = `${teacherName}\n${isAnnouncement ? 'ClassCare' : groupName}`;

  const text = [body.trim(), '', '—', signoff, '', why, 'To stop these, reply STOP.'].join('\n');

  // Inline styles only, and a table-free single column: Gmail strips <style>
  // blocks, and anything resembling a marketing layout invites the promotions
  // tab. System font stack so nothing is fetched from a remote host.
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f4f7fb;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e1e7f0;border-radius:14px;padding:28px 26px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0c1729;font-size:15px;line-height:1.6;">
<p style="margin:0 0 18px;white-space:pre-wrap;">${escapeHtml(body.trim())}</p>
<p style="margin:0 0 4px;color:#47566e;">—</p>
<p style="margin:0;font-weight:600;">${escapeHtml(teacherName)}</p>
<p style="margin:2px 0 0;color:#6b7a94;font-size:13.5px;">${escapeHtml(isAnnouncement ? 'ClassCare' : groupName)}</p>
<hr style="border:none;border-top:1px solid #e1e7f0;margin:22px 0 14px;">
<p style="margin:0;color:#8494ac;font-size:12px;line-height:1.5;">${escapeHtml(why)} Reply to this email to reach ${escapeHtml(teacherName)} directly, or reply STOP to be removed.</p>
</div></body></html>`;

  return { subject, text, html };
}

/**
 * The address a reply should come back to.
 *
 * With `RESEND_INBOUND_DOMAIN` set, every message gets its own address carrying
 * the delivery id. That token is what makes routing exact: the `inbound-email`
 * function reads it and knows the teacher, the student, and whether it was the
 * student or the guardian who wrote back. Matching on the From address instead
 * would break the moment a parent replies from a different account, or is on
 * two teachers' rosters.
 *
 * Unset, this returns undefined and the caller falls back to the teacher's own
 * mailbox — which is what shipped before inbound existed, and still works.
 */
function replyAddressFor(deliveryId: string) {
  const domain = Deno.env.get('RESEND_INBOUND_DOMAIN');
  return domain ? `reply-${deliveryId}@${domain}` : undefined;
}

/**
 * Turn a Resend rejection into something worth showing a teacher.
 *
 * Resend's own wording used to go straight through, which is how a revoked key
 * reached a teacher's screen as "API key is invalid" — a sentence that tells
 * them nothing they can act on, blames a component they have never heard of,
 * and describes how the backend is wired to anyone holding the phone.
 *
 * The real cause still needs to reach whoever can fix it, so it is logged.
 */
function resendFailure(status: number, body: { message?: string; name?: string }): string {
  const detail = body?.message ?? `HTTP ${status}`;

  if (status === 401 || status === 403) {
    console.error('[classcare] Resend rejected the credential:', detail);
    return 'Email is not set up on the server right now. Nothing was sent — please try again later.';
  }

  if (status === 429) {
    console.warn('[classcare] Resend rate limit:', detail);
    return 'Too many emails at once. Wait a moment and send the rest.';
  }

  // 4xx below this point is usually a bad address, which the teacher *can* act
  // on, so the specific reason is worth passing through. 5xx is Resend's.
  if (status >= 500) {
    console.error('[classcare] Resend server error:', detail);
    return 'The mail service is having trouble. Nothing was sent — try again shortly.';
  }

  console.warn('[classcare] Resend refused a message:', detail);
  return detail;
}

type EmailOptions = {
  to: string;
  subject: string;
  text: string;
  html: string;
  replyTo?: string;
  /** Kept off the tokenised address: an unsubscribe belongs with a human. */
  unsubscribeTo?: string;
  /** Signed URLs Resend fetches for itself — see `Payload.attachments`. */
  attachments?: ResolvedAttachment[];
};

/**
 * Resend allows two requests a second per account unless asked for more.
 *
 * Every email used to be sent at once, in one `Promise.all`. For a class of
 * thirty that was mostly fine; for four hundred students picked by a filter it
 * was eight hundred requests in the same instant, and nearly all of them came
 * back 429. Requests are spaced instead, and mail without files goes a hundred
 * to a request through the batch endpoint — see `sendEmailBatch`.
 */
const RESEND_SPACING_MS = 550;
let lastResendCall = 0;

async function paceResend() {
  const wait = lastResendCall + RESEND_SPACING_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastResendCall = Date.now();
}

/** POST to Resend, spaced, retrying once on a rate limit. */
async function resendPost(path: string, payload: unknown) {
  for (let attempt = 0; ; attempt += 1) {
    await paceResend();
    const res = await fetch(`https://api.resend.com${path}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 429 && attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      continue;
    }
    return { res, body };
  }
}

/** One email as Resend wants it. Shared by the single and the batch send. */
function emailPayload(opts: EmailOptions) {
  // Deliberately no fallback to `onboarding@resend.dev`. That sandbox sender
  // exists to let you prove your API key works, and Resend refuses every
  // recipient except the account owner's own address — so falling back to it
  // means each student's message is rejected 403 while the send still looks
  // healthy from the app. Better to fail with the reason.
  const from = Deno.env.get('RESEND_FROM');
  if (!from) {
    throw new Error(
      'RESEND_FROM is not set, so email can only reach the Resend account owner. ' +
        'Run: supabase secrets set RESEND_FROM="ClassCare <notifications@yourdomain>"',
    );
  }
  if (!Deno.env.get('RESEND_API_KEY')) throw new Error('RESEND_API_KEY is not set');
  // Prefer a real mailbox the teacher reads. Falling back to the From address
  // is still better than no Reply-To at all.
  const replyTo = opts.replyTo || Deno.env.get('RESEND_REPLY_TO') || undefined;
  const unsubscribeMailbox =
    Deno.env.get('RESEND_UNSUBSCRIBE') ||
    opts.unsubscribeTo ||
    Deno.env.get('RESEND_REPLY_TO') ||
    from.replace(/^.*<|>$/g, '');

  return {
    from,
    to: opts.to,
    subject: opts.subject,
    text: opts.text,
    html: opts.html,
    ...(replyTo ? { reply_to: replyTo } : {}),
    ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
    headers: {
      // Required of bulk senders by Gmail and Yahoo. `mailto:` alone is a
      // valid List-Unsubscribe; one-click (RFC 8058) additionally needs an
      // HTTPS endpoint, which is worth adding once volume justifies it.
      'List-Unsubscribe': `<mailto:${unsubscribeMailbox}?subject=unsubscribe>`,
      // Transactional class: tells filters this is not marketing.
      'X-Entity-Ref-ID': crypto.randomUUID(),
    },
  };
}

async function sendEmail(opts: EmailOptions) {
  const { res, body } = await resendPost('/emails', emailPayload(opts));
  if (!res.ok) throw new Error(resendFailure(res.status, body));
  return String(body?.id ?? '');
}

/**
 * Up to a hundred emails in one request, ids back in the same order.
 *
 * Resend's batch endpoint takes everything but attachments, so mail with files
 * goes one at a time through `sendEmail`. A batch is refused whole when any one
 * address in it is bad; the caller then sends that batch's emails singly, so
 * the bad address fails on its own and the rest still go.
 */
async function sendEmailBatch(list: EmailOptions[]): Promise<string[]> {
  const { res, body } = await resendPost('/emails/batch', list.map(emailPayload));
  if (!res.ok) throw new Error(resendFailure(res.status, body));
  const data = (body?.data ?? []) as { id?: string }[];
  return list.map((_, i) => String(data[i]?.id ?? ''));
}

/** Ids per `in.(…)` filter — the list travels in the URL. */
const ID_CHUNK = 100;

function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Run `task` over `items`, at most `limit` at a time. */
async function eachLimited<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await task(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

  const url = Deno.env.get('SUPABASE_URL')!;

  // Identify the caller with *their* token so RLS applies to the identity check.
  const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData } = await asUser.auth.getUser();
  const teacherId = userData.user?.id;
  if (!teacherId) return json({ error: 'Not signed in' }, 401);

  // Everything after this point is scoped manually to `teacherId`. The secret
  // key bypasses RLS, so every query below filters on it explicitly.
  // `SUPABASE_SERVICE_ROLE_KEY` is injected into every Edge Function by the
  // platform. The `SUPABASE_` prefix is reserved, so a custom
  // `SUPABASE_SECRET_KEY` can never be set and would always read undefined —
  // which `createClient` rejects with "supabaseKey is required".
  const serviceKey =
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SUPABASE_SECRET_KEY');
  if (!serviceKey) return json({ error: 'Server missing its service role key' }, 500);
  const db = createClient(url, serviceKey);

  // Mail signed by a named person clears filters far better than "your teacher",
  // and gives the parent someone to reply to.
  const { data: teacherRow } = await db
    .from('teachers')
    .select('name, email, language')
    .eq('id', teacherId)
    .single();
  const teacherName = (teacherRow?.name ?? '').trim() || 'Your teacher';
  const teacherEmail = teacherRow?.email ?? undefined;
  // The gendered noun and the month names are words, so they are written in
  // whichever language the teacher is composing in.
  const language = asLanguage(teacherRow?.language);

  let payload: Payload;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  const { audience, channels, body: template, announcement } = payload;
  if (!template?.trim()) return json({ error: 'Message body is empty' }, 400);
  if (!channels?.length) return json({ error: 'Pick at least one channel' }, 400);

  /* ---------------------------------------------------------------------- *
   * Attachments.
   *
   * The caller sends storage paths; the signing happens here, with the
   * service key, after checking each path belongs to this teacher. That check
   * is the whole security boundary: without it a signed-in teacher could name
   * another teacher's path and have the file mailed to their own class.
   *
   * Signed once and reused for every recipient — a class of thirty is thirty
   * emails pointing at one URL, not thirty signatures.
   * ---------------------------------------------------------------------- */
  const requested = payload.attachments ?? [];
  if (requested.length > 5) return json({ error: 'At most 5 files per message' }, 400);

  const attachments: ResolvedAttachment[] = [];
  for (const item of requested) {
    const path = String(item?.path ?? '');
    // `..` would climb out of the folder that the prefix check just granted.
    if (!path.startsWith(`${teacherId}/`) || path.includes('..')) {
      return json({ error: 'An attachment path is not yours' }, 403);
    }
    const { data: signed, error: signError } = await db.storage
      .from('attachments')
      .createSignedUrl(path, 60 * 60 * 6);
    if (signError || !signed?.signedUrl) {
      return json({ error: `Could not read attachment: ${item?.filename ?? path}` }, 400);
    }
    attachments.push({ filename: String(item?.filename ?? 'file'), path: signed.signedUrl });
  }

  // SMS carries text and nothing else. Saying so up front beats a teacher
  // discovering it from a student who never got the homework.
  if (attachments.length && !channels.includes('email')) {
    return json({ error: 'Files can only be sent by email. Tick the email channel.' }, 400);
  }

  // No gateway credentials means every SMS delivery would fail identically.
  // Refuse the whole send rather than half-completing it: the `code` lets the
  // app say this in the teacher's own language, and point at the setting that
  // sends from their own SIM instead.
  if (channels.includes('sms') && !smsConfigured()) {
    return json(
      {
        code: 'sms_not_configured',
        error:
          `No SMS gateway is set up on the server (SMS_PROVIDER=${smsProvider()}). ` +
          'Send SMS from the phone instead, or set the provider credentials with ' +
          '`supabase secrets set`.',
      },
      400,
    );
  }

  /*
    Who it goes to.

    Normally the students of the chosen groups — an announcement meaning every
    active group — narrowed by `studentIds` when the caller passes them.

    When the caller names the students outright, those students are the list.
    That is how the students tab sends to whoever its filters left on screen:
    four hundred people across fifteen classes, some in a finished term, some
    in no class at all. Reaching them through their groups dropped everyone in
    a class that was not ticked, in an archived one, or in none. The groups
    sent alongside are then only the context `{group}` and `{time}` are filled
    from, archived ones included, and may be empty.
  */
  const explicit = !announcement && payload.studentIds?.length
    ? [...new Set(payload.studentIds)]
    : null;

  type GroupRow = {
    id: string;
    name: string;
    group_slots: { weekday: number; starts_at: string }[];
  };
  const groups: GroupRow[] = [];
  if (announcement) {
    const { data, error } = await db
      .from('groups')
      .select('id, name, group_slots(weekday, starts_at)')
      .eq('teacher_id', teacherId)
      .is('archived_at', null);
    if (error) return json({ error: error.message }, 400);
    groups.push(...((data ?? []) as GroupRow[]));
  } else {
    for (const ids of chunked([...new Set(payload.groupIds ?? [])], ID_CHUNK)) {
      let q = db
        .from('groups')
        .select('id, name, group_slots(weekday, starts_at)')
        .eq('teacher_id', teacherId)
        .in('id', ids);
      if (!explicit) q = q.is('archived_at', null);
      const { data, error } = await q;
      if (error) return json({ error: error.message }, 400);
      groups.push(...((data ?? []) as GroupRow[]));
    }
  }
  if (!groups.length && !explicit) {
    // Distinguishing these matters, because the second one is not something the
    // teacher did wrong. Writes are mirrored to Supabase in the background and
    // a failure there is currently only logged (see `enqueue` in data/sync.ts),
    // so a group created while the connection was down exists on the device and
    // nowhere else. The app then sends an id the server has never seen.
    return json(
      {
        error: announcement
          ? 'You have no active groups to announce to.'
          : (payload.groupIds?.length ?? 0) === 0
            ? 'No group was included in the send.'
            : 'That group does not exist on the server. It was most likely created while ' +
              'the connection was down and never synced. Restart the app to refresh from ' +
              'the server, then recreate it if it is gone.',
      },
      400,
    );
  }

  const groupIds = groups.map((g) => g.id);

  // In chunks: each `in.(…)` list is part of the URL, and a filter of a few
  // hundred ids is past what the gateway will read.
  const links: { student_id: string; group_id: string }[] = [];
  for (const ids of chunked(groupIds, ID_CHUNK)) {
    const { data, error } = await db
      .from('student_groups')
      .select('student_id, group_id')
      .eq('teacher_id', teacherId)
      .in('group_id', ids);
    if (error) return json({ error: error.message }, 400);
    links.push(...(data ?? []));
  }

  let studentIds = explicit ?? [...new Set(links.map((l) => l.student_id))];
  if (!explicit && payload.studentIds?.length) {
    const allow = new Set(payload.studentIds);
    studentIds = studentIds.filter((id) => allow.has(id));
  }
  if (!studentIds.length) return json({ error: 'No recipients' }, 400);

  type StudentRow = {
    id: string;
    name: string;
    surname: string | null;
    gender: string | null;
    phone: string;
    email: string | null;
    address: string | null;
    birth_date: string | null;
    parent_name: string | null;
    parent_phone: string | null;
    parent_email: string | null;
  };
  const students: StudentRow[] = [];
  for (const ids of chunked(studentIds, ID_CHUNK)) {
    const { data, error } = await db
      .from('students')
      .select(
        'id, name, surname, gender, phone, email, address, birth_date, ' +
          'parent_name, parent_phone, parent_email',
      )
      .eq('teacher_id', teacherId)
      .in('id', ids)
      .is('archived_at', null);
    if (error) return json({ error: error.message }, 400);
    students.push(...((data ?? []) as unknown as StudentRow[]));
  }
  if (!students.length) return json({ error: 'No recipients' }, 400);
  // Only the students actually found — archived ones and foreign ids are gone.
  studentIds = students.map((s) => s.id);

  const now = new Date();
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const groupOfStudent = new Map<string, string>();
  for (const l of links ?? [])
    if (!groupOfStudent.has(l.student_id)) groupOfStudent.set(l.student_id, l.group_id);

  /*
    Absences for `{missed_classes}`, counted against the same course
    `{group}` and `{time}` name — not every group the student is in.

    One query for the whole batch rather than one per student: a class of
    thirty is thirty avoidable round trips otherwise. Failure here is not
    failure to send — a class reminder does not need this number to be right,
    and a teacher waiting on a send should not lose the whole thing because a
    supplementary count could not be read. Missing counts default to zero,
    the same as the device does for a student who has no attendance rows yet.
  */
  const missedByStudent = new Map<string, number>();
  // Fifty students a query: two id lists share this URL, and a response stops
  // at a thousand rows, which fifty students' absences stay well under.
  for (const ids of groupIds.length ? chunked(studentIds, 50) : []) {
    const { data: absenceRows, error: absenceError } = await db
      .from('attendance')
      .select('student_id, group_id')
      .eq('teacher_id', teacherId)
      .eq('status', 'absent')
      .in('student_id', ids)
      .in('group_id', groupIds);
    if (absenceError) {
      console.error('attendance lookup for {missed_classes} failed:', absenceError.message);
      break;
    }
    for (const row of absenceRows ?? []) {
      if (row.group_id !== groupOfStudent.get(row.student_id)) continue;
      missedByStudent.set(row.student_id, (missedByStudent.get(row.student_id) ?? 0) + 1);
    }
  }

  // Build the recipient list. "Both" produces two rows for the same student —
  // one to them, one to their guardian — each rendered with its own name.
  const recipients: Recipient[] = [];
  for (const s of students ?? []) {
    const g = groupById.get(groupOfStudent.get(s.id) ?? '');
    const groupName = g?.name ?? '';
    const time = nextSlotTime(g?.group_slots ?? [], now);

    // Everything that is about the student rather than about who is being
    // written to, so both rows below carry the same values.
    const about = {
      name: s.name,
      groupName,
      time,
      gender: childNoun(s, language),
      parentName: (s.parent_name ?? '').trim(),
      studentPhone: (s.phone ?? '').trim(),
      address: (s.address ?? '').trim(),
      birthDate: fullDate(s.birth_date, language),
      missedClasses: missedByStudent.get(s.id) ?? 0,
    };

    if (audience === 'students' || audience === 'both') {
      recipients.push({
        studentId: s.id,
        kind: 'student',
        phone: s.phone,
        email: s.email,
        ...about,
      });
    }
    // A guardian counts as reachable if we hold any way to reach them. Keying
    // this on `parent_phone` alone used to drop every parent who had only an
    // email address on file.
    if (
      (audience === 'parents' || audience === 'both') &&
      (s.parent_phone || s.parent_email || s.parent_name)
    ) {
      recipients.push({
        studentId: s.id,
        kind: 'parent',
        phone: s.parent_phone,
        email: s.parent_email,
        ...about,
      });
    }
  }

  // Dispatch works from delivery rows, which carry only ids; keep a lookup so
  // each email can name the right class.
  const byStudent = new Map(recipients.map((r) => [`${r.studentId}:${r.kind}`, r]));

  // Work out what can actually be delivered *before* recording the message.
  // A recipient with no address for the chosen channel is not an error, but it
  // is not a delivery either, and a send where that empties the whole list must
  // not be reported as success — that is exactly how a class ends up never
  // hearing about a cancelled lesson.
  const skipped: Record<Channel, number> = { sms: 0, email: 0, push: 0 };
  const plan = recipients.flatMap((r) =>
    channels
      .map((channel) => {
        const destination = channel === 'email' ? r.email : r.phone;
        if (!destination) {
          skipped[channel] += 1;
          return null;
        }
        return { recipient: r, channel, destination };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null),
  );

  if (!plan.length) {
    const missing = channels
      .filter((c) => skipped[c] > 0)
      .map((c) => (c === 'email' ? 'an email address' : 'a phone number'));
    return json(
      {
        error:
          `None of the ${recipients.length} selected recipients have ` +
          `${missing.join(' or ') || 'contact details'} on file, so nothing could be sent. ` +
          `Add the missing details on each student, or pick another channel.`,
      },
      400,
    );
  }

  const { data: message, error: messageError } = await db
    .from('messages')
    .insert({
      teacher_id: teacherId,
      body: template,
      audience,
      channels,
      announcement: !!announcement,
      is_assignment: !!payload.isAssignment,
    })
    .select()
    .single();
  if (messageError) return json({ error: messageError.message }, 400);

  if (requested.length) {
    // Recorded so the log can say what went out. A failure here must not fail
    // the send — the files are already uploaded and the message is going.
    const { error: attachError } = await db.from('message_attachments').insert(
      requested.map((a) => ({
        message_id: message.id,
        teacher_id: teacherId,
        storage_path: a.path,
        filename: a.filename,
        mime_type: a.mimeType || 'application/octet-stream',
        size_bytes: Number.isFinite(a.size) ? a.size : 0,
      })),
    );
    if (attachError) console.warn('could not record attachments:', attachError.message);
  }

  // A send to students picked by a filter may name no group at all.
  if (!announcement && groupIds.length) {
    await db
      .from('message_groups')
      .insert(groupIds.map((group_id) => ({ message_id: message.id, group_id })));
  }

  // Queue every delivery before dispatching, so a gateway outage leaves an
  // accurate record of what was meant to go out rather than silence.
  const queued = plan.map(({ recipient, channel, destination }) => ({
    message_id: message.id,
    teacher_id: teacherId,
    student_id: recipient.studentId,
    recipient: recipient.kind,
    channel,
    destination,
    rendered: render(template, recipient),
    state: 'queued' as const,
  }));

  // In chunks, so a send to hundreds is several inserts rather than one body
  // the size of the whole class list — and each answer stays under the row
  // limit a response is cut off at.
  type DeliveryRow = {
    id: string;
    student_id: string;
    recipient: string;
    channel: Channel;
    destination: string;
    rendered: string;
  };
  const deliveries: DeliveryRow[] = [];
  for (const chunk of chunked(queued, 500)) {
    const { data, error: deliveryError } = await db
      .from('message_deliveries')
      .insert(chunk)
      .select('id, student_id, recipient, channel, destination, rendered');
    if (deliveryError) return json({ error: deliveryError.message }, 400);
    deliveries.push(...((data ?? []) as DeliveryRow[]));
  }

  // Dispatch. Failures are recorded per row — one bad number must not sink the
  // whole send. They are also counted, because a delivery that failed silently
  // in a table the app never reads is indistinguishable from one that worked.
  let sent = 0;
  let failed = 0;
  const errors = new Set<string>();

  const markSent = async (d: DeliveryRow, providerId: string) => {
    await db
      .from('message_deliveries')
      .update({ state: 'sent', provider_id: providerId, updated_at: new Date().toISOString() })
      .eq('id', d.id);
    sent += 1;
  };
  const markFailed = async (d: DeliveryRow, e: unknown) => {
    const reason = e instanceof Error ? e.message : String(e);
    failed += 1;
    errors.add(reason);
    await db
      .from('message_deliveries')
      .update({ state: 'failed', error: reason, updated_at: new Date().toISOString() })
      .eq('id', d.id);
  };

  const emailFor = (d: DeliveryRow): EmailOptions => {
    const r = byStudent.get(`${d.student_id}:${d.recipient}`);
    const { subject, text, html } = renderEmail({
      body: d.rendered,
      teacherName,
      groupName: r?.groupName ?? 'your class',
      isAnnouncement: !!message.announcement,
      recipientKind: d.recipient as 'student' | 'parent',
    });
    return {
      to: d.destination,
      subject,
      text,
      html,
      // The tokenised address when inbound is configured, otherwise
      // straight to the teacher exactly as before.
      replyTo: replyAddressFor(d.id) ?? teacherEmail,
      unsubscribeTo: teacherEmail,
      attachments,
    };
  };

  const sms = deliveries.filter((d) => d.channel === 'sms');
  const email = deliveries.filter((d) => d.channel === 'email');

  // Ten at a time: the gateway call and the row update for each, without
  // opening hundreds of connections at once.
  await eachLimited(sms, 10, async (d) => {
    try {
      await markSent(d, await sendSms(d.destination, d.rendered));
    } catch (e) {
      await markFailed(d, e);
    }
  });

  /*
    Email a hundred to a request where it can be, one at a time where it must.

    The batch endpoint takes no attachments, so a message with files is sent
    singly — spaced to Resend's rate either way. A batch Resend refuses (one
    malformed address fails all hundred) is retried singly too, so only that
    address fails.
  */
  const sendSingly = async (list: DeliveryRow[]) => {
    for (const d of list) {
      try {
        await markSent(d, await sendEmail(emailFor(d)));
      } catch (e) {
        await markFailed(d, e);
      }
    }
  };

  if (attachments.length) {
    await sendSingly(email);
  } else {
    for (const chunk of chunked(email, 100)) {
      let ids: string[] | null = null;
      try {
        ids = await sendEmailBatch(chunk.map(emailFor));
      } catch (e) {
        console.warn('[classcare] batch refused, sending singly:', e);
      }
      if (ids) {
        const providerIds = ids;
        await eachLimited(
          chunk.map((d, i) => ({ d, id: providerIds[i] })),
          10,
          ({ d, id }) => markSent(d, id),
        );
      } else {
        await sendSingly(chunk);
      }
    }
  }

  // Push goes to devices, which ClassCare only has for the teacher today —
  // a student-facing app is explicitly out of scope, so this is a no-op until
  // guardians opt into the web push channel.
  // No push branch here any more. ClassCare is the teacher's app; students and
  // parents never install it, so there has never been a device to push to. The
  // old code called a stub with an empty token list and then marked the rows
  // 'sent', which reported delivery to nobody. The composer no longer offers
  // the channel either.

  return json({
    messageId: message.id,
    queued: queued.length,
    sent,
    failed,
    skipped,
    errors: [...errors],
  });
});
