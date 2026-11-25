// Dry runs (worker/bot/dry.js): real reading and real model calls, nothing let out. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryKV } from './helpers.mjs'
import { dryKV, dryApi, runDry, maybeDryRun, scheduledDry } from '../worker/bot/dry.js'
import { CLUSTER_SCHEMA, NOTE_SCHEMA, DIGEST_SCHEMA } from '../worker/bot/digest.js'
import { DIGEST_SECTIONS } from '../worker/journal-core.js'

test('dry KV: reads fall through, writes stay in the scratch layer, finished-today keys are hidden, searches count', async () => {
  const kv = memoryKV()
  await kv.put('journal:done:2026-11-25', 'real-slug')
  await kv.put('bot:memory', '{"text":"m"}')
  const d = dryKV(kv)
  assert.equal(await d.get('journal:done:2026-11-25'), null)
  assert.deepEqual(await d.get('bot:memory', 'json'), { text: 'm' })
  await d.put('questions:recent', '["q"]')
  await d.put('bot:searches:2026-11-25:x', '', { metadata: { n: 2 } })
  await d.delete('bot:memory')
  assert.equal(await kv.get('questions:recent'), null)
  assert.ok(kv.m.has('bot:searches:2026-11-25:x'))
  assert.equal(await d.get('bot:memory'), null)
  assert.equal(await kv.get('bot:memory'), '{"text":"m"}')
  await d.put('cand:new', '', { metadata: { u: 'x' } })
  const listed = (await d.list({ prefix: 'cand:' })).keys.map((k) => k.name)
  assert.deepEqual(listed, ['cand:new'])
})

test('dry API: reads pass through; posts and every write are captured, never sent', async () => {
  const sent = []
  const api = { session: async () => ({ did: 'did:plc:me' }), call: async (m, nsid) => { sent.push(nsid); return { records: [] } }, post: async () => { sent.push('post'); return {} }, pub: async () => ({}) }
  const captured = { writes: [], posts: [] }
  const d = dryApi(api, captured)
  await d.call('GET', 'com.atproto.repo.listRecords', { params: {} })
  const w = await d.call('POST', 'com.atproto.repo.putRecord', { body: { collection: 'c', rkey: 'r', record: { a: 1 } } })
  await d.call('POST', 'app.bsky.notification.updateSeen', { body: {} })
  const p = await d.post({ text: 'hello', card: { uri: 'https://x' } })
  assert.deepEqual(sent, ['com.atproto.repo.listRecords'])
  assert.equal(captured.writes.length, 2)
  assert.ok(w.uri.startsWith('at://dry/c/') && p.uri.startsWith('at://dry/'))
  assert.deepEqual(captured.posts[0], { text: 'hello', card: { uri: 'https://x' }, reply: null, lang: 'en' })
})

// a small network, real-looking pages, and a model that answers each kind of call
const filler = (n) => ' Renters in several cities are watching what happens next.'.repeat(n)
const PAGES = {
  'https://a.example/1': ['Council freezes rents', `“Tenants packed the chamber for six hours,” the paper said.${filler(40)}`],
  'https://b.example/2': ['Freeze passes late', `“The vote came after midnight,” an organizer said.${filler(40)}`],
  'https://c.example/3': ['Funds buy farmland', `“Land that could feed a town is now a portfolio line,” a farmer said.${filler(40)}`],
  'https://d.example/4': ['Tenants form a co-op', `“We decided to stop waiting for the landlord,” a resident said.${filler(40)}`],
}
const f = async (url) => {
  const u = String(url)
  if (u.endsWith('/robots.txt')) return new Response('', { status: 404 })
  const p = PAGES[u]
  return p ? new Response(`<html><head><meta property="og:title" content="${p[0]}"></head><body><article><p>${p[1]}</p></article></body></html>`, { headers: { 'content-type': 'text/html' } }) : new Response('', { status: 404 })
}
const body = DIGEST_SECTIONS.map((h, i) => `## ${h}\n\n${[
  'In the last day, 6 accounts that Jason Edelman follows shared 4 links.',
  `One paper heard “Tenants packed the chamber for six hours,” another “The vote came after midnight,” a farmer that “Land that could feed a town is now a portfolio line,” and residents “We decided to stop waiting for the landlord,” today.${filler(55)}`,
  `A freeze buys time, not ownership.${filler(5)}`,
  '- What courts will do.\n- Power Explained has taken no position on these stories.',
  'What would you and your neighbors do with a year of frozen rent?',
][i]}`).join('\n\n')
// different questions each time: a question that opens like a recent one is refused
const QUESTIONS = ['Who owns the land around where you live?', 'Which building on your block could its tenants buy?']
let asked = 0
const model = {
  structured: async ({ schema, user }) => {
    if (schema === CLUSTER_SCHEMA) return { data: { stories: [{ label: 'Rent freezes', items: [0, 1], relevance: 3 }, { label: 'Farmland', items: [2], relevance: 2 }, { label: 'A tenant co-op', items: [3], relevance: 3 }] } }
    if (schema === NOTE_SCHEMA) { const p = Object.values(PAGES).find((x) => user.includes(x[0])); return { data: { gist: `About ${p[0]}.`, quotes: [p[1].match(/“([^”]+)”/)[1]], themes: [] } } }
    if (schema === DIGEST_SCHEMA) return { data: { title: 'Rents frozen, land sold', summary: 'S.', question: 'What would you and your neighbors do with a year of frozen rent?', body, claims_to_check: [], reflection: '', themes: [] } }
    if (schema.properties?.framing) return { data: { framing: 'Residents and a farmer both told papers about who owns what.', question: QUESTIONS[asked++ % QUESTIONS.length], reflection: '', themes: [] } }
    throw new Error('unexpected')
  },
}
async function network(kv, now) {
  let i = 0
  for (const [u, [t]] of Object.entries(PAGES)) await kv.put(`cand:${++i}`, '', { metadata: { u, t, at: new Date(now - i * 60e3).toISOString(), s: [`p${i}`, `p${i + 1}`] } })
  // a fifth link, shared once, that no story takes up (a digest wants at least five links)
  await kv.put('cand:9', '', { metadata: { u: 'https://e.example/5', t: 'A recipe for soup', at: new Date(now - 9 * 60e3).toISOString(), s: ['p9'] } })
}

test('dry run: the digest and its questions, as they would be published, with nothing let out and real state untouched', async () => {
  const kv = memoryKV()
  const now = new Date('2026-11-25T14:00:00Z')
  await network(kv, now.getTime())
  await kv.put('journal:done:2026-11-25', 'the-real-one') // the real bot already published today
  await kv.put('journal:posted:2026-11-25', 'at://did:plc:me/app.bsky.feed.post/real') // and posted it
  const sent = []
  const api = { session: async () => ({ did: 'did:plc:me' }), call: async (m, nsid) => { if (m !== 'GET') sent.push(nsid); return { records: [] } }, post: async () => { sent.push('post'); return {} }, pub: async () => ({}) }
  const realKeys = new Set(kv.m.keys())
  const r = await runDry({ env: {}, kv, api, model: { ...model, structured: (o) => model.structured(o) }, what: 'digest,questions', now, shell: '<html><title>{{journal:title}}</title><!--journal:content--></html>', fetch: f })
  assert.deepEqual(sent, [])
  const a = JSON.parse(kv.m.get(`dryrun:result:${r.dryRun}`).v)
  assert.equal(a.steps.length, 3)
  assert.ok(a.steps.every((s) => s.ok), JSON.stringify(a.steps))
  assert.equal(a.posts.length, 3) // the digest's announcement and two feed questions
  assert.ok(a.posts[0].text.includes("From today's digest"))
  const page = Object.values(a.pages)[0]
  assert.ok(page.includes('[dry run] Rents frozen, land sold') && page.includes('nothing here was published') && page.includes('What the network shared'))
  assert.equal(a.notes[0].label, 'Rent freezes')
  // the email subscribers would have got, built from the scratch layer's queue and never sent (nothing reached Resend)
  assert.equal(a.email.subject, 'Rents frozen, land sold')
  assert.ok(a.email.html.includes('{{{RESEND_UNSUBSCRIBE_URL}}}') && a.email.text.includes('What the network shared'.toUpperCase()))
  // the real KV gained only the artifact and its index: no day marked done, no recent questions, no covered links
  const added = [...kv.m.keys()].filter((k) => !realKeys.has(k)).sort()
  assert.deepEqual(added, ['dryrun:index', `dryrun:result:${r.dryRun}`])
  assert.equal(await kv.get('site:question'), null) // the front page's question is the real one's, never a dry run's
  assert.equal(await kv.get('journal:done:2026-11-25'), 'the-real-one')
})

test('dry run: a request is taken once, and the scheduled dry digest runs once a day', async () => {
  const kv = memoryKV()
  const now = new Date('2026-11-25T14:00:00Z')
  await network(kv, now.getTime())
  const api = { session: async () => ({ did: 'did:plc:me' }), call: async () => ({ records: [] }), post: async () => ({}), pub: async () => ({}) }
  assert.deepEqual(await maybeDryRun({ env: {}, kv, api, model, now }), { none: true })
  await kv.put('dryrun:request', JSON.stringify({ what: 'notes' }))
  const r = await maybeDryRun({ env: {}, kv, api, model, now })
  assert.deepEqual(r.what, ['notes'])
  assert.equal(await kv.get('dryrun:request'), null)
  assert.equal(await kv.get('dryrun:running'), null)
  const s1 = await scheduledDry({ env: {}, kv, api, model, what: 'notes', now })
  assert.ok(s1.scheduled)
  assert.deepEqual(await scheduledDry({ env: {}, kv, api, model, what: 'notes', now }), { skipped: 'already dry-run today' })
})
