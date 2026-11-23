// journal-core.js: what the news journal's checker (scripts/journal-check.mjs) and the bot's daily writer
// (worker/bot/journal.js) share. Pure functions, no network. The robots and text helpers follow the research
// watch's (jedelman/jason-edelman.org, research-watch/lib.mjs).
//
// The journal's one rule a machine can hold it to: text in curly double quotes (“…”) is verbatim from a source the
// entry lists. Numbers are held to the same standard: every figure appears in a source.

export const AGENT = 'autonomist'
export const UA = `Mozilla/5.0 (compatible; ${AGENT}/1.0; +https://autonomist.jason-edelman.org/journal/)`
export const SECTIONS = ['What it says', 'Through Power Explained', 'What it means for the federation', "What we don't know", 'A question to take to your neighbors']

export function frontMatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { meta: {}, body: src }
  const meta = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1')
  }
  return { meta, body: src.slice(m[0].length) }
}

/** Every passage in curly double quotes, without trailing punctuation. */
export const extractQuotes = (body) => [...String(body).matchAll(/“([^”]+)”/g)].map((m) => m[1].replace(/[.,;:]+$/, '').trim()).filter(Boolean)

/** Folds the differences a quote picks up in copying: case, curly quotes, dashes, spaces, soft hyphens. */
export function normalize(s) {
  return String(s).normalize('NFKC')
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/­/g, '')
    .replace(/…/g, '...')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…', euro: '€' }
export const decodeEntities = (s) => String(s)
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)

export function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
}

/** An article page's readable text (its long paragraphs) and what the page says about itself. */
export function readArticle(html, url) {
  const s = String(html)
  const meta = (name) => {
    for (const q of ['"', "'"]) {
      const v = `${q}([^${q}]*)${q}`
      const m = s.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=${v}`, 'i')) || s.match(new RegExp(`<meta[^>]+content=${v}[^>]*(?:property|name)=["']${name}["']`, 'i'))
      if (m) return decodeEntities(m[1]).trim()
    }
    return ''
  }
  let ld = {}
  for (const m of s.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const j = JSON.parse(m[1])
      const item = [j, ...(Array.isArray(j['@graph']) ? j['@graph'] : [])].find((x) => x && /Article|BlogPosting|Report/.test(String(x['@type'])))
      if (item) { ld = item; break }
    } catch {}
  }
  const authors = [].concat(ld.author || []).map((a) => (typeof a === 'string' ? a : a?.name)).filter(Boolean)
  const body = s.replace(/<(script|style|noscript|template|svg|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
  const paras = [...body.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => htmlToText(m[1]).replace(/\s+/g, ' ').trim()).filter((p) => p.length > 60)
  const text = paras.join('\n\n')
  return {
    url,
    title: meta('og:title') || ld.headline || (s.match(/<title>([^<]*)<\/title>/i)?.[1] ?? '').trim(),
    description: meta('og:description') || meta('description'),
    siteName: meta('og:site_name') || (url ? new URL(url).hostname.replace(/^www\./, '') : ''),
    published: String(ld.datePublished || meta('article:published_time') || '').slice(0, 10),
    authors: authors.length ? authors : [meta('author')].filter(Boolean),
    text,
    words: text ? text.split(/\s+/).length : 0,
  }
}

/**
 * Figures in a text: anything with two or more digits, and a single digit next to a currency sign, "%" or a
 * magnitude word ("$9 billion", "4 percent"). Other single digits are everywhere and prove nothing.
 */
export function extractNumbers(text) {
  const t = String(text).normalize('NFKC')
  const out = [...t.matchAll(/\d[\d,.]*\d/g)].map((m) => m[0].replace(/[.,]+$/, ''))
  for (const m of t.matchAll(/(?:[$€£¥]\s?(\d)(?!\d|[.,]\d))|(?:(?<![\d.,])(\d)(?=\s?(?:%|percent\b|per cent\b|million\b|billion\b|trillion\b|thousand\b)))/gi)) out.push(m[1] || m[2])
  return [...new Set(out)]
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** Whether a figure appears in a normalized source text as a whole number (not inside a longer one), with or without thousands separators. */
export function numberIn(num, normText) {
  const bare = num.replace(/,/g, '')
  const withCommas = bare.replace(/^(\d+)(\.\d+)?$/, (_, i, f = '') => i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + f)
  return [...new Set([num, bare, withCommas])].some((v) => new RegExp(`(?<![\\d.,])${reEsc(v)}(?![\\d]|[.,]\\d)`).test(normText))
}

/**
 * What a program can hold quotations to: only “…” is a quotation, they pair up, and
 * nothing else that looks like a quotation (blockquotes, other quote marks) appears. Each is at least two words, so a
 * single common word can't pass as a quotation. Returns problems.
 */
export function quoteProblems(text) {
  const t = String(text)
  const problems = []
  if (/^\s*>/m.test(t)) problems.push('no blockquotes: quote inline with “ ”')
  if (/[‘«»„‟‹›＂〝〞]/.test(t)) problems.push('no quote marks other than “ ” (no ‘ « » „)')
  const marks = [...t.matchAll(/[“”]/g)].map((m) => m[0]).join('')
  if (!/^(“”)*$/.test(marks)) problems.push('curly quotes must open with “ and close with ” in pairs')
  for (const q of extractQuotes(t)) if (q.split(/\s+/).filter(Boolean).length < 2) problems.push(`a quotation must be at least two words: “${q}”`)
  return problems
}

/** Control characters (other than newline and tab) have no place in published text. */
export const hasControlChars = (s) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(String(s))

/** The five sections, in order. Returns problems. */
export function checkSections(body) {
  const problems = []
  let at = -1
  for (const s of SECTIONS) {
    const i = String(body).indexOf(`## ${s}\n`)
    if (i < 0) problems.push(`missing section: ## ${s}`)
    else if (i < at) problems.push(`section out of order: ## ${s}`)
    else at = i
  }
  return problems
}

/**
 * Checks a body against the texts of its sources: every quotation verbatim in one of them, every figure in one of
 * them, no links but allowed ones. `texts` are normalized source texts. Returns problems and what passed.
 */
export function verifyBody(body, texts, { allowedLinks = [] } = {}) {
  const problems = [], quotes = [], numbers = []
  for (const q of extractQuotes(body)) {
    const nq = normalize(q)
    if (texts.some((t) => t.includes(nq))) quotes.push(q)
    else problems.push(`quote not found in any source: “${q}”`)
  }
  for (const n of extractNumbers(body)) {
    if (texts.some((t) => numberIn(n, t))) numbers.push(n)
    else problems.push(`figure not found in any source: ${n}`)
  }
  for (const m of String(body).matchAll(/https?:\/\/[^\s)<>"]+/g)) {
    const u = m[0].replace(/[.,;:]+$/, '')
    if (!allowedLinks.some((a) => u === a || u.startsWith(a))) problems.push(`link not allowed: ${u}`)
  }
  if (!allowedLinks.length && /\]\(|<a\s|(^|\s)www\./i.test(String(body))) problems.push('no links')
  return { problems, quotes, numbers }
}

export const slugify = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '')

export function parseRobots(txt) {
  const groups = [], signals = []
  let cur = null, lastWasAgent = false
  for (const raw of String(txt).split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim()
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i)
    if (!m) continue
    const key = m[1].toLowerCase(), val = m[2].trim()
    if (key === 'user-agent') {
      if (!lastWasAgent) { cur = { agents: [], rules: [] }; groups.push(cur) }
      cur.agents.push(val.toLowerCase())
      lastWasAgent = true
      continue
    }
    lastWasAgent = false
    if (key === 'content-signal') signals.push(val)
    else if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: val.replace(/\$$/, '') })
  }
  return { groups, signals }
}

/** Whether parsed robots.txt lets autonomist read a URL: its own group, else "*"; the longest matching rule wins. */
export function robotsDecision({ groups, signals }, url) {
  const u = new URL(url)
  if (signals.some((s) => /\bai-input\s*=\s*no\b/i.test(s))) return { ok: false, why: 'Content-Signal ai-input=no' }
  const group = groups.find((g) => g.agents.includes(AGENT)) || groups.find((g) => g.agents.includes('*'))
  if (!group) return { ok: true, why: signals.length ? `Content-Signal: ${signals.join('; ')}` : 'no rules for this agent' }
  const path = u.pathname + u.search
  let best = null
  for (const rule of group.rules) {
    if (!rule.path) continue
    const re = new RegExp('^' + rule.path.replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*'))
    if (re.test(path) && (!best || rule.path.length > best.path.length || (rule.path.length === best.path.length && rule.allow))) best = rule
  }
  return best && !best.allow ? { ok: false, why: `robots.txt disallows ${best.path}` } : { ok: true, why: best ? `robots.txt allows ${best.path}` : 'no rule matches' }
}

/** Reads robots.txt for a URL's site (cached per origin in `cache`) and decides. */
export async function canRead(url, { fetch: f = fetch, cache = new Map() } = {}) {
  const { origin } = new URL(url)
  if (!cache.has(origin)) {
    // RFC 9309: a missing robots.txt (4xx) allows; a server error, rate limit or unreachable site means don't read
    let parsed
    try {
      const r = await f(`${origin}/robots.txt`, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(15000) })
      if (r.ok) parsed = parseRobots(await r.text())
      else if (r.status >= 400 && r.status < 500 && r.status !== 429) parsed = parseRobots('')
      else parsed = { closed: `robots.txt answered ${r.status}` }
    } catch { parsed = { closed: 'robots.txt unreachable' } }
    cache.set(origin, parsed)
  }
  const p = cache.get(origin)
  return p.closed ? { ok: false, why: p.closed } : robotsDecision(p, url)
}

/**
 * Fetches a page for reading, following redirects by hand so robots.txt and Content-Signal are checked on every hop
 * and on the final URL before any body is read. Returns { res, url } or throws with the reason.
 */
export async function fetchReadable(url, { fetch: f = fetch, cache = new Map(), accept = 'text/html', hops = 5 } = {}) {
  let at = url
  for (let i = 0; i <= hops; i++) {
    const can = await canRead(at, { fetch: f, cache })
    if (!can.ok) throw new Error(`closed to autonomist: ${can.why}`)
    const res = await f(at, { headers: { 'user-agent': UA, accept }, redirect: 'manual', signal: AbortSignal.timeout(20000) })
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null
    if (!loc) return { res, url: at }
    at = new URL(loc, at).toString()
    if (!/^https?:/.test(at)) throw new Error('redirect to a non-web address')
  }
  throw new Error('too many redirects')
}
