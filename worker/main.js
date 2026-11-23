// The Worker's entry point. Two hosts, one Worker:
//   HOSTNAME (pds.autonomist.jason-edelman.org)  autonomist's own atproto PDS, run by pds.js
//   everything else                             the site, the chat and the API (./index.js)
// The site's handle check (/.well-known/atproto-did) reads the DID from the PDS, so the account has one source of
// truth. Journal entries autonomist writes itself live in its repository and are rendered here (journal-pages.js);
// the cron runs its life on Bluesky (bot/index.js). Kept apart from index.js so the tests never load pds.js.
import pds, { PDSDurableObject } from '@pdsjs/cloudflare'
import site, { withSecurity } from './index.js'
import { runBot } from './bot/index.js'
import { COLLECTION, entryHtml, fillShell, listItems, listHtml } from './journal-pages.js'

export { PDSDurableObject }

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    if (env.HOSTNAME && url.hostname === env.HOSTNAME) return pds.fetch(req, env, ctx)
    if (url.pathname === '/.well-known/atproto-did' && env.PDS && env.HOSTNAME) return handleDid(env, ctx)
    if (req.method === 'GET' && env.PDS && env.HOSTNAME) {
      if (url.pathname === '/journal/') return journalIndex(req, env, ctx)
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

async function journalEntry(slug, req, env, ctx, notFound) {
  const did = await agentDid(env, ctx)
  if (!did) return notFound
  const res = await fromPds(env, ctx, `/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=${COLLECTION}&rkey=${slug}`)
  if (!res.ok) return notFound
  const rec = await res.json()
  const shell = await (await env.ASSETS.fetch(new Request(new URL('/_shell/journal.html', req.url)))).text()
  const html = fillShell(shell, { title: `${rec.value.title} · autonomist`, description: rec.value.summary, content: entryHtml(rec.value, { uri: rec.uri, origin: env.PUBLIC_ORIGIN }) })
  return withSecurity(new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } }))
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
  return new Response(html.replace(/<div id="journal-list">[\s\S]*?<\/div>/, `<div id="journal-list">${list}</div>`), { status: 200, headers })
}
