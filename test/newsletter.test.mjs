// The digest by email (worker/newsletter.js), through Resend. No network: Resend is a fake that records each call.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryKV, strictKV, assets } from './helpers.mjs'
import { digestEmail, styleEmail, plainText, subscribe, confirm, sendNewsletter, previewToSteward, queueKey, newsletterReady, inboxOf, UNSUBSCRIBE } from '../worker/newsletter.js'
import { finishPublish } from '../worker/bot/digest.js'
import { sha256hex } from '../worker/invites.js'
import worker from '../worker/index.js'

const env = (extra = {}) => ({ KV: strictKV(), IP_SALT: 'salt', RESEND_API_KEY: 're_test', RESEND_SEGMENT_ID: 'seg-1', NEWSLETTER_FROM: 'autonomist <digest@example.org>', PUBLIC_ORIGIN: 'https://autonomist.test', ...extra })
const noSleep = async () => {}

/** A fake Resend: answers by method and path, and keeps every call. */
function fakeResend(routes = {}) {
  const calls = []
  const f = async (url, init = {}) => {
    const u = new URL(String(url))
    const call = { method: init.method || 'GET', path: u.pathname, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const key = `${call.method} ${call.path}`
    const route = routes[key] ?? Object.entries(routes).find(([k]) => new RegExp(`^${k}$`).test(key))?.[1]
    const [status, data] = typeof route === 'function' ? route(call) : route || [200, { id: 'x' }]
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } })
  }
  return { f, calls }
}

const RECORD = {
  $type: 'org.jason-edelman.autonomist.journal',
  kind: 'digest',
  title: 'Rents frozen, land sold {{contact.email}}',
  summary: 'What the network read today.',
  question: 'Who owns the land around you?',
  body: '## What the network is reading\n\nIn the last day, 6 accounts shared 4 links.\n\n## The common threads\n\nOne paper heard “Tenants packed the chamber for six hours,” and **another** “The vote came after midnight.” See [the framework](https://power-explained.jason-edelman.org/start-here). {{{RESEND_UNSUBSCRIBE_URL}}} <script>alert(1)</script>\n\n## A question to take to your neighbors\n\nWho owns the land around you?',
  date: '2026-11-25',
  network: { links: 4, accounts: 6, read: 2, closed: 1, stories: [{ label: 'Rent freezes', sharers: 3, articles: [{ url: 'https://a.example/1', title: 'Council freezes rents', outlet: 'a.example' }] }] },
  sources: ['https://a.example/1', 'https://power-explained.jason-edelman.org/start-here'],
  checks: { quotes: 2, figures: 2, articlesQuoted: 2, claims: [{ claim: 'The council froze rents.', verdict: 'confirmed', sources: [{ url: 'https://c.example/x', stance: 'supports', quote: 'froze rents' }] }] },
}

test('the email: the page’s own words, inline styles, a text part, one unsubscribe link, no template tags from content', () => {
  const m = digestEmail({ ...RECORD, slug: '2026-11-25-rents' }, { origin: 'https://autonomist.test', uri: 'at://did:plc:me/org.jason-edelman.autonomist.journal/2026-11-25-rents' })
  assert.ok(m.subject.startsWith('Rents frozen, land sold'))
  assert.ok(!m.subject.includes('{{'))
  for (const part of [m.html, m.text]) {
    // the one real placeholder is Resend's, in the footer; the body's copy and the title's tag are broken up
    assert.equal(part.split(UNSUBSCRIBE).length - 1, 1, part.slice(-400))
    assert.ok(!/\{\{(?!\{RESEND_UNSUBSCRIBE_URL\}\}\})/.test(part.replace(UNSUBSCRIBE, '')))
  }
  assert.ok(!m.html.includes('<script'))
  assert.ok(m.html.includes('&lt;script&gt;'))
  assert.ok(!/\sclass=/.test(m.html), 'classes are replaced by inline styles')
  assert.match(m.html, /<h2 style="[^"]+">The common threads<\/h2>/)
  assert.ok(m.html.includes('href="https://power-explained.jason-edelman.org/start-here"'))
  assert.ok(m.html.includes('What the network shared') && m.html.includes('https://a.example/1'))
  assert.ok(m.html.includes('Checked against other sources') && m.html.includes('The council froze rents.'))
  assert.ok(m.html.includes('https://autonomist.test/journal/2026-11-25-rents/'))
  assert.ok(m.html.includes('public-interest project') && m.html.includes('sells nothing'))
  assert.ok(m.html.includes('What the network read today.'), 'the summary is the preheader')
  assert.ok(m.text.includes('THE COMMON THREADS') && m.text.includes('the framework (https://power-explained.jason-edelman.org/start-here)'))
  assert.ok(m.text.includes('Council freezes rents (a.example): https://a.example/1'))
  assert.ok(m.text.includes('- The council froze rents.: confirmed'))
  assert.ok(!m.text.includes('**'))
})

test('styleEmail keeps attributes, drops classes and ids, and mutes what the page mutes', () => {
  assert.equal(styleEmail('<a href="https://x.example" rel="noopener">x</a>'), '<a href="https://x.example" rel="noopener" style="color:#1f5f8b;text-decoration:underline">x</a>')
  assert.match(styleEmail('<p class="muted" id="a">m</p>'), /^<p style="margin:0 0 14px;color:#6b675e;font-size:14px">m<\/p>$/)
  assert.equal(styleEmail('<strong>b</strong>'), '<strong>b</strong>')
  assert.equal(plainText('## Head\n\n**b** and *i* and [l](https://u.example)'), 'HEAD\n\nb and i and l (https://u.example)')
})

test('sign-up: off without config; the honeypot and a bad address send nothing', async () => {
  const { f, calls } = fakeResend()
  assert.equal((await subscribe({ env: env({ RESEND_API_KEY: '' }), body: { email: 'a@b.org' }, visitor: 'v', fetch: f, sleep: noSleep })).status, 503)
  assert.equal(newsletterReady(env({ NEWSLETTER_FROM: '' })), false)
  const e = env()
  assert.equal((await subscribe({ env: e, body: { email: 'a@b.org', website: 'spam' }, visitor: 'v', fetch: f, sleep: noSleep })).status, 200)
  assert.equal((await subscribe({ env: e, body: { email: 'not an address' }, visitor: 'v', fetch: f, sleep: noSleep })).status, 400)
  assert.equal(calls.length, 0)
  assert.equal([...e.KV.m.keys()].filter((k) => k.startsWith('nl:pending:')).length, 0)
})

test('sign-up: one confirmation, with the token only in the link’s fragment; asking again sends nothing and says the same', async () => {
  const { f, calls } = fakeResend({ 'POST /emails': [200, { id: 'em-1' }] })
  const e = env()
  const r = await subscribe({ env: e, body: { email: ' A@B.org ' }, visitor: 'v', fetch: f, sleep: noSleep })
  assert.equal(r.status, 200)
  assert.equal(calls.length, 1)
  const c = calls[0]
  assert.deepEqual(c.body.to, ['a@b.org'])
  assert.equal(c.body.from, 'autonomist <digest@example.org>')
  assert.equal(c.headers.Authorization, 'Bearer re_test')
  assert.ok(c.headers['User-Agent'])
  assert.ok(c.headers['Idempotency-Key'].startsWith('confirm/'))
  const t = c.body.text.match(/https:\/\/autonomist\.test\/newsletter\/confirm\/#t=([A-Za-z0-9_-]{43})/)[1]
  assert.ok(c.body.html.includes(`#t=${t}`))
  // kept under a hash of the token, never the token
  assert.deepEqual(await e.KV.get(`nl:pending:${await sha256hex(t)}`, 'json').then((x) => x.email), 'a@b.org')
  assert.ok(![...e.KV.m.keys()].some((k) => k.includes(t)))
  const again = await subscribe({ env: e, body: { email: 'a@b.org' }, visitor: 'w', fetch: f, sleep: noSleep })
  assert.deepEqual(again, r)
  assert.equal(calls.length, 1)
})

test('sign-up: one confirmation per inbox, whatever the +tag or Gmail dots', async () => {
  assert.equal(inboxOf('Victim+news@Example.org'), 'victim@example.org')
  assert.equal(inboxOf('v.i.c.t.i.m+1@googlemail.com'), 'victim@gmail.com')
  const { f, calls } = fakeResend({ 'POST /emails': [200, { id: 'em' }] })
  const e = env()
  for (const [n, address] of ['victim+1@gmail.com', 'victim+2@gmail.com', 'vic.tim@gmail.com'].entries()) {
    assert.equal((await subscribe({ env: e, body: { email: address }, visitor: `v${n}`, fetch: f, sleep: noSleep })).status, 200)
  }
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].body.to, ['victim+1@gmail.com'], 'the email goes to the address as typed')
  // the mark is keyed with the salt: the plain address's hash isn't in KV
  assert.ok(![...e.KV.m.keys()].some((k) => k.includes('victim')))
})

test('sign-up: limits per visitor and for the whole site; a failed send leaves nothing pending', async () => {
  const { f } = fakeResend({ 'POST /emails': [200, { id: 'em' }] })
  const e = env({ NEWSLETTER_PER_VISITOR_DAILY: '2', NEWSLETTER_CONFIRMS_DAILY: '3' })
  for (const n of [1, 2]) assert.equal((await subscribe({ env: e, body: { email: `p${n}@b.org` }, visitor: 'v', fetch: f, sleep: noSleep })).status, 200)
  assert.equal((await subscribe({ env: e, body: { email: 'p3@b.org' }, visitor: 'v', fetch: f, sleep: noSleep })).status, 429)
  assert.equal((await subscribe({ env: e, body: { email: 'p4@b.org' }, visitor: 'w', fetch: f, sleep: noSleep })).status, 200)
  const capped = await subscribe({ env: e, body: { email: 'p5@b.org' }, visitor: 'x', fetch: f, sleep: noSleep })
  assert.equal(capped.status, 429)
  assert.match(capped.body.error, /paused/)
  const bad = fakeResend({ 'POST /emails': [422, { name: 'validation_error', message: 'domain not verified' }] })
  const e2 = env()
  // the failed send waits out KV's one-write-a-second before forgetting what it marked
  const sleep = async (ms) => { e2.KV.clock.t += ms }
  const out = await subscribe({ env: e2, body: { email: 'z@b.org' }, visitor: 'v', fetch: bad.f, sleep })
  assert.equal(out.status, 502)
  assert.ok(![...e2.KV.m.keys()].some((k) => k.startsWith('nl:pending:') || k.startsWith('nl:asked:')))
  // so the same address can try again, in a later request
  e2.KV.clock.t += 5000
  const good = fakeResend({ 'POST /emails': [200, { id: 'em' }] })
  assert.equal((await subscribe({ env: e2, body: { email: 'z@b.org' }, visitor: 'v', fetch: good.f, sleep })).status, 200)
  assert.equal(good.calls.length, 1)
})

async function pendingToken(e, email = 'a@b.org') {
  const { f, calls } = fakeResend({ 'POST /emails': [200, { id: 'em' }] })
  await subscribe({ env: e, body: { email }, visitor: 'v', fetch: f, sleep: noSleep })
  e.KV.clock.t += 60_000 // the link is opened later, in another request
  return calls[0].body.text.match(/#t=([A-Za-z0-9_-]{43})/)[1]
}

test('confirm: adds the address to the segment once; a bad, used or unknown token adds nothing', async () => {
  const e = env()
  const t = await pendingToken(e)
  const { f, calls } = fakeResend({ 'POST /contacts': [201, { object: 'contact', id: 'c-1' }], 'GET /contacts/a@b.org': [200, { id: 'c-1', unsubscribed: false }], 'GET /contacts/c-1/segments': [200, { data: [{ id: 'seg-1' }] }] })
  assert.equal((await confirm({ env: e, body: { token: 'short' }, fetch: f })).status, 400)
  assert.equal((await confirm({ env: e, body: { token: 'A'.repeat(43) }, fetch: f })).status, 400)
  assert.equal(calls.length, 0)
  const ok = await confirm({ env: e, body: { token: t }, fetch: f })
  assert.equal(ok.status, 200)
  assert.deepEqual(calls[0].body, { email: 'a@b.org', unsubscribed: false, segments: [{ id: 'seg-1' }] })
  // read back: subscribed and in the segment, so nothing more to fix
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST /contacts', 'GET /contacts/a@b.org', 'GET /contacts/c-1/segments'])
  assert.equal((await confirm({ env: e, body: { token: t }, fetch: f })).status, 400)
  assert.equal(calls.length, 3)
})

test('confirm: an address already a contact (or unsubscribed before) is subscribed again and added to the segment', async () => {
  // whatever creating says (here a conflict, then a plain 200; Resend's docs don't say), the contact is read back and fixed
  for (const create of [[409, { name: 'conflict' }], [200, { id: 'c-1' }]]) {
    const e1 = env()
    const t1 = await pendingToken(e1)
    const { f, calls } = fakeResend({ 'POST /contacts': create, 'GET /contacts/a@b.org': [200, { id: 'c-1', unsubscribed: true }], 'PATCH /contacts/c-1': [200, { id: 'c-1' }], 'GET /contacts/c-1/segments': [200, { data: [{ id: 'other' }], has_more: false }], 'POST /contacts/c-1/segments/seg-1': [200, { id: 'seg-1' }] })
    const ok = await confirm({ env: e1, body: { token: t1 }, fetch: f })
    assert.equal(ok.status, 200, JSON.stringify(calls))
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST /contacts', 'GET /contacts/a@b.org', 'PATCH /contacts/c-1', 'GET /contacts/c-1/segments', 'POST /contacts/c-1/segments/seg-1'])
    assert.deepEqual(calls[2].body, { unsubscribed: false })
  }
  // an address with a +tag goes in the path as written
  const e3 = env()
  const t3 = await pendingToken(e3, 'a+news@b.org')
  const plus = fakeResend({ 'POST /contacts': [201, { id: 'c-3' }], 'GET /contacts/a+news@b.org': [200, { id: 'c-3', unsubscribed: false }], 'GET /contacts/c-3/segments': [200, { data: [{ id: 'seg-1' }] }] })
  assert.equal((await confirm({ env: e3, body: { token: t3 }, fetch: plus.f })).status, 200, JSON.stringify(plus.calls))
  // Resend down: the pending address stays, so the same link works later
  const e2 = env()
  const t2 = await pendingToken(e2)
  const down = fakeResend({ 'POST /contacts': [503, { message: 'unavailable' }] })
  assert.equal((await confirm({ env: e2, body: { token: t2 }, fetch: down.f })).status, 502)
  assert.ok([...e2.KV.m.keys()].some((k) => k.startsWith('nl:pending:')))
})

test('a published digest queues its record for the newsletter, once, with its at:// uri, before the day is marked done', async () => {
  const kv = strictKV()
  const order = []
  const put = kv.put
  kv.put = async (k, v, o) => { order.push(k); return put(k, v, o) }
  const api = { session: async () => ({ did: 'did:plc:me' }), call: async () => ({}) }
  const pending = { slug: '2026-11-25-rents', url: 'https://autonomist.test/journal/2026-11-25-rents/', record: RECORD, announcement: { slug: '2026-11-25-rents' } }
  await finishPublish({ kv, api, day: '2026-11-25', pending })
  const q = await kv.get(queueKey('2026-11-25'), 'json')
  assert.equal(q.slug, '2026-11-25-rents')
  assert.equal(q.uri, 'at://did:plc:me/org.jason-edelman.autonomist.journal/2026-11-25-rents')
  assert.equal(q.record.title, RECORD.title)
  // a run killed after marking the day done would never queue it: so the queue comes first
  assert.ok(order.indexOf(queueKey('2026-11-25')) < order.indexOf('journal:done:2026-11-25'), order.join(' '))
})

async function queued(kv, day = '2026-11-25') {
  await kv.put(queueKey(day), JSON.stringify({ slug: `${day}-rents`, url: 'u', uri: 'at://x', record: { ...RECORD, date: day } }))
}

test('sending: one broadcast per digest, as a draft first, sent only while it is still a draft, each key written once', async () => {
  const now = new Date('2026-11-25T14:07:00Z')
  const none = fakeResend()
  assert.deepEqual(await sendNewsletter({ env: env({ RESEND_SEGMENT_ID: '' }), kv: memoryKV(), now, fetch: none.f }), { skipped: 'not configured' })
  const e = env()
  assert.deepEqual(await sendNewsletter({ env: e, kv: e.KV, now, fetch: none.f }), { none: true })
  assert.equal(none.calls.length, 0)
  // queued by the journal step moments before, in the same run: the clock doesn't move, so every key the send
  // writes must be a new one (strictKV throws on a second write)
  await queued(e.KV)
  const { f, calls } = fakeResend({ 'POST /broadcasts': [201, { object: 'broadcast', id: 'b-1' }], 'GET /broadcasts/b-1': [200, { id: 'b-1', status: 'draft' }], 'POST /broadcasts/b-1/send': [200, { id: 'b-1' }] })
  const r = await sendNewsletter({ env: e, kv: e.KV, now, fetch: f })
  assert.equal(r.sent, 'b-1')
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['POST /broadcasts', 'GET /broadcasts/b-1', 'POST /broadcasts/b-1/send'])
  const b = calls[0].body
  assert.equal(b.segment_id, 'seg-1')
  assert.equal(b.from, 'autonomist <digest@example.org>')
  assert.ok(b.html.includes(UNSUBSCRIBE) && b.text.includes(UNSUBSCRIBE))
  assert.ok(!('send' in b), 'created as a draft')
  assert.equal(await e.KV.get('newsletter:sent:2026-11-25-rents'), 'sent')
  // the queue's delete came too soon after its write (KV's limit) and is left for the next run, which finds it sent
  e.KV.clock.t += 60 * 60_000
  const again = fakeResend()
  assert.deepEqual(await sendNewsletter({ env: e, kv: e.KV, now: new Date('2026-11-25T15:07:00Z'), fetch: again.f }), { already: 'sent', slug: '2026-11-25-rents' })
  assert.equal(again.calls.length, 0)
  assert.equal(await e.KV.get(queueKey('2026-11-25')), null)
})

test('sending: a run cut short after the send never sends again; one try an hour; yesterday’s queue still goes; four tries at most', async () => {
  const now = new Date('2026-11-26T00:07:00Z')
  const e = env()
  await queued(e.KV, '2026-11-25')
  // an earlier run created the draft and asked Resend to send it, then was cut short before marking it sent
  await e.KV.put('newsletter:draft:2026-11-25-rents', 'b-1')
  await e.KV.put('newsletter:try:2026-11-25-rents:2026-11-25T23', '1')
  e.KV.clock.t += 60 * 60_000
  const { f, calls } = fakeResend({ 'GET /broadcasts/b-1': [200, { id: 'b-1', status: 'queued' }] })
  const r = await sendNewsletter({ env: e, kv: e.KV, now, fetch: f })
  assert.equal(r.status, 'queued')
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ['GET /broadcasts/b-1'])
  // a failing send: one try an hour (a second run in the same hour does nothing), and none after the fourth
  const e2 = env()
  await queued(e2.KV, '2026-11-26')
  const bad = fakeResend({ 'POST /broadcasts': [422, { name: 'validation_error', message: 'The domain is not verified' }] })
  const at = (h) => new Date(`2026-11-26T${String(h).padStart(2, '0')}:07:00Z`)
  await assert.rejects(sendNewsletter({ env: e2, kv: e2.KV, now: at(13), fetch: bad.f }), /create: Resend 422 validation_error/)
  assert.deepEqual(await sendNewsletter({ env: e2, kv: e2.KV, now: at(13), fetch: bad.f }), { skipped: 'tried this hour', slug: '2026-11-26-rents' })
  for (const h of [14, 15, 16]) await assert.rejects(sendNewsletter({ env: e2, kv: e2.KV, now: at(h), fetch: bad.f }))
  const gave = await sendNewsletter({ env: e2, kv: e2.KV, now: at(17), fetch: bad.f })
  assert.deepEqual(gave, { gaveUp: '2026-11-26-rents', tries: 4 })
  assert.equal(bad.calls.length, 4)
})

test('a dry run’s email goes to the steward alone, with a plain link where the unsubscribe placeholder was', async () => {
  const mail = digestEmail({ ...RECORD, slug: 's' }, { origin: 'https://autonomist.test' })
  const { f, calls } = fakeResend({ 'POST /emails': [200, { id: 'em' }] })
  const out = await previewToSteward({ env: env(), email: mail, to: 'steward@example.org', id: '2026-11-25T14-00-00-000Z', fetch: f })
  assert.equal(out.status, 200)
  assert.deepEqual(calls[0].body.to, ['steward@example.org'])
  assert.ok(calls[0].body.subject.startsWith('[dry run] '))
  assert.ok(!calls[0].body.html.includes(UNSUBSCRIBE) && calls[0].body.html.includes('https://autonomist.test/newsletter/'))
  assert.equal((await previewToSteward({ env: env(), email: null, to: 's@x.org', id: 'x', fetch: f })).status, 404)
})

test('routes: closed without config, open with it, and POSTs only from the site', async () => {
  const O = 'https://autonomist.test'
  const base = { KV: memoryKV(), ASSETS: assets, IP_SALT: 'salt', PUBLIC_ORIGIN: O }
  const call = (e, path, init) => worker.fetch(new Request(O + path, init), e, { waitUntil() {} })
  assert.deepEqual(await (await call(base, '/api/newsletter')).json(), { open: false })
  const post = (e, body, origin = O) => call(e, '/api/newsletter/subscribe', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  assert.equal((await post(base, { email: 'a@b.org' })).status, 503)
  const open = { ...base, RESEND_API_KEY: 'k', RESEND_SEGMENT_ID: 's', NEWSLETTER_FROM: 'a <a@b.org>' }
  assert.deepEqual(await (await call(open, '/api/newsletter')).json(), { open: true })
  assert.equal((await post(open, { email: 'a@b.org' }, 'https://evil.example')).status, 403)
  // the honeypot answers without calling Resend
  assert.equal((await post(open, { email: 'a@b.org', website: 'x' })).status, 200)
})
