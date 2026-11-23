#!/usr/bin/env node
// Checks autonomist's news journal (content/journal/*.md).
//
//   node scripts/journal-check.mjs            the shape of every entry: fields, sections, quotes (no network)
//   node scripts/journal-check.mjs --fetch    also fetches each entry's sources and checks every quoted passage
//   node scripts/journal-check.mjs --can <url>...   say whether robots.txt and Content-Signal let autonomist read a URL
//
// The rule it enforces: text in curly double quotes (“…”) is verbatim from a source the entry lists under `sources:`.
// Use curly quotes for nothing else. A source closed by robots.txt or by Content-Signal ai-input=no is never fetched.
// The robots and text helpers follow the research watch's (jedelman/jason-edelman.org, research-watch/lib.mjs).
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const AGENT = 'autonomist'
export const UA = `Mozilla/5.0 (compatible; ${AGENT}/1.0; +https://autonomist.jason-edelman.org/journal/)`
export const SECTIONS = ['What it says', 'Through Power Explained', 'What it means for the federation', "What we don't know", 'A question to take to your neighbors']
const REQUIRED = ['title', 'summary', 'date', 'outlet', 'headline', 'source', 'sources', 'written']

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
export const extractQuotes = (body) => [...body.matchAll(/“([^”]+)”/g)].map((m) => m[1].replace(/[.,;:]+$/, '').trim()).filter(Boolean)

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

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' }
export function htmlToText(html) {
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
}

/** The shape of one entry. Returns a list of problems (empty when it's sound). */
export function checkEntry(name, src) {
  const problems = []
  const { meta, body } = frontMatter(src)
  for (const k of REQUIRED) if (!meta[k]) problems.push(`missing ${k}:`)
  if (meta.date && !/^\d{4}-\d{2}-\d{2}$/.test(meta.date)) problems.push('date: must be YYYY-MM-DD')
  if (meta.date && !name.startsWith(meta.date)) problems.push('the file name must start with the date')
  const sources = (meta.sources || '').split(/\s+/).filter(Boolean)
  for (const u of sources) if (!/^https:\/\/\S+$/.test(u)) problems.push(`sources: not an https URL: ${u}`)
  if (meta.source && !sources.includes(meta.source)) problems.push('sources: must include the source')
  for (const s of SECTIONS) if (!body.includes(`\n## ${s}\n`)) problems.push(`missing section: ## ${s}`)
  if (extractQuotes(body).length === 0) problems.push('no quoted passages: quote the source at least once')
  return problems
}

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

const robotsCache = new Map()
async function canRead(url) {
  const { origin } = new URL(url)
  if (!robotsCache.has(origin)) {
    let txt = ''
    try {
      const r = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(20000) })
      if (r.ok) txt = await r.text()
    } catch {}
    robotsCache.set(origin, parseRobots(txt))
  }
  return robotsDecision(robotsCache.get(origin), url)
}

async function sourceText(url) {
  const can = await canRead(url)
  if (!can.ok) return { url, closed: can.why, text: '' }
  const r = await fetch(url, { headers: { 'user-agent': UA }, redirect: 'follow', signal: AbortSignal.timeout(30000) })
  if (!r.ok) return { url, closed: `HTTP ${r.status}`, text: '' }
  return { url, text: normalize(htmlToText(await r.text())) }
}

async function main() {
  const args = process.argv.slice(2)
  if (args[0] === '--can') {
    let closed = false
    for (const url of args.slice(1)) {
      const r = await canRead(url)
      console.log(`${r.ok ? 'ok    ' : 'closed'} ${url}  (${r.why})`)
      closed ||= !r.ok
    }
    process.exit(closed ? 1 : 0)
  }
  const dir = join(root, 'content/journal')
  let failed = false
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md')).sort()) {
    const src = readFileSync(join(dir, name), 'utf8')
    const problems = checkEntry(name, src)
    if (args.includes('--fetch') && problems.length === 0) {
      const { meta, body } = frontMatter(src)
      const texts = await Promise.all(meta.sources.split(/\s+/).map(sourceText))
      for (const t of texts) if (t.closed) console.log(`  ${name}: source not read (${t.closed}): ${t.url}`)
      for (const q of extractQuotes(body)) {
        const hit = texts.find((t) => t.text.includes(normalize(q)))
        if (hit) console.log(`  ok  “${q.slice(0, 70)}${q.length > 70 ? '…' : ''}”  ← ${new URL(hit.url).hostname}${new URL(hit.url).pathname}`)
        else problems.push(`quote not found in any source: “${q}”`)
      }
    }
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name}`)
    for (const p of problems) console.log(`  - ${p}`)
    failed ||= problems.length > 0
  }
  process.exit(failed ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`journal-check: ${e.message}`); process.exit(1) })
