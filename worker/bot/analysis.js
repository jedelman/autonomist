// The digest's analysis (Jason, 2026-11-27: "I'd love to have autonomist contribute some kind of analysis within the
// synthesis step"; his picks: a power map, and threads over time).
//
// The power map is written in the synthesis call, as structured data: for each common thread, who holds the power,
// what's at stake, who bears the cost, and which way it moves. Every row cites a passage that code finds, word for
// word, in an article autonomist read; a row that fails is dropped, and the map is shown only with two rows or more.
//
// Threads over time: the clustering call tags each story with one theme from a fixed list. The counts are code's: for
// each theme and each of the last 30 days, how many people shared stories on it. A theme is a label, never a figure.
import { normalize, numberIn, extractNumbers, hasControlChars } from '../journal-core.js'
import { graphemes } from './text.js'
import { obj } from './model.js'

/** The themes a story can carry. Change the list and the chart's history keeps the old names until they age out. */
export const THEMES = ['housing', 'land and development', 'labor and work', 'public money', 'policing and surveillance', 'immigration', 'climate and energy', 'health and care', 'democracy and elections', 'courts and rights', 'tech and platforms', 'war and foreign affairs', 'media and information', 'other']
export const cleanTheme = (t) => (THEMES.includes(String(t || '').toLowerCase().trim()) ? String(t).toLowerCase().trim() : 'other')

export const DIRECTIONS = ['toward enclosure', 'contested', 'toward the commons']
export const POWER_MAP_SCHEMA = {
  type: 'array',
  items: obj({
    thread: { type: 'string' },
    holds: { type: 'string' },
    at_stake: { type: 'string' },
    bears_cost: { type: 'string' },
    direction: { type: 'string', enum: DIRECTIONS },
    evidence: { type: 'array', items: obj({ tag: { type: 'string' }, quote: { type: 'string' } }) },
  }),
}

export const POWER_MAP_RULES = `Also give power_map: one row for each common thread, two to four rows, each read through Power Explained. For each row:
- thread: the thread, in a few words.
- holds: who holds the power in it: the institutions, offices, companies or officials the articles name. A who, never a law, a bill or a document (name who wields it). Never a private person.
- at_stake: what's at stake: the resource, the decision or the right.
- bears_cost: who bears the cost.
- direction: which way the thread moves: "toward enclosure" (value or control going to private ownership or an unaccountable few), "toward the commons" (governed collectively by the people who use it), or "contested" (it could go either way, or the articles disagree).
- evidence: one or two passages that show the power, the stake or the cost (not passages that only mention the topic), each copied exactly from the article you tag (A1, A2 and so on), 4 to 40 words, without quotation marks.
Each field under 100 characters, plain words: no quotation marks, links, handles, or figures that aren't in the articles. A program drops any row whose evidence isn't in the article it tags.`

/** Checks the power map against the articles read. Returns the rows to publish (none unless two pass) and the problems. */
export function checkPowerMap(rows, { articles }) {
  const problems = [], kept = []
  const pages = articles.map((a) => normalize(`${a.title}\n${a.text}`))
  for (const [i, r] of (Array.isArray(rows) ? rows : []).slice(0, 4).entries()) {
    const f = { thread: r?.thread, holds: r?.holds, atStake: r?.at_stake, bearsCost: r?.bears_cost }
    for (const k of Object.keys(f)) f[k] = String(f[k] || '').replace(/\s+/g, ' ').trim()
    const text = Object.values(f).join('\n')
    const bad = []
    if (Object.values(f).some((x) => !x || graphemes(x) > 100)) bad.push('every field is required, under 100 characters')
    if (/["“”«»„]|https?:|www\.|(^|\s)@[a-z0-9-]+\./i.test(text)) bad.push('no quotation marks, links or handles in the fields')
    if (hasControlChars(text)) bad.push('no control characters')
    for (const n of extractNumbers(text)) if (!pages.some((p) => numberIn(n, p))) bad.push(`figure not in any article: ${n}`)
    const direction = DIRECTIONS.includes(r?.direction) ? r.direction : null
    if (!direction) bad.push(`direction must be one of: ${DIRECTIONS.join(', ')}`)
    const evidence = []
    for (const e of (Array.isArray(r?.evidence) ? r.evidence : []).slice(0, 2)) {
      const m = String(e?.tag || '').trim().match(/^A(\d{1,3})$/i)
      const k = m ? Number(m[1]) - 1 : -1
      const a = articles[k]
      const q = String(e?.quote || '').replace(/\s+/g, ' ').trim().replace(/^[“"‘']+|[”"’']+$/g, '')
      const words = q.split(' ').filter(Boolean).length
      if (!a) bad.push(`evidence tags no article read: ${String(e?.tag || '').slice(0, 10)}`)
      else if (words < 4 || words > 40) bad.push('each evidence passage is 4 to 40 words')
      else if (!pages[k].includes(normalize(q))) bad.push(`evidence not in ${e.tag}: “${q.slice(0, 80)}”`)
      else evidence.push({ url: a.url, outlet: String(a.outlet || '').slice(0, 80), quote: q })
    }
    if (!evidence.length) bad.push('cite at least one passage from an article read')
    if (bad.length) problems.push(...bad.map((b) => `power map row ${i + 1}: ${b}`))
    else kept.push({ ...f, direction, evidence })
  }
  if (!Array.isArray(rows) || rows.length < 2) problems.push('power map: two to four rows')
  return { rows: kept.length >= 2 ? kept : [], problems }
}

const DAY = 86400_000
const dateBack = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) - n * DAY).toISOString().slice(0, 10)

/**
 * Threads over time, by code: for each theme, how many people shared stories on it each day of the window ending
 * `day`. `digests` are earlier digests ({ date, stories: [{ theme, sharers }] }); today's stories are added. Days with
 * no digest carrying themes are listed apart (`covered` holds the rest), so a gap reads as "no data", never as zero.
 */
export function computeTrend({ day, stories, digests = [], days = 30 }) {
  const dates = Array.from({ length: days }, (_, i) => dateBack(day, days - 1 - i))
  const byDate = new Map()
  const add = (date, list) => {
    if (!dates.includes(date) || !list?.some((s) => s?.theme)) return
    const m = new Map()
    for (const s of list) {
      if (!s?.theme) continue
      const t = cleanTheme(s.theme)
      m.set(t, (m.get(t) || 0) + Math.max(0, Math.round(Number(s.sharers) || 0)))
    }
    byDate.set(date, m)
  }
  for (const d of digests) if (d?.date !== day) add(d?.date, d?.stories)
  add(day, stories)
  const rows = THEMES.map((theme) => ({ theme, values: dates.map((d) => byDate.get(d)?.get(theme) || 0) }))
    .filter((r) => r.values.some((v) => v > 0))
    .sort((a, b) => (a.theme === 'other') - (b.theme === 'other') || sum(b.values) - sum(a.values) || present(b.values) - present(a.values))
  return { end: day, days, covered: dates.filter((d) => byDate.has(d)), rows }
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0)
const present = (xs) => xs.filter((x) => x > 0).length

/** The earlier digests in autonomist's repository, newest first, as computeTrend reads them. */
export async function earlierDigests(api, did, collection, { day, days = 30 } = {}) {
  const since = dateBack(day, days)
  const out = []
  let cursor
  for (let page = 0; page < 3; page++) {
    const r = await api.call('GET', 'com.atproto.repo.listRecords', { params: { repo: did, collection, limit: 100, cursor } })
    for (const rec of r.records || []) {
      const v = rec.value || {}
      if (v.kind === 'digest' && v.date >= since && v.date < day) out.push({ date: v.date, stories: (v.network?.stories || []).map((s) => ({ theme: s.theme, sharers: s.sharers })) })
    }
    cursor = r.cursor
    const oldest = (r.records || []).map((x) => x.value?.date).filter(Boolean).sort()[0]
    if (!cursor || (oldest && oldest < since)) break
  }
  return out
}
