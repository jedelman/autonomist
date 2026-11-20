// admin.js: the steward's page and API (/admin/, /api/admin/*), behind Cloudflare Access (Jason,
// 2026-11-20: "I can use Cloudflare access to protect the admin page"). From here the steward mints
// invite codes, turns access requests into invites, revokes invites, and reads case-study proposals.
//
// - Off entirely (404) unless ACCESS_TEAM_DOMAIN and ACCESS_AUD are set.
// - Every request must carry a valid Access JWT (verified in access.js, never the plain email
//   header), and, when ADMIN_EMAILS is set, its email must be on that list.
// - Codes are returned once, never stored or logged; invites are stored by hash, as everywhere.
// - Everything people typed into the request form is returned as data and shown as text.
import { newCode, inviteKey } from './invites.js'
import { verifyAccess } from './access.js'
import { threadKey } from './thread.js'

export const adminEnabled = (env) => Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD && env.KV)

/** The steward's email for a request that passes Access (and ADMIN_EMAILS, if set), else null. */
export async function steward(req, env, fetchImpl = fetch) {
  if (!adminEnabled(env)) return null
  let who
  try { who = await verifyAccess(req, env, fetchImpl) } catch { return null }
  const allowed = String(env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  if (allowed.length && !allowed.includes(who.email)) return null
  return who.email
}

async function listAll(kv, prefix, max = 1000) {
  const keys = []
  let cursor
  do {
    const page = await kv.list({ prefix, cursor })
    keys.push(...page.keys)
    cursor = page.list_complete || keys.length >= max ? undefined : page.cursor
  } while (cursor)
  return keys.slice(0, max)
}
const getJson = (kv, key) => kv.get(key, 'json').catch(() => null)
const masked = (email) => { const [u, d] = String(email || '').split('@'); return d ? `${u.slice(0, 1)}•••@${d}` : '•••' }
const HASH = /^[0-9a-f]{64}$/
const ID = /^[a-z0-9]{12}$/

async function mint(kv, label, uses) {
  const code = newCode()
  await kv.put(await inviteKey(code), JSON.stringify({ label: String(label || '').slice(0, 120), max_uses: uses, created: new Date().toISOString().slice(0, 10) }))
  return code
}

/** Handle /api/admin/*. json(body, status, headers) is the Worker's JSON response helper. */
export async function adminApi(req, env, path, json, fetchImpl = fetch) {
  if (!adminEnabled(env)) return json({ error: 'Not found.' }, 404)
  const who = await steward(req, env, fetchImpl)
  if (!who) return json({ error: 'Open this page through Cloudflare Access, signed in as a steward.' }, 403)
  const kv = env.KV
  const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}

  if (path === '/api/admin/state' && req.method === 'GET') {
    const [inviteKeys, requestKeys, proposalKeys, redeemedKeys] = await Promise.all([listAll(kv, 'invite:'), listAll(kv, 'waitlist:'), listAll(kv, 'proposal:'), listAll(kv, 'redeemed:', 5000)])
    const used = {}
    for (const k of redeemedKeys) { const h = k.name.split(':')[1]; used[h] = (used[h] || 0) + 1 }
    const invites = (await Promise.all(inviteKeys.map(async (k) => { const r = await getJson(kv, k.name); const hash = k.name.slice(7); return r && { hash, label: r.label || '', max_uses: r.max_uses ?? null, used: used[hash] || 0, created: r.created || '' } }))).filter(Boolean)
    const requests = (await Promise.all(requestKeys.map(async (k) => { const r = await getJson(kv, k.name); return r && { id: k.name.slice(9), email: r.email, name: r.name, org: r.org, note: r.note, at: r.at } }))).filter(Boolean).sort((a, b) => String(a.at).localeCompare(String(b.at)))
    const proposals = (await Promise.all(proposalKeys.map((k) => getJson(kv, k.name)))).filter(Boolean)
    return json({ steward: who, invites: invites.sort((a, b) => String(b.created).localeCompare(String(a.created))), requests, proposals })
  }
  if (req.method !== 'POST') return json({ error: 'Not found.' }, 404)
  if (path === '/api/admin/invite') {
    const uses = Math.min(50, Math.max(1, Math.round(Number(body.uses) || 3)))
    return json({ code: await mint(kv, body.label, uses), uses })
  }
  if (path === '/api/admin/revoke') {
    if (!HASH.test(String(body.hash))) return json({ error: 'No such invite.' }, 400)
    await kv.delete(`invite:${body.hash}`)
    await kv.delete(threadKey(body.hash)) // the person's conversation goes with the invite
    return json({ ok: true })
  }
  if (path === '/api/admin/request/invite') {
    if (!HASH.test(String(body.id))) return json({ error: 'No such request.' }, 400)
    const entry = await getJson(kv, `waitlist:${body.id}`)
    if (!entry) return json({ error: 'That request is gone (already handled?).' }, 404)
    const code = await mint(kv, `Request: ${masked(entry.email)}`, 3)
    await kv.delete(`waitlist:${body.id}`)
    return json({ code, uses: 3, email: entry.email, name: entry.name || '' })
  }
  if (path === '/api/admin/request/remove') {
    if (!HASH.test(String(body.id))) return json({ error: 'No such request.' }, 400)
    await kv.delete(`waitlist:${body.id}`)
    return json({ ok: true })
  }
  if (path === '/api/admin/proposal/delete') {
    if (!ID.test(String(body.id))) return json({ error: 'No such proposal.' }, 400)
    await kv.delete(`proposal:${body.id}`)
    return json({ ok: true })
  }
  return json({ error: 'Not found.' }, 404)
}
