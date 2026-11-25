// autonomist's Worker: the site (static pages built into public/), the chat behind invite codes
// and "Request access", saved results, and the agent. Every response carries a strict
// Content-Security-Policy: no inline script or style anywhere.
import { currentInvite, redeem, joinWaitlist, sessionCookie, basePathOf } from './invites.js'
import { setting, visitorHash, spentToday, recordSpend } from './limits.js'
import { ask } from './agent.js'
import { loadThread, saveThread, eraseThread, contextWindow, foldPlan, publicThread, exportMarkdown } from './thread.js'
import { foldMemory } from './memory.js'
import { UA_HEADER } from './parcel.js'
import { adminApi, adminEnabled } from './admin.js'
import { queueChatReflection, memoryNote } from './bot/log.js'
import { newsletterReady, subscribe, confirm } from './newsletter.js'
import { QUESTION_KEY, questionHtml } from './journal-pages.js'

export const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
const SECURITY = { 'Content-Security-Policy': CSP, 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()' }
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY, ...headers } })
const today = () => new Date().toISOString().slice(0, 10)
// Swappable for tests.
export const deps = { ask, fold: foldMemory }

export function withSecurity(res, status) {
  const r = new Response(res.body, status ? { status, headers: res.headers } : res)
  for (const [k, v] of Object.entries(SECURITY)) r.headers.set(k, v)
  return r
}

// POSTs must come from this site (cookies are SameSite=Lax too)
function sameOrigin(req, env) {
  const origin = req.headers.get('Origin')
  if (!origin) return false
  const own = new URL(req.url).origin
  return origin === own || (env.PUBLIC_ORIGIN && origin === env.PUBLIC_ORIGIN)
}

async function readJson(req, max = 64_000) {
  const text = await req.text()
  if (text.length > max) throw new Error('too large')
  return JSON.parse(text)
}

const inviteOnly = (env) => env.INVITE_REQUIRED !== 'false'
const setupError = (env) => !env.KV ? 'The chat is not configured yet (storage).' : !env.INVITE_SECRET || !env.IP_SALT ? 'The chat is not configured yet (invites).' : !env.ANTHROPIC_API_KEY ? 'The chat is not configured yet (model).' : null

async function session(req, env) {
  const setup = setupError(env)
  const invite = !setup && inviteOnly(env) ? await currentInvite(req, env, env.KV) : null
  return json({ ready: !setup, invite_required: inviteOnly(env), invited: Boolean(invite) || (!inviteOnly(env) && !setup), setup: setup || undefined })
}

async function chat(req, env, ctx) {
  const setup = setupError(env)
  if (setup) return json({ error: setup }, 503)
  const kv = env.KV
  let invite = null
  if (inviteOnly(env)) {
    invite = await currentInvite(req, env, kv)
    if (!invite) return json({ error: 'The chat is invite-only for now. Enter a code, or request access.', gate: 'invite' }, 401)
  }
  let body
  try { body = await readJson(req) } catch { return json({ error: 'Send your question as JSON.' }, 400) }
  const question = String(body?.question || '').replace(/\u0000/g, '').trim().slice(0, 4000)
  if (!question) return json({ error: 'Ask a question.' }, 400)
  // one conversation per invite, kept on the server; without invites, each question stands alone
  const thread = invite ? await loadThread(kv, invite.hash) : { turns: [], memory: null }
  const historyBudget = setting(env.HISTORY_CHARS, 150_000, { min: 4000, max: 600_000 })
  const messages = contextWindow(thread, question, historyBudget)
  // the community memory autonomist writes from all its public conversations, read before it answers here too
  const community = env.BOT_ENABLED === 'true' ? await memoryNote(kv) : ''
  if (community) messages[0].content = `${community.trim()}\n\n${messages[0].content}`

  const day = today()
  // daily limits: per invite, and one budget for the whole site (fails closed)
  const who = invite ? `inv-day:${day}:${invite.hash.slice(0, 32)}` : `vis-day:${day}:${await visitorHash(env.IP_SALT, req.headers.get('CF-Connecting-IP'))}`
  const perDay = setting(invite ? env.PER_INVITE_DAILY : env.PER_VISITOR_DAILY, invite ? 30 : 10, { min: 1 })
  const used = Number((await kv.get(who)) || 0)
  if (used >= perDay) return json({ error: `This ${invite ? 'invite' : 'visitor'} has used today's ${perDay} questions. Try again tomorrow (UTC).` }, 429)
  const budget = setting(env.DAILY_BUDGET_USD, 3, { min: 0 })
  if ((await spentToday(kv, day)) >= budget) return json({ error: "Today's spending cap for the whole site is reached. Try again tomorrow (UTC)." }, 429)
  await kv.put(who, String(used + 1), { expirationTtl: 2 * 86400 })

  let requests = 0
  const maxRequests = setting(env.SUBREQUEST_BUDGET, 40, { min: 5, max: 500 })
  const fetchJson = async (url) => {
    if (++requests > maxRequests) throw new Error('This answer has made as many outside requests as it may.')
    const r = await fetch(url, { headers: { 'User-Agent': UA_HEADER, Accept: 'application/json' }, signal: AbortSignal.timeout(12_000) })
    if (!r.ok) throw new Error(`The data portal answered ${r.status}.`)
    return r.json()
  }
  const content = async () => {
    const r = await env.ASSETS.fetch(new Request(new URL('/content-index.json', req.url)))
    return r.ok ? r.json() : {}
  }
  const spends = []
  try {
    const out = await deps.ask({
      messages, env, kv, fetchJson, content,
      model: env.MODEL || 'claude-haiku-5-5',
      effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(env.EFFORT) ? env.EFFORT : 'high',
      maxSteps: setting(env.MAX_STEPS, 6, { min: 1, max: 12 }),
      maxTokens: setting(env.MAX_TOKENS, 8000, { min: 1000, max: 16000 }),
      onCost: (usd) => spends.push(recordSpend(kv, day, usd).catch(() => {})),
    })
    const at = new Date().toISOString()
    if (invite) {
      thread.turns.push({ role: 'user', content: question, at }, { role: 'assistant', content: out.answer, sources: out.sources, results: out.results, at })
      await saveThread(kv, invite.hash, thread)
      // fold what has scrolled out of view into the memory, after the answer has gone back
      if (foldPlan(thread, historyBudget)) ctx.waitUntil(foldNow(env, invite.hash, historyBudget, day).catch((e) => console.error('memory fold failed', String(e?.message || e).slice(0, 200))))
    }
    ctx.waitUntil(Promise.all(spends))
    // every chat answer ends with a reflection in the public run journal (written by the bot, off this request)
    if (env.BOT_ENABLED === 'true' && !out.refused) ctx.waitUntil(queueChatReflection(kv, { question, answer: out.answer }).catch(() => {}))
    console.log(JSON.stringify({ event: 'answer', tools: out.tools.map((t) => t.tool), steps: out.tools.length, context_turns: messages.length, cost: Math.round(out.cost * 1e6) / 1e6, refused: Boolean(out.refused) }))
    return json({ answer: out.answer, sources: out.sources, results: out.results, at })
  } catch (e) {
    ctx.waitUntil(Promise.all(spends))
    console.error('answer failed', e?.status || '', String(e?.message || e).slice(0, 200))
    return json({ error: 'Something went wrong while answering. Try again in a moment.' }, 502)
  }
}

// Fold the oldest turns past the budget into the thread's memory. Re-reads the thread before
// writing and gives up if another fold got there first, so a concurrent turn is never lost.
async function foldNow(env, hash, budget, day) {
  const kv = env.KV
  if ((await spentToday(kv, day)) >= setting(env.DAILY_BUDGET_USD, 3, { min: 0 })) return
  const before = await loadThread(kv, hash)
  const plan = foldPlan(before, budget)
  if (!plan) return
  const { text, cost } = await deps.fold({ memory: before.memory?.text || '', turns: before.turns.slice(plan.from, plan.to), env, model: env.MODEL || 'claude-haiku-5-5' })
  await recordSpend(kv, day, cost).catch(() => {})
  if (!text) return
  const now = await loadThread(kv, hash)
  if ((now.memory?.through || 0) !== plan.from || now.turns.length < plan.to) return
  now.memory = { text, through: plan.to, updated: new Date().toISOString() }
  await saveThread(kv, hash, now)
  console.log(JSON.stringify({ event: 'memory_fold', folded_turns: plan.to - plan.from, memory_chars: text.length, cost: Math.round(cost * 1e6) / 1e6 }))
}

// The person's conversation: GET to show it (or ?export to download it), POST /api/thread/erase to erase it.
async function threadRoute(req, env, erase = false) {
  const setup = setupError(env)
  if (setup) return json({ error: setup }, 503)
  const invite = await currentInvite(req, env, env.KV)
  if (!invite) return json({ error: 'Enter your invite code first.', gate: 'invite' }, 401)
  if (erase) { await eraseThread(env.KV, invite.hash); return json({ ok: true }) }
  const thread = await loadThread(env.KV, invite.hash)
  if (new URL(req.url).searchParams.has('export')) {
    return new Response(exportMarkdown(thread, env.PUBLIC_ORIGIN || new URL(req.url).origin), { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="autonomist-conversation.md"', 'Cache-Control': 'no-store', ...SECURITY } })
  }
  return json(publicThread(thread))
}

async function redeemCode(req, env) {
  const setup = setupError(env)
  if (setup) return json({ error: setup }, 503)
  let body
  try { body = await readJson(req, 2000) } catch { return json({ error: 'Send the code as JSON.' }, 400) }
  const visitor = await visitorHash(env.IP_SALT, req.headers.get('CF-Connecting-IP'))
  const current = (await currentInvite(req, env, env.KV))?.hash || null
  const out = await redeem({ code: body?.code, env, kv: env.KV, visitor, current })
  if (!out.ok) return json({ error: out.error }, out.status)
  return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(out.cookie, `${basePathOf(env)}/`) })
}

async function requestAccess(req, env) {
  if (!env.KV || !env.IP_SALT) return json({ error: 'Requests are not open yet.' }, 503)
  let body
  try { body = await readJson(req, 4000) } catch { return json({ error: 'Send the form as JSON.' }, 400) }
  const visitor = await visitorHash(env.IP_SALT, req.headers.get('CF-Connecting-IP'))
  const out = await joinWaitlist({ body, kv: env.KV, visitor, source: 'request-access' })
  if (!out.ok) return json({ error: out.error }, out.status)
  return json({ ok: true })
}

// the digest by email (newsletter.js): open only with Resend's config; addresses never reach the model or the record
async function newsletterRoute(req, env, action) {
  if (!newsletterReady(env) || !env.IP_SALT) return json({ error: "The digest by email isn't open yet." }, 503)
  let body
  try { body = await readJson(req, 2000) } catch { return json({ error: 'Send the form as JSON.' }, 400) }
  const out = action === 'subscribe'
    ? await subscribe({ env, body, visitor: await visitorHash(env.IP_SALT, req.headers.get('CF-Connecting-IP')) })
    : await confirm({ env, body })
  return json(out.body, out.status)
}

// The front page with the day's question in its slot (journal-pages.js), or the slot removed when there's none.
const QUESTION_SLOT = '<div class="slot-question"></div>'
async function frontPage(req, env) {
  const page = await env.ASSETS.fetch(req)
  if (!page.ok || !(page.headers.get('Content-Type') || '').includes('text/html')) return withSecurity(page)
  const q = env.KV ? await env.KV.get(QUESTION_KEY, 'json').catch(() => null) : null
  const html = (await page.text()).replace(QUESTION_SLOT, () => questionHtml(q))
  return withSecurity(new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } }))
}

async function result(id, env) {
  if (!/^[a-z0-9]{12}$/.test(id) || !env.KV) return json({ error: 'No such result.' }, 404)
  const rec = await env.KV.get(`result:${id}`, 'json')
  if (!rec) return json({ error: 'No such result.' }, 404)
  return json(rec, 200, { 'Cache-Control': 'public, max-age=300' })
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    const path = url.pathname
    if (path.startsWith('/api/admin/')) {
      if (req.method === 'POST' && !sameOrigin(req, env)) return json({ error: 'Not from this site.' }, 403)
      // a dry-run page comes back as HTML (worker/admin.js): it gets the site's security headers like any page
      const r = await adminApi(req, env, path, json)
      return (r.headers.get('Content-Type') || '').startsWith('text/html') ? withSecurity(r) : r
    }
    if (path.startsWith('/api/')) {
      if (req.method === 'GET' && path === '/api/session') return session(req, env)
      if (req.method === 'GET' && path.startsWith('/api/results/')) return result(path.slice('/api/results/'.length), env)
      if (req.method === 'GET' && path === '/api/thread') return threadRoute(req, env)
      if (req.method === 'GET' && path === '/api/newsletter') return json({ open: newsletterReady(env) && Boolean(env.IP_SALT) })
      if (req.method === 'POST') {
        if (!sameOrigin(req, env)) return json({ error: 'Not from this site.' }, 403)
        if (path === '/api/chat') return chat(req, env, ctx)
        if (path === '/api/invite') return redeemCode(req, env)
        if (path === '/api/request-access') return requestAccess(req, env)
        if (path === '/api/thread/erase') return threadRoute(req, env, true)
        if (path === '/api/newsletter/subscribe') return newsletterRoute(req, env, 'subscribe')
        if (path === '/api/newsletter/confirm') return newsletterRoute(req, env, 'confirm')
      }
      return json({ error: 'Not found.' }, 404)
    }
    // a saved result's page is one shell that reads /api/results/<id>
    if (/^\/results\/[a-z0-9]{12}\/?$/.test(path)) {
      const shell = await env.ASSETS.fetch(new Request(new URL('/results/', req.url)))
      return withSecurity(shell)
    }
    if (path === '/admin' || path.startsWith('/admin/')) {
      if (!adminEnabled(env)) return withSecurity(await env.ASSETS.fetch(new Request(new URL('/404.html', req.url))), 404)
      const r = withSecurity(await env.ASSETS.fetch(req))
      r.headers.set('X-Robots-Tag', 'noindex')
      r.headers.set('Cache-Control', 'no-store')
      return r
    }
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) return frontPage(req, env)
    return withSecurity(await env.ASSETS.fetch(req))
  },
}
