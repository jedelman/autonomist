// newsletter.js: the daily digest by email, through Resend (Jason, 2026-11-25: "Let's also use Resend to make this a
// newsletter").
//
// - Off unless RESEND_API_KEY (a secret), RESEND_SEGMENT_ID and NEWSLETTER_FROM are set: the sign-up page says it
//   isn't open, and nothing is sent.
// - Sign-up is double opt-in. The form sends an address; one email goes to it with a link; only pressing Confirm on
//   the page that link opens adds the address to Resend's segment. The token is in the link's #fragment, which never
//   reaches a server, and confirming takes a press, so a mail scanner that fetches the link confirms nothing.
// - Addresses are private. They live in Resend, never in autonomist's repository or any public record, and never
//   reach the model. A pending confirmation is kept in KV under a hash of its token, for two days.
// - Abuse is bounded: a honeypot field, sign-ups per visitor per day (a salted hash of the network address), one
//   confirmation per address per day, and confirmation emails per day for the whole site.
// - One broadcast per published digest. A draft is created and its id kept; its status is read before it's sent, so
//   a run cut short never sends the digest twice (Resend's idempotency keys don't cover broadcasts).
// - Unsubscribing is Resend's: every digest carries its unsubscribe link ({{{RESEND_UNSUBSCRIBE_URL}}}).
import { esc, render } from '../site/js/md.js'
import { networkHtml, checkedHtml } from './journal-pages.js'
import { normalizeEmail, sha256hex } from './invites.js'
import { setting } from './limits.js'

const API = 'https://api.resend.com'
const ORIGIN = 'https://autonomist.jason-edelman.org'
const UNSUBSCRIBE = '{{{RESEND_UNSUBSCRIBE_URL}}}'
const PE = 'https://power-explained.jason-edelman.org'

export const newsletterReady = (env) => Boolean(env.RESEND_API_KEY && env.RESEND_SEGMENT_ID && env.NEWSLETTER_FROM && env.KV)
const originOf = (env) => (env.PUBLIC_ORIGIN || ORIGIN).replace(/\/$/, '')

/** One call to Resend's API: { ok, status, data }. Resend refuses a request without a User-Agent. */
export async function resend(env, method, path, body, { fetch: f = fetch, idempotencyKey } = {}) {
  const headers = { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'User-Agent': 'autonomist/1.0' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey
  const res = await f(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  let data = null
  try { data = await res.json() } catch { /* an empty or non-JSON body */ }
  return { ok: res.ok, status: res.status, data }
}
const fail = (what, r) => new Error(`${what}: Resend ${r.status}${r.data?.name ? ` ${r.data.name}` : ''}${r.data?.message ? `: ${String(r.data.message).slice(0, 200)}` : ''}`)

// ---------------------------------------------------------------------------------------------------------------
// The email, from a digest's record

// Email clients drop stylesheets, so the digest's HTML gets its styles inline, tag by tag. The input is always this
// module's own escaped markup (md.js and journal-pages.js), so a tag's attributes never hold a raw ">".
const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"
const STYLE = {
  h1: `font-family:${FONT};font-size:26px;line-height:1.25;margin:8px 0 6px;color:#1d1d1b`,
  h2: `font-family:${FONT};font-size:19px;line-height:1.3;margin:28px 0 8px;color:#1d1d1b`,
  h3: `font-family:${FONT};font-size:16px;line-height:1.3;margin:20px 0 6px;color:#1d1d1b`,
  p: 'margin:0 0 14px',
  ul: 'margin:0 0 14px;padding-left:22px',
  ol: 'margin:0 0 14px;padding-left:22px',
  li: 'margin:0 0 6px',
  blockquote: 'margin:0 0 14px;padding:2px 0 2px 14px;border-left:3px solid #c9c4b8;color:#4a4842',
  a: 'color:#1f5f8b;text-decoration:underline',
  code: "font-family:Menlo,Consolas,monospace;font-size:14px;background:#f1eee6;padding:1px 4px;border-radius:3px",
  pre: 'white-space:pre-wrap;margin:0 0 14px',
  muted: 'color:#6b675e;font-size:14px',
}
export function styleEmail(html) {
  return String(html).replace(/<(h1|h2|h3|p|ul|ol|li|blockquote|a|code|pre|span|em)\b([^>]*)>/g, (_, tag, attrs) => {
    const muted = /\sclass="[^"]*\b(muted|verdict)\b[^"]*"/.test(attrs)
    const rest = attrs.replace(/\s(class|id)="[^"]*"/g, '')
    const style = [STYLE[tag], muted ? STYLE.muted : ''].filter(Boolean).join(';')
    return style ? `<${tag}${rest} style="${style}">` : `<${tag}${rest}>`
  })
}

// Resend reads {{...}} in a broadcast as a template tag. Nothing from an article or the model may become one.
// A zero-width space after every brace that's followed by another one, so no run of braces survives.
const noTags = (s) => String(s).replace(/\{(?=\{)/g, '{​').replace(/\}(?=\})/g, '}​')
const clean = (x) => String(x || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
const num = (x) => Number(x || 0).toLocaleString('en-US')

/** Markdown as plain text, for the email's text part: emphasis dropped, links as "label (url)". */
export function plainText(md) {
  return clean(md)
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, '$1$2')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?=[^_\w]|$)/g, '$1$2')
    .replace(/^#{1,6}\s+(.+)$/gm, (_, h) => `${h.toUpperCase()}`)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The digest as an email: { subject, html, text }. `unsubscribe` is the unsubscribe link (Resend's placeholder in a
 * broadcast; a plain page in a preview). The body is the record's own text, rendered as the page renders it.
 */
export function digestEmail(rec, { origin = ORIGIN, uri = '', unsubscribe = UNSUBSCRIBE } = {}) {
  const url = `${origin}/journal/${rec.slug || ''}/`.replace(/\/\/$/, '/')
  // the unsubscribe link goes in last, in place of a marker no article or model can guess, so a "{{{...}}}" in the
  // content is broken up like any other tag and never becomes a working one
  const mark = `autonomist-unsubscribe-${crypto.randomUUID()}`
  const sources = Array.isArray(rec.sources) ? rec.sources.map(String) : []
  const allowLink = (u) => sources.includes(u) || u.startsWith(`${PE}/`) || u.startsWith(`${origin}/`)
  const net = rec.network || {}
  const stories = (net.stories || []).length
  const byline = `autonomist's daily digest · ${esc(rec.date)} · from ${num(net.read)} article${Number(net.read) === 1 ? '' : 's'} across ${num(stories)} ${stories === 1 ? 'story' : 'stories'}`
  const body = render(clean(rec.body), { allowLink, headingIds: false })
  const checked = checkedHtml(rec.checks?.claims, rec.checks, { digest: true })
  const footer = `<p class="muted">Written by autonomist, an AI (Claude, by Anthropic), on ${esc(rec.date)}. Before it was published, code checked every quotation and every figure against the articles it read, the Power Explained pages it cites, and its own counts. It's also on the web, with everything above: <a href="${esc(url)}">${esc(url)}</a>${uri ? `, and stored in autonomist's own atproto repository as <code>${esc(uri)}</code>` : ''}.</p>
<p class="muted">To talk about it, reply to autonomist on Bluesky (<a href="https://bsky.app/profile/autonomist.jason-edelman.org">@autonomist.jason-edelman.org</a>), where its conversations are public.</p>
<p class="muted">autonomist is a public-interest project of Jason Edelman. It sells nothing. Nothing here is investment, financial, legal or tax advice, or an offer of securities; autonomist holds no money and signs nothing for anyone.</p>
<p class="muted">You're getting this because you signed up at <a href="${esc(origin)}/newsletter/">${esc(origin.replace(/^https?:\/\//, ''))}/newsletter/</a> and confirmed. <a href="${mark}">Unsubscribe</a> at any time, in one click.</p>`
  const inner = styleEmail(`<p class="muted">${byline}</p>
<h1>${esc(rec.title)}</h1>
${body}
${networkHtml(net)}${checked}<hr>
${footer}`).replace(/<hr>/g, '<hr style="border:0;border-top:1px solid #dcd7cb;margin:28px 0 18px">')
  const html = noTags(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${esc(rec.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f4ee">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(clean(rec.summary || ''))}</div>
<div style="max-width:620px;margin:0 auto;padding:24px 18px 32px;background:#ffffff;font-family:${FONT};font-size:16px;line-height:1.55;color:#1d1d1b">
${inner}
</div>
</body>
</html>`).replaceAll(mark, esc(unsubscribe))
  const network = (net.stories || []).map((st) => [`- ${clean(st.label)} (shared by ${num(st.sharers)} ${Number(st.sharers) === 1 ? 'person' : 'people'})`, ...(st.articles || []).filter((a) => /^https?:\/\//.test(a.url || '')).map((a) => `  ${clean(a.title || a.url)}${a.outlet ? ` (${clean(a.outlet)})` : ''}: ${a.url}`)].join('\n')).join('\n')
  const VERDICT = { confirmed: 'confirmed', supported: 'supported by one source', disputed: 'disputed', unsettled: 'unsettled', unverified: 'unverified' }
  const claims = (rec.checks?.claims || []).filter((c) => c?.claim && VERDICT[c.verdict]).map((c) => `- ${clean(c.claim)}: ${VERDICT[c.verdict]}${(c.sources || []).filter((x) => /^https?:\/\//.test(x?.url || '')).map((x) => `\n  ${x.url}`).join('')}`).join('\n')
  const text = noTags([
    `autonomist's daily digest · ${rec.date} · from ${num(net.read)} articles across ${num(stories)} stories`,
    '',
    clean(rec.title).toUpperCase(),
    '',
    plainText(rec.body),
    ...(network ? ['', 'WHAT THE NETWORK SHARED', '', `In the day before this digest, ${num(net.accounts)} accounts that Jason Edelman follows on Bluesky shared ${num(net.links)} links. autonomist grouped them into stories and read ${num(net.read)} articles from the most-shared, each only where its publisher allows it. Who shared what is never published.`, '', network] : []),
    ...(claims ? ['', 'CHECKED AGAINST OTHER SOURCES', '', claims] : []),
    '',
    '---',
    `Written by autonomist, an AI (Claude, by Anthropic). On the web: ${url}`,
    'To talk about it, reply to @autonomist.jason-edelman.org on Bluesky, where its conversations are public.',
    'autonomist is a public-interest project of Jason Edelman. It sells nothing. Nothing here is investment, financial, legal or tax advice, or an offer of securities.',
    `You're getting this because you signed up at ${origin}/newsletter/ and confirmed. Unsubscribe: ${mark}`,
  ].join('\n')).replaceAll(mark, unsubscribe)
  return { subject: noTags(clean(rec.title)).slice(0, 200), html, text }
}

// ---------------------------------------------------------------------------------------------------------------
// Signing up: the form, the confirmation email, the confirm button

const TOKEN = /^[A-Za-z0-9_-]{43}$/
const token = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function confirmationEmail({ origin, link }) {
  const text = `Someone, probably you, asked to get autonomist's daily digest at this address.

To confirm, open this link and press Confirm:
${link}

If it wasn't you, ignore this email. Nothing more will be sent, and the request is forgotten in two days.

autonomist is a public-interest project of Jason Edelman: an AI that reads what a network of people shares and writes a daily digest of the common threads. It sells nothing. ${origin}/journal/`
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Confirm your subscription</title></head>
<body style="margin:0;padding:0;background:#f6f4ee"><div style="max-width:560px;margin:0 auto;padding:24px 18px;background:#ffffff;font-family:${FONT};font-size:16px;line-height:1.55;color:#1d1d1b">
<p style="margin:0 0 14px">Someone, probably you, asked to get autonomist's daily digest at this address.</p>
<p style="margin:0 0 14px"><a href="${esc(link)}" style="color:#1f5f8b;text-decoration:underline">Open this link and press Confirm</a> to start getting it.</p>
<p style="margin:0 0 14px">If it wasn't you, ignore this email. Nothing more will be sent, and the request is forgotten in two days.</p>
<p style="${STYLE.muted};margin:24px 0 0">autonomist is a public-interest project of Jason Edelman: an AI that reads what a network of people shares and writes a <a href="${esc(origin)}/journal/" style="${STYLE.a}">daily digest</a> of the common threads. It sells nothing.</p>
</div></body></html>`
  return { subject: "Confirm: autonomist's daily digest", html, text }
}

/** POST /api/newsletter/subscribe { email, website }: { status, body }. Says the same whether or not the address is known. */
export async function subscribe({ env, body, visitor, fetch: f = fetch, now = Date.now() }) {
  if (!newsletterReady(env)) return { status: 503, body: { error: "The digest by email isn't open yet." } }
  if (!body || typeof body !== 'object') return { status: 400, body: { error: 'Send your email address.' } }
  const sent = { status: 200, body: { ok: true, note: 'Check your email for a link to confirm. Nothing comes until you do.' } }
  if (body.website) return sent // the honeypot: people never fill it in
  const email = normalizeEmail(body.email)
  if (!email) return { status: 400, body: { error: "That email address doesn't look right." } }
  const kv = env.KV
  const day = new Date(now).toISOString().slice(0, 10)
  const mine = `nl:visitor:${day}:${visitor}`
  const used = Number((await kv.get(mine)) || 0)
  if (used >= setting(env.NEWSLETTER_PER_VISITOR_DAILY, 5, { min: 1 })) return { status: 429, body: { error: 'Too many sign-ups from here today. Try again tomorrow.' } }
  await kv.put(mine, String(used + 1), { expirationTtl: 2 * 86400 })
  // one confirmation per address a day: asking again sends nothing, and says the same
  const asked = `nl:asked:${await sha256hex(email)}`
  if (await kv.get(asked)) return sent
  const allKey = `nl:confirms:${day}`
  const all = Number((await kv.get(allKey)) || 0)
  if (all >= setting(env.NEWSLETTER_CONFIRMS_DAILY, 100, { min: 1 })) return { status: 429, body: { error: 'Sign-ups are paused for the rest of today (UTC). Try again tomorrow.' } }
  await kv.put(allKey, String(all + 1), { expirationTtl: 2 * 86400 })
  const t = token()
  const hash = await sha256hex(t)
  await kv.put(`nl:pending:${hash}`, JSON.stringify({ email, at: new Date(now).toISOString() }), { expirationTtl: 2 * 86400 })
  const origin = originOf(env)
  const mail = confirmationEmail({ origin, link: `${origin}/newsletter/confirm/#t=${t}` })
  const r = await resend(env, 'POST', '/emails', { from: env.NEWSLETTER_FROM, to: [email], ...mail }, { fetch: f, idempotencyKey: `confirm/${hash.slice(0, 40)}` }).catch((e) => ({ ok: false, status: 0, data: { message: String(e?.message || e) } }))
  if (!r.ok) {
    await kv.delete(`nl:pending:${hash}`).catch(() => {})
    console.log(JSON.stringify({ newsletter: 'confirmation', ok: false, status: r.status, error: r.data?.name || r.data?.message || null }))
    return { status: 502, body: { error: "The confirmation email couldn't be sent. Try again later." } }
  }
  await kv.put(asked, '1', { expirationTtl: 86400 })
  return sent
}

/** POST /api/newsletter/confirm { token }: adds the pending address to the segment, once. */
export async function confirm({ env, body, fetch: f = fetch }) {
  if (!newsletterReady(env)) return { status: 503, body: { error: "The digest by email isn't open yet." } }
  const t = String(body?.token || '')
  if (!TOKEN.test(t)) return { status: 400, body: { error: "That link isn't complete. Open it again from the email." } }
  const kv = env.KV
  const key = `nl:pending:${await sha256hex(t)}`
  const pending = await kv.get(key, 'json')
  if (!pending?.email) return { status: 400, body: { error: 'That link has expired or was already used. Sign up again on the newsletter page.' } }
  const seg = env.RESEND_SEGMENT_ID
  const email = pending.email
  let r = await resend(env, 'POST', '/contacts', { email, unsubscribed: false, segments: [{ id: seg }] }, { fetch: f })
  // already a contact (signed up before, or unsubscribed and back): subscribed again, and in the segment
  if (!r.ok && r.status !== 429 && r.status < 500) {
    const path = `/contacts/${encodeURIComponent(email)}`
    const p = await resend(env, 'PATCH', path, { unsubscribed: false }, { fetch: f })
    if (p.ok) r = await resend(env, 'POST', `${path}/segments/${encodeURIComponent(seg)}`, undefined, { fetch: f })
    // in the segment already counts as done
    if (p.ok && !r.ok && r.status === 409) r = { ok: true }
  }
  if (!r.ok) {
    console.log(JSON.stringify({ newsletter: 'confirm', ok: false, status: r.status, error: r.data?.name || r.data?.message || null }))
    return { status: 502, body: { error: "That didn't go through. Try the link again in a little while." } }
  }
  await kv.delete(key)
  return { status: 200, body: { ok: true, note: "You're subscribed. The next digest comes by email." } }
}

// ---------------------------------------------------------------------------------------------------------------
// Sending: one broadcast per published digest

/** What finishPublish queues for the newsletter: the record itself, so sending reads nothing back from the repository. */
export const queueKey = (day) => `newsletter:queue:${day}`

/**
 * Sends the queued digest (today's or yesterday's) as a broadcast, once. Hourly; does nothing without a queue or
 * without the newsletter's config. A failure is retried at the next hour, up to four times.
 */
export async function sendNewsletter({ env, kv, now = new Date(), fetch: f = fetch }) {
  if (!newsletterReady(env)) return { skipped: 'not configured' }
  const days = [0, 1].map((d) => new Date(now.getTime() - d * 86400_000).toISOString().slice(0, 10))
  for (const day of days) {
    const q = await kv.get(queueKey(day), 'json')
    if (!q?.record) continue
    const stateKey = `newsletter:state:${q.slug}`
    const state = (await kv.get(stateKey, 'json')) || { attempts: 0 }
    if (state.sent) { await kv.delete(queueKey(day)); return { already: state.sent, slug: q.slug } }
    if (state.attempts >= 4) return { gaveUp: q.slug, error: state.error }
    state.attempts++
    await kv.put(stateKey, JSON.stringify(state), { expirationTtl: 7 * 86400 })
    try {
      if (!state.id) {
        const mail = digestEmail({ ...q.record, slug: q.slug }, { origin: originOf(env), uri: q.uri })
        const r = await resend(env, 'POST', '/broadcasts', { segment_id: env.RESEND_SEGMENT_ID, from: env.NEWSLETTER_FROM, name: `Digest ${q.record.date}: ${mail.subject}`.slice(0, 200), ...mail }, { fetch: f })
        if (!r.ok || !r.data?.id) throw fail('create', r)
        state.id = r.data.id
        await kv.put(stateKey, JSON.stringify(state), { expirationTtl: 7 * 86400 })
      }
      // a send that went through before a run was cut short leaves the broadcast queued or sent: never send it again
      const g = await resend(env, 'GET', `/broadcasts/${encodeURIComponent(state.id)}`, undefined, { fetch: f })
      if (!g.ok) throw fail('status', g)
      if (g.data?.status && g.data.status !== 'draft') {
        state.sent = g.data.status
      } else {
        const s = await resend(env, 'POST', `/broadcasts/${encodeURIComponent(state.id)}/send`, {}, { fetch: f })
        if (!s.ok) throw fail('send', s)
        state.sent = 'sent'
      }
      state.at = new Date().toISOString()
      await kv.put(stateKey, JSON.stringify(state), { expirationTtl: 30 * 86400 })
      await kv.delete(queueKey(day))
      return { sent: state.id, slug: q.slug, status: state.sent }
    } catch (e) {
      state.error = String(e?.message || e).slice(0, 300)
      await kv.put(stateKey, JSON.stringify(state), { expirationTtl: 7 * 86400 })
      throw e
    }
  }
  return { none: true }
}

/** A dry run's email, sent to the steward alone (the steward's page): a preview, never the list. */
export async function previewToSteward({ env, email, to, id, fetch: f = fetch }) {
  if (!env.RESEND_API_KEY || !env.NEWSLETTER_FROM) return { status: 503, body: { error: 'Email is not configured (RESEND_API_KEY, NEWSLETTER_FROM).' } }
  if (!email?.html) return { status: 404, body: { error: 'That dry run has no email.' } }
  const page = `${originOf(env)}/newsletter/`
  const r = await resend(env, 'POST', '/emails', {
    from: env.NEWSLETTER_FROM,
    to: [to],
    subject: `[dry run] ${email.subject}`,
    html: email.html.replaceAll(UNSUBSCRIBE, page),
    text: email.text.replaceAll(UNSUBSCRIBE, page),
  }, { fetch: f, idempotencyKey: `dry/${id}/${(await sha256hex(to)).slice(0, 16)}` })
  if (!r.ok) return { status: 502, body: { error: `Resend said ${r.status}${r.data?.message ? `: ${String(r.data.message).slice(0, 200)}` : ''}` } }
  return { status: 200, body: { ok: true, note: `Sent to ${to}. Only you got it.` } }
}

export { UNSUBSCRIBE }
