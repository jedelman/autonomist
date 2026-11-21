import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker from '../worker/index.js'
import { newCode, inviteKey } from '../worker/invites.js'
import { memoryKV, assets } from './helpers.mjs'

const O = 'https://autonomist.test'
const env = (extra = {}) => ({ KV: memoryKV(), ASSETS: assets, INVITE_SECRET: 's'.repeat(32), IP_SALT: 'salt', ANTHROPIC_API_KEY: 'k', PUBLIC_ORIGIN: O, ...extra })
const ctx = { waitUntil() {} }
const call = (e, path, init = {}) => worker.fetch(new Request(O + path, init), e, ctx)
const post = (e, path, body, headers = {}) => call(e, path, { method: 'POST', headers: { Origin: O, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })

test('pages carry the strict CSP', async () => {
  const r = await call(env(), '/tools/')
  assert.match(r.headers.get('Content-Security-Policy'), /script-src 'self'/)
  assert.equal(r.headers.get('X-Frame-Options'), 'DENY')
})

test('POSTs from elsewhere are refused', async () => {
  const r = await post(env(), '/api/chat', {}, { Origin: 'https://evil.example' })
  assert.equal(r.status, 403)
})

test('the chat fails closed without storage, and asks for an invite without one', async () => {
  assert.equal((await post(env({ KV: undefined }), '/api/chat', { question: 'hi' })).status, 503)
  const r = await post(env(), '/api/chat', { question: 'hi' })
  assert.equal(r.status, 401)
  assert.equal((await r.json()).gate, 'invite')
})

test('an invite redeems to a __Host- cookie that opens the session', async () => {
  const e = env()
  const code = newCode()
  await e.KV.put(await inviteKey(code), JSON.stringify({ label: 't', max_uses: 2 }))
  const r = await post(e, '/api/invite', { code })
  assert.equal(r.status, 200)
  const cookie = r.headers.get('Set-Cookie').split(';')[0]
  assert.match(cookie, /^__Host-autonomist_invite=/)
  const s = await (await call(e, '/api/session', { headers: { Cookie: cookie } })).json()
  assert.equal(s.invited, true)
  assert.equal((await post(e, '/api/invite', { code: 'AUTONOMIST-AAAAA-BBBBB' })).status, 403)
})

test('request access stores an entry; the honeypot stores nothing', async () => {
  const e = env()
  assert.equal((await post(e, '/api/request-access', { email: 'a@example.org', note: 'hi' })).status, 200)
  assert.equal((await post(e, '/api/request-access', { email: 'b@example.org', website: 'spam' })).status, 200)
  assert.equal([...e.KV.m.keys()].filter((k) => k.startsWith('waitlist:')).length, 1)
})

test('saved results: bad ids 404, good ones return JSON, and the page shell is served', async () => {
  const e = env()
  assert.equal((await call(e, '/api/results/NOT-AN-ID')).status, 404)
  await e.KV.put('result:abcdefghjkmn', JSON.stringify({ id: 'abcdefghjkmn', title: 't' }))
  assert.equal((await (await call(e, '/api/results/abcdefghjkmn')).json()).title, 't')
  assert.equal((await call(e, '/results/abcdefghjkmn')).status, 200)
})

test('the site-wide spending cap stops questions', async () => {
  const e = env({ DAILY_BUDGET_USD: '0.001' })
  const code = newCode()
  await e.KV.put(await inviteKey(code), JSON.stringify({ label: 't' }))
  const cookie = (await post(e, '/api/invite', { code })).headers.get('Set-Cookie').split(';')[0]
  await e.KV.put(`spend:${new Date().toISOString().slice(0, 10)}:x`, '', { metadata: { micros: 5000 } })
  const r = await post(e, '/api/chat', { question: 'hi' }, { Cookie: cookie })
  assert.equal(r.status, 429)
})

import { deps } from '../worker/index.js'
import { contextWindow } from '../worker/thread.js'

async function invited(e) {
  const code = newCode()
  await e.KV.put(await inviteKey(code), JSON.stringify({ label: 't' }))
  const cookie = (await post(e, '/api/invite', { code })).headers.get('Set-Cookie').split(';')[0]
  return { cookie, hash: (await inviteKey(code)).slice(7) }
}

test('one conversation per invite: kept, shown, fed back to the model, erased', async () => {
  const e = env()
  const { cookie } = await invited(e)
  const seen = []
  const real = deps.ask
  deps.ask = async ({ messages }) => { seen.push(messages); return { answer: `answer ${seen.length}`, sources: [{ url: '/tools/', title: 'Tools' }], results: [], tools: [], cost: 0 } }
  try {
    assert.equal((await post(e, '/api/chat', { question: 'first?' }, { Cookie: cookie })).status, 200)
    assert.equal((await post(e, '/api/chat', { question: 'second?' }, { Cookie: cookie })).status, 200)
    assert.deepEqual(seen[1].map((m) => m.content), ['first?', 'answer 1', 'second?'])
    const t = await (await call(e, '/api/thread', { headers: { Cookie: cookie } })).json()
    assert.deepEqual(t.turns.map((x) => x.content), ['first?', 'answer 1', 'second?', 'answer 2'])
    assert.equal(t.turns[1].sources[0].url, '/tools/')
    assert.equal((await call(e, '/api/thread')).status, 401)
    assert.equal((await post(e, '/api/thread/erase', {}, { Cookie: cookie })).status, 200)
    assert.equal((await (await call(e, '/api/thread', { headers: { Cookie: cookie } })).json()).turns.length, 0)
  } finally { deps.ask = real }
})

test('a failed answer saves nothing, so the question can be asked again', async () => {
  const e = env()
  const { cookie, hash } = await invited(e)
  const real = deps.ask
  deps.ask = async () => { throw new Error('boom') }
  try {
    assert.equal((await post(e, '/api/chat', { question: 'q' }, { Cookie: cookie })).status, 502)
    assert.equal(e.KV.m.has(`thread:${hash}`), false)
  } finally { deps.ask = real }
})

test('the context window keeps the newest turns within budget and starts with a question', () => {
  const turns = [{ role: 'user', content: 'a'.repeat(50) }, { role: 'assistant', content: 'b'.repeat(50) }, { role: 'user', content: 'c'.repeat(10) }, { role: 'assistant', content: 'd'.repeat(10) }]
  assert.deepEqual(contextWindow(turns, 'now', 30).map((m) => m.content), ['c'.repeat(10), 'd'.repeat(10), 'now'])
  // the answer fits but its question doesn't: the window never opens on an answer
  assert.deepEqual(contextWindow(turns, 'now', 15).map((m) => m.content), ['now'])
  assert.equal(contextWindow(turns, 'now', 1000).length, 5)
})
