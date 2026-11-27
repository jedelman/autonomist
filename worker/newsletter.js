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
//   confirmation per inbox per day ("+tags" and Gmail's dots don't make a new inbox), and confirmation emails per day
//   for the whole site. Someone who rotates networks can still spend the site's daily cap; no one can send one inbox
//   more than one confirmation a day.
// - One broadcast per published digest. A draft is created and its id kept; its status is read before it's sent, so
//   a run cut short never sends the digest twice (Resend's idempotency keys don't cover broadcasts).
// - Unsubscribing is Resend's: every digest carries its unsubscribe link ({{{RESEND_UNSUBSCRIBE_URL}}}).
import { esc, render } from '../site/js/md.js'
import { networkHtml, checkedHtml, postKey, postUrl } from './journal-pages.js'
import { INK, leadEmail, trendEmail, powerMapEmail, pullEmail, assemble, longDate } from './digest-html.js'
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
// The look is the site's broadsheet (.impeccable.md): ink on newsprint, vermilion for what to act on. No web fonts
// (Gmail and most clients ignore them): the nameplate is an image from the site, set in the site's face, and the text
// falls back to faces mail clients have. The site keeps no request logs, so nothing it serves counts who opens one.
const FONT = "Georgia, 'Times New Roman', serif"
const DISPLAY = "'Big Shoulders', 'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue', Arial, sans-serif"
const LABEL = `font-family:${DISPLAY};font-weight:700;font-size:13px;line-height:1.2;letter-spacing:1.6px;text-transform:uppercase;color:${INK.spotText}`
const STYLE = {
  h1: `font-family:${FONT};font-weight:700;font-size:30px;line-height:1.15;margin:6px 0 14px;color:${INK.ink}`,
  h2: `${LABEL};margin:34px 0 12px;padding-top:12px;border-top:1px solid ${INK.ink}`,
  h3: `font-family:${FONT};font-weight:700;font-size:17px;line-height:1.3;margin:20px 0 6px;color:${INK.ink}`,
  p: 'margin:0 0 15px',
  ul: 'margin:0 0 15px;padding-left:22px',
  ol: 'margin:0 0 15px;padding-left:22px',
  li: 'margin:0 0 7px',
  blockquote: `margin:0 0 15px 20px;padding:0;font-style:italic;color:${INK.ink2}`,
  a: `color:${INK.ink};text-decoration:underline;text-decoration-color:${INK.spot}`,
  code: `font-family:Menlo,Consolas,monospace;font-size:13px;background:${INK.paper};padding:1px 4px;word-break:break-all`,
  pre: 'white-space:pre-wrap;margin:0 0 15px',
}
// a few classes the renderers use, styled inline too
const CLASS = {
  muted: `color:${INK.muted};font-size:14px`,
  verdict: `color:${INK.muted};font-size:14px`,
  kicker: `${LABEL};margin:0 0 6px`,
  q: `font-family:${FONT};font-weight:700;font-size:23px;line-height:1.3;color:${INK.ink}`,
  discuss: `font-weight:700`,
  theme: `font-family:${DISPLAY};font-weight:700;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${INK.muted}`,
}
export function styleEmail(html) {
  return String(html).replace(/<(h1|h2|h3|p|ul|ol|li|blockquote|a|code|pre|span|em)\b([^>]*)>/g, (whole, tag, attrs) => {
    // parts drawn for email already (digest-html.js) keep their own styles
    if (/\sstyle="/.test(attrs)) return whole
    const classes = (attrs.match(/\sclass="([^"]*)"/)?.[1] || '').split(/\s+/).filter((c) => CLASS[c])
    const rest = attrs.replace(/\s(class|id)="[^"]*"/g, '')
    const style = [STYLE[tag], ...classes.map((c) => CLASS[c])].filter(Boolean).join(';')
    return style ? `<${tag}${rest} style="${style}">` : `<${tag}${rest}>`
  })
}

/** The masthead every email opens with: the band, then the nameplate over a double rule. */
const masthead = (origin) => `<div style="background:${INK.ink};color:#f0eae2;font-family:${DISPLAY};font-weight:600;font-size:11px;letter-spacing:1.4px;text-transform:uppercase;text-align:center;padding:8px 12px">A public-interest project. Not a company, and it sells nothing.</div>
<div style="padding:22px 22px 0"><a href="${esc(origin)}/" style="display:block;text-decoration:none;padding-bottom:10px;border-bottom:3px double ${INK.ink}"><img src="${esc(origin)}/email/nameplate.png" width="596" alt="autonomist" style="display:block;width:100%;max-width:596px;height:auto;border:0;font-family:${DISPLAY};font-weight:800;font-size:48px;line-height:1;color:${INK.ink}"></a></div>`

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
export function digestEmail(rec, { origin = ORIGIN, uri = '', post = null, unsubscribe = UNSUBSCRIBE, src } = {}) {
  const thread = postUrl(post)
  const url = `${origin}/journal/${rec.slug || ''}/`.replace(/\/\/$/, '/')
  // the unsubscribe link goes in last, in place of a marker no article or model can guess, so a "{{{...}}}" in the
  // content is broken up like any other tag and never becomes a working one
  const mark = `autonomist-unsubscribe-${crypto.randomUUID()}`
  const sources = Array.isArray(rec.sources) ? rec.sources.map(String) : []
  const allowLink = (u) => sources.includes(u) || u.startsWith(`${PE}/`) || u.startsWith(`${origin}/`)
  const net = rec.network || {}
  const stories = (net.stories || []).length
  const byline = `The daily digest · ${esc(longDate(rec.date))} · from ${num(net.read)} article${Number(net.read) === 1 ? '' : 's'} across ${num(stories)} ${stories === 1 ? 'story' : 'stories'}`
  const body = render(clean(rec.body), { allowLink, headingIds: false })
  const checked = checkedHtml(rec.checks?.claims, rec.checks, { digest: true })
  const footer = `<p class="muted">Written by autonomist, an AI (Claude, by Anthropic), on ${esc(rec.date)}. Before it was published, code checked every quotation and every figure against the articles it read, the Power Explained pages it cites, and its own counts. It's also on the web, with everything above: <a href="${esc(url)}">${esc(url)}</a>${uri ? `, and stored in autonomist's own atproto repository as <code>${esc(uri)}</code>` : ''}.</p>
<p class="muted">${thread ? `To talk it over, <a href="${esc(thread)}">reply under autonomist's post of its question</a> on Bluesky` : `To talk about it, reply to autonomist on Bluesky (<a href="https://bsky.app/profile/autonomist.jason-edelman.org">@autonomist.jason-edelman.org</a>)`}, where its conversations are public.</p>
<p class="muted">autonomist is a public-interest project of Jason Edelman. It sells nothing. Nothing here is investment, financial, legal or tax advice, or an offer of securities; autonomist holds no money and signs nothing for anyone.</p>
<p class="muted">You're getting this because you signed up at <a href="${esc(origin)}/newsletter/">${esc(origin.replace(/^https?:\/\//, ''))}/newsletter/</a> and confirmed. <a href="${mark}">Unsubscribe</a> at any time, in one click.</p>`
  // the day's question, set large like the site's; the analysis and the pull quote in their places
  const parts = { trend: trendEmail(net.trend), pull: pullEmail(rec.pull), powerMap: powerMapEmail(rec.analysis?.powerMap) }
  const bodyHtml = assemble(body, parts, (id, text) => `<h2>${text}</h2>`).replace(/(<h2>A question to take to your neighbors<\/h2>\s*)<p>/, '$1<p class="q">')
  const lead = leadEmail((net.stories || []).find((st) => st.image), { origin, src })
  const inner = styleEmail(`<p class="kicker">${byline}</p>
<h1>${esc(rec.title)}</h1>
${lead}${bodyHtml}
${networkHtml(net, { images: false, units: false })}${checked}<hr>
${footer}`).replace(/<hr>/g, `<hr style="border:0;border-top:3px double ${INK.ink};margin:32px 0 18px">`)
  const html = noTags(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(rec.title)}</title>
</head>
<body style="margin:0;padding:0;background:${INK.paper}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(clean(rec.summary || ''))}</div>
<div style="max-width:640px;margin:0 auto;background:${INK.sheet}">
${masthead(origin)}
<div style="padding:18px 22px 32px;font-family:${FONT};font-size:17px;line-height:1.6;color:${INK.ink}">
${inner}
</div>
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
    thread ? `To talk it over, reply under autonomist's post of its question on Bluesky, where its conversations are public: ${thread}` : 'To talk about it, reply to @autonomist.jason-edelman.org on Bluesky, where its conversations are public.',
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
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>Confirm your subscription</title></head>
<body style="margin:0;padding:0;background:${INK.paper}"><div style="max-width:560px;margin:0 auto;background:${INK.sheet}">
${masthead(origin)}
<div style="padding:22px 22px 28px;font-family:${FONT};font-size:17px;line-height:1.6;color:${INK.ink}">
<p style="${CLASS.kicker}">The daily digest</p>
<p style="margin:0 0 15px">Someone, probably you, asked to get autonomist's daily digest at this address.</p>
<p style="margin:22px 0"><a href="${esc(link)}" style="display:inline-block;font-family:${DISPLAY};font-weight:700;font-size:16px;letter-spacing:1.4px;text-transform:uppercase;color:${INK.sheet};background:${INK.spotText};text-decoration:none;padding:12px 18px">Confirm on the page &rarr;</a></p>
<p style="margin:0 0 15px">The link opens a page with a Confirm button; press it to start getting the digest. If it wasn't you, ignore this email. Nothing more will be sent, and the request is forgotten in two days.</p>
<p style="${CLASS.muted};margin:24px 0 0;padding-top:12px;border-top:3px double ${INK.ink}">autonomist is a public-interest project of Jason Edelman: an AI that reads what a network of people shares and writes a <a href="${esc(origin)}/journal/" style="${STYLE.a}">daily digest</a> of the common threads. It sells nothing.</p>
</div></div></body></html>`
  return { subject: "Confirm: autonomist's daily digest", html, text }
}

// Workers KV takes one write a second per key, and a second write throws. So nothing below writes a key twice in a
// request or a run: counters are one key per event, counted by listing, and each step of a send has its own key.
async function count(kv, prefix, max = 1000) {
  let n = 0, cursor
  do {
    const page = await kv.list({ prefix, cursor })
    n += page.keys.length
    cursor = page.list_complete || n >= max ? undefined : page.cursor
  } while (cursor)
  return n
}
const nonce = () => crypto.randomUUID().slice(0, 8)

/** The inbox an address reaches, so "name+1@" and "name+2@" (and Gmail's dotted spellings) count as one. */
export function inboxOf(email) {
  const [local, domain] = String(email).toLowerCase().split('@')
  const l = local.replace(/\+.*$/, '')
  return domain === 'gmail.com' || domain === 'googlemail.com' ? `${l.replace(/\./g, '')}@gmail.com` : `${l}@${domain}`
}

// keyed with IP_SALT, so no one reading KV can test a guessed address against it
async function keyed(env, s) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.IP_SALT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`newsletter:${s}`)))
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * POST /api/newsletter/subscribe { email, website }: { status, body }. The answer is the same whether or not the
 * address was asked before (only a failed send says otherwise, so the person can try again).
 */
export async function subscribe({ env, body, visitor, fetch: f = fetch, now = Date.now(), sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)) }) {
  if (!newsletterReady(env) || !env.IP_SALT) return { status: 503, body: { error: "The digest by email isn't open yet." } }
  if (!body || typeof body !== 'object') return { status: 400, body: { error: 'Send your email address.' } }
  const sent = { status: 200, body: { ok: true, note: 'Check your email for a link to confirm. Nothing comes until you do.' } }
  if (body.website) return sent // the honeypot: people never fill it in
  const email = normalizeEmail(body.email)
  if (!email) return { status: 400, body: { error: "That email address doesn't look right." } }
  const kv = env.KV
  const day = new Date(now).toISOString().slice(0, 10)
  // the site's cap first, so its answer is the same for every address
  const cap = setting(env.NEWSLETTER_CONFIRMS_DAILY, 100, { min: 1, max: 1000 })
  if ((await count(kv, `nl:sent:${day}:`, cap)) >= cap) return { status: 429, body: { error: 'Sign-ups are paused for the rest of today (UTC). Try again tomorrow.' } }
  const perVisitor = setting(env.NEWSLETTER_PER_VISITOR_DAILY, 5, { min: 1, max: 100 })
  if ((await count(kv, `nl:visitor:${day}:${visitor}:`, perVisitor)) >= perVisitor) return { status: 429, body: { error: 'Too many sign-ups from here today. Try again tomorrow.' } }
  await kv.put(`nl:visitor:${day}:${visitor}:${nonce()}`, '', { expirationTtl: 2 * 86400 })
  // one confirmation per inbox a day, marked before sending: asking again (or in parallel) sends nothing, and says the same
  const asked = `nl:asked:${await keyed(env, inboxOf(email))}`
  if (await kv.get(asked)) return sent
  await kv.put(asked, '1', { expirationTtl: 86400 })
  await kv.put(`nl:sent:${day}:${nonce()}`, '', { expirationTtl: 2 * 86400 })
  const t = token()
  const hash = await sha256hex(t)
  await kv.put(`nl:pending:${hash}`, JSON.stringify({ email, at: new Date(now).toISOString() }), { expirationTtl: 2 * 86400 })
  const origin = originOf(env)
  const mail = confirmationEmail({ origin, link: `${origin}/newsletter/confirm/#t=${t}` })
  const r = await resend(env, 'POST', '/emails', { from: env.NEWSLETTER_FROM, to: [email], ...mail }, { fetch: f, idempotencyKey: `confirm/${hash.slice(0, 40)}` }).catch((e) => ({ ok: false, status: 0, data: { message: String(e?.message || e) } }))
  if (!r.ok) {
    console.log(JSON.stringify({ newsletter: 'confirmation', ok: false, status: r.status, error: r.data?.name || r.data?.message || null }))
    // nothing was sent: forget the address and the mark, so the person can try again (after a second, KV's write limit)
    await sleep(1100)
    await kv.delete(`nl:pending:${hash}`).catch(() => {})
    await kv.delete(asked).catch(() => {})
    return { status: 502, body: { error: "The confirmation email couldn't be sent. Try again later." } }
  }
  return sent
}

// An address in a path as Resend's docs write it: "@" and "+" as they are, anything else encoded.
const pathEmail = (email) => encodeURIComponent(email).replace(/%40/g, '@').replace(/%2B/gi, '+')
const down = (r) => r.status === 0 || r.status === 429 || r.status >= 500

/**
 * POST /api/newsletter/confirm { token }: the pending address subscribed and in the segment, once. Resend's docs don't
 * say what creating an existing contact returns, so after creating, it reads the contact as it is and fixes what's
 * missing: subscribed again (it may have unsubscribed before), and in the segment.
 */
export async function confirm({ env, body, fetch: f = fetch }) {
  if (!newsletterReady(env)) return { status: 503, body: { error: "The digest by email isn't open yet." } }
  const t = String(body?.token || '')
  if (!TOKEN.test(t)) return { status: 400, body: { error: "That link isn't complete. Open it again from the email." } }
  const kv = env.KV
  const key = `nl:pending:${await sha256hex(t)}`
  const pending = await kv.get(key, 'json')
  if (!pending?.email) return { status: 400, body: { error: 'That link has expired or was already used. Sign up again on the newsletter page.' } }
  const seg = env.RESEND_SEGMENT_ID
  const failed = (step, r) => {
    console.log(JSON.stringify({ newsletter: 'confirm', step, ok: false, status: r.status, error: r.data?.name || r.data?.message || null }))
    return { status: 502, body: { error: "That didn't go through. Try the link again in a little while." } }
  }
  const call = (method, path, b) => resend(env, method, path, b, { fetch: f }).catch((e) => ({ ok: false, status: 0, data: { message: String(e?.message || e) } }))
  const created = await call('POST', '/contacts', { email: pending.email, unsubscribed: false, segments: [{ id: seg }] })
  if (down(created)) return failed('create', created)
  const c = await call('GET', `/contacts/${pathEmail(pending.email)}`)
  if (!c.ok || !c.data?.id) return failed('read', c)
  const id = encodeURIComponent(c.data.id)
  if (c.data.unsubscribed !== false) {
    const p = await call('PATCH', `/contacts/${id}`, { unsubscribed: false })
    if (!p.ok) return failed('resubscribe', p)
  }
  const s = await call('GET', `/contacts/${id}/segments`)
  if (!s.ok) return failed('segments', s)
  if (!(s.data?.data || []).some((x) => x?.id === seg)) {
    const a = await call('POST', `/contacts/${id}/segments/${encodeURIComponent(seg)}`)
    if (!a.ok) return failed('segment', a)
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
 * without the newsletter's config. One try an hour (which also keeps two overlapping runs from each sending), four in
 * all. Each step has its own key, written once: a try (`newsletter:try:<slug>:<hour>`), the draft's id
 * (`newsletter:draft:<slug>`), and the send (`newsletter:sent:<slug>`).
 *
 * The newest queued digest is the one that goes. An older one still waiting is dropped: an issue that arrives a day
 * late, after the next one, tells subscribers nothing the newer one doesn't (2026-11-27, when switching the newsletter
 * on found two digests queued).
 */
export async function sendNewsletter({ env, kv, now = new Date(), fetch: f = fetch }) {
  if (!newsletterReady(env)) return { skipped: 'not configured' }
  const days = [0, 1].map((d) => new Date(now.getTime() - d * 86400_000).toISOString().slice(0, 10))
  const queued = []
  for (const day of days) {
    const q = await kv.get(queueKey(day), 'json')
    if (q?.record) queued.push({ day, q })
  }
  if (!queued.length) return { none: true }
  const superseded = []
  for (const { day, q } of queued.slice(1)) {
    await kv.delete(queueKey(day)).catch(() => {})
    superseded.push(q.slug)
  }
  const r = await sendQueued({ env, kv, now, f, ...queued[0] })
  return superseded.length ? { ...r, superseded } : r
}

async function sendQueued({ env, kv, now, f, day, q }) {
  const slug = q.slug
  const sentKey = `newsletter:sent:${slug}`, draftKey = `newsletter:draft:${slug}`, tries = `newsletter:try:${slug}:`
  const already = await kv.get(sentKey)
  if (already) { await kv.delete(queueKey(day)).catch(() => {}); return { already, slug } }
  const thisHour = `${tries}${now.toISOString().slice(0, 13)}`
  if (await kv.get(thisHour)) return { skipped: 'tried this hour', slug }
  const tried = await count(kv, tries, 10)
  if (tried >= 4) return { gaveUp: slug, tries: tried }
  await kv.put(thisHour, '1', { expirationTtl: 7 * 86400 })
  let id = await kv.get(draftKey)
  if (!id) {
    // the digest's post is usually up by now (announced in the same run, before this step). The name is internal to
    // Resend, which refuses one over 70 characters (the first send, 2026-11-27, failed on it).
    const mail = digestEmail({ ...q.record, slug }, { origin: originOf(env), uri: q.uri, post: await kv.get(postKey(slug)) })
    const r = await resend(env, 'POST', '/broadcasts', { segment_id: env.RESEND_SEGMENT_ID, from: env.NEWSLETTER_FROM, name: `Digest ${q.record.date}: ${mail.subject}`.slice(0, 70), ...mail }, { fetch: f })
    if (!r.ok || !r.data?.id) throw fail('create', r)
    id = r.data.id
    await kv.put(draftKey, id, { expirationTtl: 7 * 86400 })
  }
  // a send that went through before a run was cut short leaves the broadcast queued or sent: never send it again
  const g = await resend(env, 'GET', `/broadcasts/${encodeURIComponent(id)}`, undefined, { fetch: f })
  if (!g.ok) throw fail('status', g)
  let status = g.data?.status
  if (!status || status === 'draft') {
    const s = await resend(env, 'POST', `/broadcasts/${encodeURIComponent(id)}/send`, {}, { fetch: f })
    if (!s.ok) throw fail('send', s)
    status = 'sent'
  }
  await kv.put(sentKey, status, { expirationTtl: 30 * 86400 })
  // the queue may have been written moments ago in this same run (KV's one write a second): the sent mark already
  // keeps the digest from going twice, so a failed delete is left to the next run
  await kv.delete(queueKey(day)).catch(() => {})
  return { sent: id, slug, status }
}

/** A dry run's email, sent to the steward alone (the steward's page): a preview, never the list. */
export async function previewToSteward({ env, email, to, id, fetch: f = fetch, now = new Date() }) {
  if (!env.RESEND_API_KEY || !env.NEWSLETTER_FROM) return { status: 503, body: { error: 'Email is not configured (RESEND_API_KEY, NEWSLETTER_FROM).' } }
  if (!email?.html) return { status: 404, body: { error: 'That dry run has no email.' } }
  const page = `${originOf(env)}/newsletter/`
  // the key spans a minute: a double click sends one, and pressing again later sends again
  const r = await resend(env, 'POST', '/emails', {
    from: env.NEWSLETTER_FROM,
    to: [to],
    subject: `[dry run] ${email.subject}`,
    html: email.html.replaceAll(UNSUBSCRIBE, page),
    text: email.text.replaceAll(UNSUBSCRIBE, page),
  }, { fetch: f, idempotencyKey: `dry/${id}/${(await sha256hex(to)).slice(0, 16)}/${now.toISOString().slice(0, 16)}` })
  if (!r.ok) return { status: 502, body: { error: `Resend said ${r.status}${r.data?.message ? `: ${String(r.data.message).slice(0, 200)}` : ''}` } }
  return { status: 200, body: { ok: true, note: `Sent to ${to}. Only you got it.` } }
}

export { UNSUBSCRIBE }
