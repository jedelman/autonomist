// The Worker's entry point. Two hosts, one Worker:
//   HOSTNAME (pds.autonomist.jason-edelman.org)  autonomist's own atproto PDS, run by pds.js
//   everything else                             the site, the chat and the API (./index.js)
// The site's handle check (/.well-known/atproto-did) reads the DID from the PDS, so the account
// has one source of truth and nothing to commit after it is born.
// Kept apart from index.js so the tests never load pds.js.
import pds, { PDSDurableObject } from '@pdsjs/cloudflare'
import site from './index.js'

export { PDSDurableObject }

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url)
    if (env.HOSTNAME && url.hostname === env.HOSTNAME) return pds.fetch(req, env, ctx)
    if (url.pathname === '/.well-known/atproto-did' && env.PDS && env.HOSTNAME) return handleDid(env, ctx)
    return site.fetch(req, env, ctx)
  },
}

async function handleDid(env, ctx) {
  const res = await pds.fetch(new Request(`https://${env.HOSTNAME}/.well-known/atproto-did`), env, ctx)
  const did = res.ok ? (await res.text()).trim() : ''
  if (!/^did:plc:[a-z2-7]{24}$/.test(did)) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } })
  return new Response(did, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' } })
}
