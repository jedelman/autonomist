#!/usr/bin/env node
// Checks autonomist's news journal (content/journal/*.md) and the Power Explained passages it may quote.
//
//   node scripts/journal-check.mjs              the shape of every entry: fields, sections, quotes (no network)
//   node scripts/journal-check.mjs --fetch      also fetches each entry's sources: every quotation verbatim, every figure present
//   node scripts/journal-check.mjs --framework  checks worker/bot/framework.js passage by passage against the live pages
//   node scripts/journal-check.mjs --can <url>...   say whether robots.txt and Content-Signal let autonomist read a URL
//
// The helpers live in worker/journal-core.js, shared with the bot's daily writer.
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UA, SECTIONS, frontMatter, extractQuotes, normalize, htmlToText, checkSections, verifyBody, parseRobots, robotsDecision, canRead } from '../worker/journal-core.js'
import { FRAMEWORK } from '../worker/bot/framework.js'

export { SECTIONS, frontMatter, extractQuotes, normalize, htmlToText, parseRobots, robotsDecision }

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REQUIRED = ['title', 'summary', 'date', 'outlet', 'headline', 'source', 'sources', 'written']

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
  problems.push(...checkSections(`\n${body}`))
  if (extractQuotes(body).length === 0) problems.push('no quoted passages: quote the source at least once')
  return problems
}

const cache = new Map()
async function sourceText(url) {
  const can = await canRead(url, { cache })
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
      const r = await canRead(url, { cache })
      console.log(`${r.ok ? 'ok    ' : 'closed'} ${url}  (${r.why})`)
      closed ||= !r.ok
    }
    process.exit(closed ? 1 : 0)
  }
  if (args[0] === '--framework') {
    const pages = new Map()
    let failed = false
    for (const p of FRAMEWORK) {
      if (!pages.has(p.url)) pages.set(p.url, await sourceText(p.url))
      const ok = pages.get(p.url).text.includes(normalize(p.text))
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${new URL(p.url).pathname}  ${p.text.slice(0, 70)}${p.text.length > 70 ? '…' : ''}`)
      failed ||= !ok
    }
    process.exit(failed ? 1 : 0)
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
      const prose = body.replace(/<p class="byline">[\s\S]*?<\/p>/, '').replace(/<p class="muted">[\s\S]*?<\/p>/, '')
      const v = verifyBody(prose, texts.map((t) => t.text), { allowedLinks: meta.sources.split(/\s+/) })
      for (const q of v.quotes) console.log(`  ok  “${q.slice(0, 70)}${q.length > 70 ? '…' : ''}”`)
      if (v.numbers.length) console.log(`  ok  figures: ${v.numbers.join(', ')}`)
      problems.push(...v.problems)
    }
    console.log(`${problems.length ? 'FAIL' : 'ok  '} ${name}`)
    for (const p of problems) console.log(`  - ${p}`)
    failed ||= problems.length > 0
  }
  process.exit(failed ? 1 : 0)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`journal-check: ${e.message}`); process.exit(1) })
