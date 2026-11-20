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
  assert.equal((await post(env({ KV: undefined }), '/api/chat', { messages: [{ role: 'user', content: 'hi' }] })).status, 503)
  const r = await post(env(), '/api/chat', { messages: [{ role: 'user', content: 'hi' }] })
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
  const r = await post(e, '/api/chat', { messages: [{ role: 'user', content: 'hi' }] }, { Cookie: cookie })
  assert.equal(r.status, 429)
})
