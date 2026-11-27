// Dry runs (Jason, 2026-11-25: "Let's set up a dry run mode so we can produce the artifacts a real run would produce
// but as test artifacts, never posted").
//
// A dry run is a real run with nothing let out: it reads the real network, fetches real articles under robots.txt
// and Content-Signal, and makes real (priced, capped) model calls. Every write to autonomist's repository and every
// post is captured instead of sent. The pipelines' own state (the day marked done, recent questions, passages used)
// goes to a scratch layer over KV, so the real bot never sees it; only the daily search count passes through, so the
// cap still holds. The model and the session use the real KV directly: spend is counted, and a refreshed session
// stays valid for the real bot.
//
// What a run produced is stored as an artifact (`dryrun:result:<id>`, two weeks): the steps and their timings, every
// record and post it would have written, the pages it would have published, the email subscribers would have got, the
// notes behind a digest, and the spend.
// The steward's page shows them; `node scripts/dry-run.mjs` fetches them as files.
//
// Two ways in: a request (`dryrun:request`, from the steward's page or the script), picked up by the next five-minute
// run; and BOT_DRY, which turns a scheduled pipeline into a daily dry run until it's taken out ("digest": the 13:07
// digest and its two feed questions become an artifact instead of being published).
import { runDigest } from './digest.js'
import { runQuestion } from './questions.js'
import { runDream } from './dream.js'
import { foldMemory } from './log.js'
import { runAcquaint } from './acquaint.js'
import { COLLECTION } from './journal.js'
import { entryHtml, fillShell } from '../journal-pages.js'
import { digestEmail, queueKey } from '../newsletter.js'

export const PIPELINES = ['digest', 'questions', 'dream', 'notes']

// Keys a dry run must not see, or it would stop where the real bot already finished today.
const HIDE = /^(journal:(done|pending|lock|attempts|announce|announce-claim|posted):|dream:done:|question:\d|questions:stories:|digest:day:|bot:dream:unfolded$|answered:|newsletter:)/
// Writes that must reach the real KV: the daily search count (the cap holds across dry and real runs).
const THROUGH = /^bot:searches:/

/** KV with a scratch layer: reads fall through to the real store unless hidden or overwritten; writes stay here. */
export function dryKV(kv, { hide = HIDE, through = THROUGH } = {}) {
  const over = new Map()
  const real = async (k, f) => (hide.test(k) ? null : f())
  return {
    over,
    async get(k, type) {
      if (over.has(k)) { const e = over.get(k); return !e ? null : type === 'json' ? JSON.parse(e.v) : e.v }
      return real(k, () => kv.get(k, type))
    },
    async getWithMetadata(k) {
      if (over.has(k)) { const e = over.get(k); return e ? { value: e.v, metadata: e.metadata ?? null } : { value: null, metadata: null } }
      return (await real(k, () => kv.getWithMetadata(k))) || { value: null, metadata: null }
    },
    async put(k, v, opts = {}) {
      if (through.test(k)) return kv.put(k, v, opts)
      over.set(k, { v: String(v), metadata: opts.metadata })
    },
    async delete(k) {
      if (through.test(k)) return kv.delete(k)
      over.set(k, null)
    },
    async list(opts = {}) {
      const page = await kv.list(opts)
      const keys = page.keys.filter((x) => !hide.test(x.name) && !(over.has(x.name) && over.get(x.name) === null))
      if (page.list_complete) {
        for (const [name, e] of over) if (e && name.startsWith(opts.prefix || '') && !keys.some((x) => x.name === name)) keys.push({ name, metadata: e.metadata })
      }
      return { ...page, keys }
    },
  }
}

/** The atproto client with every write captured: reads pass through; posts and record writes are kept, not sent. */
export function dryApi(api, captured) {
  let n = 0
  const fake = (collection) => ({ uri: `at://dry/${collection || 'post'}/${++n}`, cid: `dry${n}` })
  return {
    ...api,
    async call(method, nsid, opts = {}) {
      if (method === 'GET') return api.call(method, nsid, opts)
      const b = opts.body || {}
      captured.writes.push({ nsid, collection: b.collection, rkey: b.rkey, record: b.record })
      return fake(b.collection)
    },
    async post(p) {
      captured.posts.push({ text: p.text, card: p.card || null, quote: p.quote || null, reply: p.reply || null, lang: p.lang || 'en' })
      return fake('app.bsky.feed.post')
    },
    // an image a real run would store: kept in the artifact as a data URI under a stand-in CID, never uploaded
    async uploadBlob(bytes, mimeType) {
      // a stand-in CID in base32's alphabet (no 0, 1, 8 or 9), so the pages' CID check accepts it
      const cid = `bafkreidry${String(++n).padStart(4, '0').replace(/\d/g, (d) => 'abcdefghij'[d])}${'a'.repeat(40)}`
      // the artifact lives in KV (25 MB a value), with each image in a page and in the email: past 3 MB, refs only
      captured.imageBytes = (captured.imageBytes || 0) + bytes.length
      if (captured.imageBytes > 3_000_000) return { $type: 'blob', ref: { $link: cid }, mimeType, size: bytes.length }
      let bin = ''
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
      ;(captured.images ||= {})[cid] = `data:${mimeType};base64,${btoa(bin)}`
      return { $type: 'blob', ref: { $link: cid }, mimeType, size: bytes.length }
    },
  }
}

async function spend(kv, day) {
  let micros = 0, cursor
  do {
    const page = await kv.list({ prefix: `botspend:${day}:`, cursor })
    for (const k of page.keys) micros += Number(k.metadata?.micros || 0)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return micros / 1e6
}

/**
 * Runs the named pipelines dry and stores what they produced. `what` is a list or comma-separated string of
 * PIPELINES, or "all". `shell` is the journal page's shell (from the built site), for rendering pages as published.
 */
export async function runDry({ env, kv, api, model, what = 'digest,questions', now = new Date(), shell = '', fetch: f = fetch, id = `${now.toISOString().replace(/[:.]/g, '-')}` }) {
  const wants = new Set(what === 'all' ? PIPELINES : String(what).split(',').map((x) => x.trim()).filter((x) => PIPELINES.includes(x)))
  const day = now.toISOString().slice(0, 10)
  const dkv = dryKV(kv)
  const captured = { writes: [], posts: [] }
  const dapi = dryApi(api, captured)
  const steps = []
  const t0 = Date.now()
  const spentBefore = await spend(kv, day)
  const step = async (name, fn) => {
    const t = Date.now()
    try { steps.push({ name, ok: true, ms: Date.now() - t, result: await fn() }) } catch (e) { steps.push({ name, ok: false, ms: Date.now() - t, error: String(e?.message || e).slice(0, 400) }) }
    steps[steps.length - 1].ms = Date.now() - t
  }
  if (wants.has('digest')) await step('digest', () => runDigest({ env, kv: dkv, api: dapi, model, day, now: now.getTime(), fetch: f }))
  if (wants.has('questions')) {
    // both of the day's question slots, from the digest this run wrote (or none, if it didn't)
    for (const slot of [0, 1]) await step(`question ${slot + 1}`, () => runQuestion({ env: { ...env, BOT_QUESTION_HOURS_UTC: String(slot) }, kv: dkv, api: dapi, model, day, now: new Date(`${day}T0${slot}:30:00Z`) }))
  }
  if (wants.has('dream')) {
    await step('dream', () => runDream({ env: { ...env, BOT_DREAM_HOUR_UTC: '0' }, kv: dkv, api: dapi, model, day, now }))
    await step('memory', () => foldMemory({ kv: dkv, api: dapi, model }))
  }
  // every opted-in person's note as if a week had passed, so each is written; nothing is deleted in a dry run
  if (wants.has('notes')) await step('notes', () => runAcquaint({ env, kv: dkv, api: dapi, model, now: now.getTime() + 8 * 86400_000, fetch: f }))
  const origin = (env.PUBLIC_ORIGIN || 'https://autonomist.jason-edelman.org').replace(/\/$/, '')
  const pages = {}
  // images the run would have stored, shown from the artifact itself
  const drySrc = (cid) => captured.images?.[cid] || null
  for (const w of captured.writes) {
    if (w.collection !== COLLECTION || !w.record) continue
    const content = entryHtml(w.record, { uri: `at://dry/${COLLECTION}/${w.rkey}`, origin, src: drySrc })
    pages[w.rkey] = shell ? fillShell(shell, { title: `[dry run] ${w.record.title} · autonomist`, description: w.record.summary || '', content: `<p class="note">A dry run: nothing here was published or posted.</p>\n${content}` }) : content
  }
  // the email subscribers would have got: built from the queue the digest left in the scratch layer, never sent
  const queued = dkv.over.get(queueKey(day))
  const email = queued?.v ? (({ slug, uri, record }) => digestEmail({ ...record, slug }, { origin, uri, src: drySrc }))(JSON.parse(queued.v)) : null
  const digest = dkv.over.get(`digest:day:${day}`)
  const notes = digest?.v ? JSON.parse(digest.v).stories.map((s) => ({ label: s.label, sharers: s.sharers, articles: s.articles.map((a) => ({ url: a.url, title: a.title, outlet: a.outlet, gist: a.gist, quotes: a.quotes })) })) : null
  const artifact = {
    id,
    what: [...wants],
    day,
    at: now.toISOString(),
    ms: Date.now() - t0,
    spend: Math.round(((await spend(kv, day)) - spentBefore) * 1e4) / 1e4,
    steps,
    posts: captured.posts,
    writes: captured.writes,
    pages,
    email,
    notes,
  }
  await kv.put(`dryrun:result:${id}`, JSON.stringify(artifact), { expirationTtl: 14 * 86400 })
  const index = ((await kv.get('dryrun:index', 'json')) || []).filter((x) => x.id !== id)
  index.unshift({ id, at: artifact.at, what: artifact.what, ms: artifact.ms, spend: artifact.spend, posts: captured.posts.length, writes: captured.writes.length, email: Boolean(email), ok: steps.every((s) => s.ok) })
  await kv.put('dryrun:index', JSON.stringify(index.slice(0, 30)))
  return { dryRun: id, what: artifact.what, ms: artifact.ms, posts: captured.posts.length, writes: captured.writes.length, spend: artifact.spend }
}

/** A requested dry run, if one is waiting: taken once, and never two at a time. */
export async function maybeDryRun({ env, kv, api, model, now = new Date(), shell = '' }) {
  const req = await kv.get('dryrun:request', 'json')
  if (!req) return { none: true }
  if (await kv.get('dryrun:running')) return { waiting: 'a dry run is in progress' }
  await kv.delete('dryrun:request')
  await kv.put('dryrun:running', '1', { expirationTtl: 20 * 60 })
  try {
    return await runDry({ env, kv, api, model, what: req.what || 'digest,questions', now, shell })
  } finally {
    await kv.delete('dryrun:running').catch(() => {})
  }
}

/** BOT_DRY's daily dry run of a scheduled pipeline, once a day. */
export async function scheduledDry({ env, kv, api, model, what, now = new Date(), shell = '' }) {
  const key = `dryrun:scheduled:${now.toISOString().slice(0, 10)}:${what}`
  if (await kv.get(key)) return { skipped: 'already dry-run today' }
  await kv.put(key, 'pending', { expirationTtl: 3 * 86400 })
  const r = await runDry({ env, kv, api, model, what, now, shell })
  await kv.put(key, r.dryRun, { expirationTtl: 3 * 86400 })
  return { scheduled: true, ...r }
}
