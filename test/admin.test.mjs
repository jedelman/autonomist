import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { adminApi, adminEnabled } from '../worker/admin.js'
import { resetAccessCache } from '../worker/access.js'
import { memoryKV } from './helpers.mjs'

const TEAM = 'example.cloudflareaccess.com', AUD = 'aud-tag-123'
const enc = new TextEncoder()
const b64u = (b) => Buffer.from(b).toString('base64url')
const { privateKey, publicKey } = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
const jwk = { ...(await crypto.subtle.exportKey('jwk', publicKey)), kid: 'k1' }
const certs = async (url) => { assert.equal(url, `https://${TEAM}/cdn-cgi/access/certs`); return new Response(JSON.stringify({ keys: [jwk] })) }
async function jwt(claims, key = privateKey) {
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1' }))
  const p = b64u(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], exp: Math.floor(Date.now() / 1000) + 600, email: 'steward@example.org', ...claims }))
  const sig = b64u(new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${h}.${p}`))))
  return `${h}.${p}.${sig}`
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })
const env = (extra = {}) => ({ KV: memoryKV(), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD, ...extra })
const call = (e, path, token, body) => adminApi(new Request('https://a.test' + path, { method: body ? 'POST' : 'GET', headers: { ...(token ? { 'Cf-Access-Jwt-Assertion': token } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }), e, path, json, certs)

beforeEach(() => resetAccessCache())

test('off without Access settings', async () => {
  assert.equal(adminEnabled({ KV: memoryKV() }), false)
  assert.equal((await call({ KV: memoryKV() }, '/api/admin/state', await jwt({}))).status, 404)
})

test('refuses without a token, with a forged one, or the wrong audience; never trusts the email header', async () => {
  const e = env()
  assert.equal((await call(e, '/api/admin/state')).status, 403)
  const other = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign'])).privateKey
  assert.equal((await call(e, '/api/admin/state', await jwt({}, other))).status, 403)
  assert.equal((await call(e, '/api/admin/state', await jwt({ aud: ['someone-else'] }))).status, 403)
  assert.equal((await call(e, '/api/admin/state', await jwt({ exp: 1 }))).status, 403)
  const r = await adminApi(new Request('https://a.test/api/admin/state', { headers: { 'Cf-Access-Authenticated-User-Email': 'steward@example.org' } }), e, '/api/admin/state', json, certs)
  assert.equal(r.status, 403)
})

test('ADMIN_EMAILS narrows who may act', async () => {
  const e = env({ ADMIN_EMAILS: 'jason@example.org' })
  assert.equal((await call(e, '/api/admin/state', await jwt({}))).status, 403)
  assert.equal((await call(e, '/api/admin/state', await jwt({ email: 'Jason@example.org' }))).status, 200)
})

test('a steward mints a code, turns a request into an invite, and revokes', async () => {
  const e = env()
  const t = await jwt({})
  const minted = await (await call(e, '/api/admin/invite', t, { label: 'Jason', uses: 2 })).json()
  assert.match(minted.code, /^AUTONOMIST-[A-Z0-9]{5}-[A-Z0-9]{5}$/)
  await e.KV.put('waitlist:' + 'a'.repeat(64), JSON.stringify({ email: 'neighbor@example.org', name: 'N', at: '2026-11-20' }))
  let s = await (await call(e, '/api/admin/state', t)).json()
  assert.equal(s.steward, 'steward@example.org')
  assert.equal(s.invites.length, 1)
  assert.equal(s.requests[0].email, 'neighbor@example.org')
  const fromRequest = await (await call(e, '/api/admin/request/invite', t, { id: 'a'.repeat(64) })).json()
  assert.equal(fromRequest.email, 'neighbor@example.org')
  s = await (await call(e, '/api/admin/state', t)).json()
  assert.equal(s.requests.length, 0)
  assert.ok(s.invites.some((i) => i.label === 'Request: n•••@example.org'))
  assert.ok(!JSON.stringify(s).includes(minted.code))
  assert.equal((await call(e, '/api/admin/revoke', t, { hash: s.invites[0].hash })).status, 200)
  assert.equal((await call(e, '/api/admin/revoke', t, { hash: '../x' })).status, 400)
})
