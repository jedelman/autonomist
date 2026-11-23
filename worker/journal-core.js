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
    const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*content=["']([^"']*)["']`, 'i')
    const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${name}["']`, 'i')
    const m = s.match(re1) || s.match(re2)
    return m ? decodeEntities(m[1]).trim() : ''
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

/** Figures in a text: anything with two or more digits (single digits are everywhere and prove nothing). */
export const extractNumbers = (text) => [...new Set([...String(text).matchAll(/\d[\d,.]*\d/g)].map((m) => m[0].replace(/[.,]+$/, '')))]

/** Whether a figure appears in a normalized source text, written with or without thousands separators. */
export function numberIn(num, normText) {
  if (normText.includes(num)) return true
  const bare = num.replace(/,/g, '')
  if (normText.includes(bare)) return true
  const withCommas = bare.replace(/^(\d+)(\.\d+)?$/, (_, i, f = '') => i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + f)
  return normText.includes(withCommas)
}

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
    if (/^(19|20)\d\d$/.test(n) && texts.some((t) => t.includes(n))) { numbers.push(n); continue }
    if (texts.some((t) => numberIn(n, t))) numbers.push(n)
    else problems.push(`figure not found in any source: ${n}`)
  }
  for (const m of String(body).matchAll(/https?:\/\/[^\s)<>"]+/g)) {
    const u = m[0].replace(/[.,;:]+$/, '')
    if (!allowedLinks.some((a) => u === a || u.startsWith(a))) problems.push(`link not allowed: ${u}`)
  }
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
    let txt = ''
    try {
      const r = await f(`${origin}/robots.txt`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(15000) })
      if (r.ok) txt = await r.text()
    } catch {}
    cache.set(origin, parseRobots(txt))
  }
  return robotsDecision(cache.get(origin), url)
}
