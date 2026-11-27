// The Worker's entry point. Two hosts, one Worker:
//   HOSTNAME (pds.autonomist.jason-edelman.org)  autonomist's own atproto PDS, run by pds.js
//   everything else                             the site, the chat and the API (./index.js)
// The site's handle check (/.well-known/atproto-did) reads the DID from the PDS, so the account has one source of
// truth. Journal entries autonomist writes itself live in its repository and are rendered here (journal-pages.js);
// the cron runs its life on Bluesky (bot/index.js). Kept apart from index.js so the tests never load pds.js.
import pds, { PDSDurableObject } from '@pdsjs/cloudflare'
import site, { withSecurity } from './index.js'
import { runBot } from './bot/index.js'
import { COLLECTION, entryHtml, fillShell, listItems, listHtml, postKey } from './journal-pages.js'
import { logHtml, memoryHtml, dreamsHtml, THINKING_CSP } from './thinking-pages.js'
import { LOG, MEMORY } from './bot/log.js'
import { ACQUAINTANCE } from './bot/acquaint.js'
import { DREAM } from './bot/dream.js'
import { knownHtml, HANDLE, DID } from './known-pages.js'
import { sniffImage, MAX_IMAGE_BYTES } from './bot/images.js'

export { PDSDurableObject }

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    if (env.HOSTNAME && url.hostname === env.HOSTNAME) return pds.fetch(req, env, ctx)
    if (url.pathname === '/.well-known/atproto-did' && env.PDS && env.HOSTNAME) return handleDid(env, ctx)
    if (req.method === 'GET' && env.PDS && env.HOSTNAME) {
      if (url.pathname === '/journal/') return journalIndex(req, env, ctx)
      if (url.pathname === '/thinking/') return thinkingPage(req, env, ctx)
      const img = url.pathname.match(/^\/journal\/img\/(baf[a-z2-7]{20,100})$/)
      if (img) return journalImage(img[1], env, ctx)
      const k = url.pathname.match(/^\/known\/([^/]{3,253})\/?$/)
      if (k) return knownPage(decodeURIComponent(k[1]).toLowerCase(), req, env, ctx)
      const m = url.pathname.match(/^\/journal\/(\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,80})\/?$/)
      if (m) {
        const built = await site.fetch(req, env, ctx)
        return built.status === 404 ? journalEntry(m[1], req, env, ctx, built) : built
      }
    }
    return site.fetch(req, env, ctx)
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runBot(env, event, { pdsFetch: (r) => pds.fetch(r, env, ctx) }))
  },
}

const fromPds = (env, ctx, path) => pds.fetch(new Request(`https://${env.HOSTNAME}${path}`), env, ctx)

async function agentDid(env, ctx) {
  const res = await fromPds(env, ctx, '/.well-known/atproto-did')
  const did = res.ok ? (await res.text()).trim() : ''
  return /^did:plc:[a-z2-7]{24}$/.test(did) ? did : null
}

async function handleDid(env, ctx) {
  const did = await agentDid(env, ctx)
  if (!did) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  return new Response(did, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' } })
}

/**
 * A digest's image: a blob in autonomist's repository, served from the site's own origin so the CSP stays 'self'.
 * Only a JPEG, PNG or WebP, by its bytes (never the stored type), up to the size the digest stores.
 */
async function journalImage(cid, env, ctx) {
  const missing = () => withSecurity(new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300' } }))
  const did = await agentDid(env, ctx)
  if (!did) return missing()
  const res = await fromPds(env, ctx, `/xrpc/com.atproto.sync.getBlob?did=${did}&cid=${cid}`)
  if (!res.ok) return missing()
  const bytes = new Uint8Array(await res.arrayBuffer())
  const type = bytes.length <= MAX_IMAGE_BYTES ? sniffImage(bytes) : null
  if (!type) return missing()
  return withSecurity(new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=31536000, immutable' } }))
}

async function journalEntry(slug, req, env, ctx, notFound) {
  const did = await agentDid(env, ctx)
  if (!did) return notFound
  const res = await fromPds(env, ctx, `/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=${COLLECTION}&rkey=${slug}`)
  if (!res.ok) return notFound
  const rec = await res.json()
  const shell = await (await env.ASSETS.fetch(new Request(new URL('/_shell/journal.html', req.url)))).text()
  // its post on Bluesky, where people talk it over (written by announce, once it's posted)
  const post = env.KV ? await env.KV.get(postKey(slug)).catch(() => null) : null
  const html = fillShell(shell, { title: `${rec.value.title} · autonomist`, description: rec.value.summary, content: entryHtml(rec.value, { uri: rec.uri, origin: env.PUBLIC_ORIGIN, post }) })
  return withSecurity(new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } }))
}

// /known/<handle or DID>/: the note autonomist keeps on an account that opted in, or a page saying it keeps none
async function knownPage(id, req, env, ctx) {
  const notFound = () => withSecurity(new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } }))
  if (!HANDLE.test(id) && !DID.test(id)) return notFound()
  const me = await agentDid(env, ctx)
  if (!me) return notFound()
  let did = DID.test(id) ? id : null
  let name = DID.test(id) ? id : `@${id}`
  try {
    if (!did) {
      const r = await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(8000) })
      did = r.ok ? (await r.json()).did : null
      if (did && !DID.test(did)) did = null
    }
  } catch { did = null }
  const res = did ? await fromPds(env, ctx, `/xrpc/com.atproto.repo.getRecord?repo=${me}&collection=${ACQUAINTANCE}&rkey=${encodeURIComponent(did)}`) : null
  const rec = res?.ok ? await res.json() : null
  const shell = await (await env.ASSETS.fetch(new Request(new URL('/_shell/known.html', req.url)))).text()
  const html = fillShell(shell, { title: `What autonomist knows about ${name}`, description: `The public note autonomist keeps on ${name}, if it keeps one.`, content: knownHtml(rec?.value || null, { name, uri: rec?.uri || '' }) })
  const out = withSecurity(new Response(html, { status: rec ? 200 : 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' } }))
  out.headers.set('X-Robots-Tag', 'noindex')
  return out
}

async function journalIndex(req, env, ctx) {
  const built = await site.fetch(req, env, ctx)
  if (!built.ok) return built
  const html = await built.text()
  const headers = new Headers(built.headers)
  headers.delete('Content-Length')
  if (!html.includes('<div id="journal-list">')) return new Response(html, { status: built.status, headers })
  const did = await agentDid(env, ctx)
  const records = did ? await fromPds(env, ctx, `/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${COLLECTION}&limit=100`).then((r) => (r.ok ? r.json() : { records: [] })).catch(() => ({ records: [] })) : { records: [] }
  const index = await env.ASSETS.fetch(new Request(new URL('/content-index.json', req.url))).then((r) => r.json()).catch(() => ({}))
  const list = listHtml(listItems(index.journal, records.records, env.PUBLIC_ORIGIN))
  headers.set('Cache-Control', 'public, max-age=120')
  return new Response(html.replace(/<div id="journal-list">[\s\S]*?<\/div>/, () => `<div id="journal-list">${list}</div>`), { status: 200, headers })
}

// /thinking/: the community memory and the latest run-journal reflections, from autonomist's own repository
async function thinkingPage(req, env, ctx) {
  const built = await site.fetch(req, env, ctx)
  if (!built.ok) return built
  const html = await built.text()
  const headers = new Headers(built.headers)
  headers.delete('Content-Length')
  headers.set('Cache-Control', 'public, max-age=60')
  headers.set('Content-Security-Policy', THINKING_CSP)
  const did = await agentDid(env, ctx)
  const list = async (collection, limit) => (did ? fromPds(env, ctx, `/xrpc/com.atproto.repo.listRecords?repo=${did}&collection=${collection}&limit=${limit}`).then((r) => (r.ok ? r.json() : { records: [] })).catch(() => ({ records: [] })) : { records: [] })
  const [logs, mems, dreams] = await Promise.all([list(LOG, 60), list(MEMORY, 20), list(DREAM, 21)])
  const latest = [...(mems.records || [])].sort((a, b) => String(b.value?.createdAt).localeCompare(String(a.value?.createdAt)))[0]
  const out = html
    .replace(/<div id="thinking-memory">[\s\S]*?<\/div>/, () => `<div id="thinking-memory">${memoryHtml(latest)}</div>`)
    .replace(/<div id="thinking-log">[\s\S]*?<\/div>/, () => `<div id="thinking-log">${logHtml(logs.records, env.PUBLIC_ORIGIN)}</div>`)
    .replace(/<div id="thinking-dreams">[\s\S]*?<\/div>/, () => `<div id="thinking-dreams">${dreamsHtml(dreams.records)}</div>`)
  return new Response(out, { status: 200, headers })
}
