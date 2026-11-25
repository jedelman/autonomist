// The day's question on the site, linked to its post on Bluesky (Jason, 2026-11-25: "how cool would it be to have the
// daily question on the site and linked to the bluesky post for discussion?"). No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { strictKV, memoryKV } from './helpers.mjs'
import { announce } from '../worker/bot/journal.js'
import { questionHtml, postUrl, entryHtml, QUESTION_KEY, postKey } from '../worker/journal-pages.js'
import { digestEmail } from '../worker/newsletter.js'
import worker from '../worker/index.js'

const DID = 'did:plc:kmswr7d5c55rc4ot2dbn6sfq'
const URI = `at://${DID}/app.bsky.feed.post/3n35a726o32un`
const A = { slug: '2026-11-25-rents', url: 'https://autonomist.test/journal/2026-11-25-rents/', title: 'Rents frozen', summary: 's', question: 'Who owns the land around where you live?', kind: 'digest' }

async function announced(kv, a = A) {
  await kv.put('journal:announce:2026-11-25', JSON.stringify(a))
  kv.clock.t += 60_000 // queued by finishPublish earlier in the run
}

test('announce: posts once, and writes the post, its thread and the day’s question, each key once', async () => {
  const kv = strictKV()
  await announced(kv)
  const posts = []
  const api = { post: async (p) => { posts.push(p); return { uri: URI, cid: 'c' } } }
  assert.deepEqual(await announce({ kv, api, day: '2026-11-25' }), { announced: URI })
  assert.equal(posts.length, 1)
  assert.ok(posts[0].text.startsWith(A.question))
  assert.equal(await kv.get('journal:posted:2026-11-25'), URI)
  assert.equal(await kv.get(postKey(A.slug)), URI)
  assert.deepEqual(await kv.get(QUESTION_KEY, 'json'), { question: A.question, title: A.title, slug: A.slug, kind: 'digest', date: '2026-11-25', post: URI })
  assert.ok(await kv.get(`journal:root:${URI}`))
  // the next run: already posted, nothing more
  kv.clock.t += 3_600_000
  assert.deepEqual(await announce({ kv, api, day: '2026-11-25' }), { announced: URI })
  assert.equal(posts.length, 1)
})

test('announce: a failed post releases its claim (after KV’s second) so the next run posts; an old-style record is left alone', async () => {
  const kv = strictKV()
  await announced(kv)
  const sleep = async (ms) => { kv.clock.t += ms }
  await assert.rejects(announce({ kv, api: { post: async () => { throw new Error('pds down') } }, day: '2026-11-25', sleep }), /pds down/)
  assert.equal(await kv.get('journal:announce-claim:2026-11-25'), null)
  kv.clock.t += 3_600_000
  assert.deepEqual(await announce({ kv, api: { post: async () => ({ uri: URI, cid: 'c' }) }, day: '2026-11-25', sleep }), { announced: URI })
  // a claim with no post (a run cut short mid-post) never posts again
  const kv2 = strictKV()
  await announced(kv2)
  await kv2.put('journal:announce-claim:2026-11-25', '1')
  assert.equal((await announce({ kv: kv2, api: { post: async () => assert.fail('posted twice') }, day: '2026-11-25' })).announced, null)
  // announced before this change: the post was kept on the announcement itself
  const kv3 = memoryKV()
  await kv3.put('journal:announce:2026-11-25', JSON.stringify({ ...A, claimed: true, post: URI }))
  assert.deepEqual(await announce({ kv: kv3, api: { post: async () => assert.fail('posted twice') }, day: '2026-11-25' }), { announced: URI })
})

test('the question’s HTML: escaped, linked to its entry and its thread by DID, and nothing without a real post', () => {
  assert.equal(postUrl(URI), `https://bsky.app/profile/${DID}/post/3n35a726o32un`)
  assert.equal(postUrl('at://dry/app.bsky.feed.post/1'), null)
  assert.equal(postUrl('https://evil.example/'), null)
  const h = questionHtml({ question: 'Who decides <what> gets built?', slug: A.slug, kind: 'digest', date: '2026-11-25', post: URI })
  assert.ok(h.includes('Who decides &lt;what&gt; gets built?'))
  assert.ok(h.includes(`href="https://bsky.app/profile/${DID}/post/3n35a726o32un"`))
  assert.ok(h.includes('href="/journal/2026-11-25-rents/"') && h.includes('digest of November 25'))
  assert.ok(!/[“”]/.test(h), 'curly quotes mean a verbatim quotation on this site; a question is not one')
  for (const bad of [null, {}, { question: 'Q?', slug: A.slug, date: '2026-11-25', post: 'at://dry/app.bsky.feed.post/1' }, { question: 'Q?', slug: '../x', date: '2026-11-25', post: URI }]) assert.equal(questionHtml(bad), '')
})

test('the entry’s page and the email link to the thread when there is one', () => {
  const rec = { kind: 'digest', title: 'T', date: '2026-11-25', body: '## A question to take to your neighbors\n\nWho owns it?', network: {}, sources: [] }
  const url = `https://bsky.app/profile/${DID}/post/3n35a726o32un`
  assert.ok(entryHtml(rec, { uri: 'at://x', origin: 'https://autonomist.test', post: URI }).includes(`href="${url}"`))
  assert.ok(!entryHtml(rec, { uri: 'at://x', origin: 'https://autonomist.test' }).includes('Talk it over'))
  assert.ok(entryHtml({ ...rec, kind: undefined, source: 'https://a.example/' }, { uri: 'at://x', origin: 'https://autonomist.test', post: URI }).includes(`href="${url}"`))
  const m = digestEmail({ ...rec, slug: 's' }, { origin: 'https://autonomist.test', post: URI })
  assert.ok(m.html.includes(`href="${url}"`) && m.text.includes(url))
  assert.ok(digestEmail({ ...rec, slug: 's' }, { origin: 'https://autonomist.test' }).html.includes('@autonomist.jason-edelman.org'))
})

test('the front page: the question in its slot, or the slot gone; the page keeps the site’s CSP', async () => {
  const O = 'https://autonomist.test'
  const page = '<!doctype html><main><h1>autonomist</h1><div class="slot-question"></div><p>more</p></main>'
  const ASSETS = { fetch: async () => new Response(page, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }) }
  const call = (env) => worker.fetch(new Request(`${O}/`), env, { waitUntil() {} })
  const kv = memoryKV()
  const empty = await call({ KV: kv, ASSETS })
  const e = await empty.text()
  assert.ok(!e.includes('slot-question') && !e.includes('class="question"'))
  assert.match(empty.headers.get('Content-Security-Policy'), /script-src 'self'/)
  await kv.put(QUESTION_KEY, JSON.stringify({ question: 'Who owns the land around where you live?', slug: A.slug, kind: 'digest', date: '2026-11-25', post: URI }))
  const full = await (await call({ KV: kv, ASSETS })).text()
  assert.ok(full.includes('Who owns the land around where you live?') && full.includes(`https://bsky.app/profile/${DID}/post/`))
  assert.ok(full.indexOf('class="question"') < full.indexOf('<p>more</p>'))
})
