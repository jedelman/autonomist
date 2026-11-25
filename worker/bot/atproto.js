// autonomist's own account, from inside its Worker. Calls to its PDS go straight to pds.js (no network); public
// reads go to Bluesky's public API. The session is kept in KV and refreshed near expiry; it logs in only when it
// has to, and counts the logins (the notebook's lesson: keep your session).
import { fits, linkFacets } from './text.js'

export const PUBLIC_API = 'https://public.api.bsky.app'
export const UA = 'autonomist/1.0 (+https://autonomist.jason-edelman.org/about/)'

export function jwtExp(jwt) {
  try {
    const part = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return Number(JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4))).exp) || 0
  } catch { return 0 }
}

export function client(env, { pdsFetch, kv, fetch: f = fetch, now = () => Date.now() }) {
  const base = `https://${env.HOSTNAME}`

  async function raw(method, nsid, { params, body, token } = {}) {
    const url = new URL(`/xrpc/${nsid}`, base)
    for (const [k, v] of Object.entries(params || {})) for (const x of [].concat(v)) if (x !== undefined && x !== null) url.searchParams.append(k, String(x))
    const headers = {}
    if (body) headers['content-type'] = 'application/json'
    if (token) headers.authorization = `Bearer ${token}`
    const res = await pdsFetch(new Request(url, { method, headers, body: body ? JSON.stringify(body) : undefined }))
    const text = await res.text()
    let data = text
    try { data = JSON.parse(text) } catch {}
    if (!res.ok) {
      const e = new Error(`${nsid} ${res.status}: ${typeof data === 'object' ? `${data.error || ''} ${data.message || ''}`.trim() : String(data).slice(0, 200)}`)
      e.status = res.status
      e.code = typeof data === 'object' ? data.error : undefined
      e.detail = typeof data === 'object' ? data.message : undefined
      throw e
    }
    return data
  }

  const store = (s) => kv.put('bot:session', JSON.stringify({ did: s.did, handle: s.handle, accessJwt: s.accessJwt, refreshJwt: s.refreshJwt }), { expirationTtl: 60 * 86400 })

  async function session({ fresh = false } = {}) {
    const t = now() / 1000
    let s = fresh ? null : await kv.get('bot:session', 'json')
    if (s && jwtExp(s.accessJwt) - t > 300) return s
    if (s?.refreshJwt && jwtExp(s.refreshJwt) - t > 60) {
      try {
        const r = await raw('POST', 'com.atproto.server.refreshSession', { token: s.refreshJwt })
        await store(r)
        console.log(JSON.stringify({ bot: 'session', how: 'refresh' }))
        return r
      } catch (e) {
        // only a refresh token the PDS won't accept calls for a new login; anything else (a 5xx, say) waits
        if (e.status !== 400 && e.status !== 401) throw e
      }
    }
    if (!env.PDS_PASSWORD) throw new Error('no PDS_PASSWORD: the bot cannot sign in')
    if (await kv.get('bot:login:backoff')) throw new Error('a recent login failed; waiting before trying again')
    let r
    try {
      r = await raw('POST', 'com.atproto.server.createSession', { body: { identifier: env.BOT_HANDLE || 'autonomist.jason-edelman.org', password: env.PDS_PASSWORD } })
    } catch (e) {
      await kv.put('bot:login:backoff', String(e.status || 'error'), { expirationTtl: 900 })
      throw e
    }
    await store(r)
    const day = new Date(now()).toISOString().slice(0, 10)
    const n = Number((await kv.get(`bot:logins:${day}`)) || 0) + 1
    await kv.put(`bot:logins:${day}`, String(n), { expirationTtl: 8 * 86400 })
    console.log(JSON.stringify({ bot: 'session', how: 'login', today: n }))
    return r
  }

  async function call(method, nsid, opts = {}) {
    const s = await session()
    try {
      return await raw(method, nsid, { ...opts, token: s.accessJwt })
    } catch (e) {
      // only a token the PDS no longer accepts calls for a new session; other 401s (an upstream refusing a
      // proxied call, say) would otherwise log in again on every tick
      // (pds.js answers a token it won't accept with "Authentication required"; a proxied call the app view refuses
      // comes back with another message)
      const stale = ['ExpiredToken', 'InvalidToken'].includes(e.code) || e.detail === 'Authentication required'
      if (e.status !== 401 || !stale) throw e
      const s2 = await session({ fresh: true })
      return raw(method, nsid, { ...opts, token: s2.accessJwt })
    }
  }

  async function pub(nsid, params = {}) {
    const url = new URL(`/xrpc/${nsid}`, PUBLIC_API)
    for (const [k, v] of Object.entries(params)) for (const x of [].concat(v)) if (x !== undefined && x !== null) url.searchParams.append(k, String(x))
    const res = await f(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`${nsid} ${res.status}`)
    return res.json()
  }

  /**
   * Publishes a post from autonomist's account. `links` in the text become clickable; `card` ({ uri, title,
   * description }) attaches a link card instead, leaving the text's room for the words. `lang` tags the post with
   * the language it's written in (English unless given). Nothing is ever an @mention.
   */
  async function post({ text, links = [], reply, card, quote, lang }) {
    if (!fits(text)) throw new Error('post too long')
    const s = await session()
    const facets = linkFacets(text, links)
    // a quote-post embeds another post by reference; otherwise a link card, if any
    const embed = quote?.uri && quote?.cid
      ? { $type: 'app.bsky.embed.record', record: { uri: quote.uri, cid: quote.cid } }
      : card?.uri ? { $type: 'app.bsky.embed.external', external: { uri: card.uri, title: String(card.title || '').slice(0, 300), description: String(card.description || '').slice(0, 1000) } } : null
    const record = { $type: 'app.bsky.feed.post', text, createdAt: new Date(now()).toISOString(), langs: [cleanLang(lang)], ...(facets.length ? { facets } : {}), ...(reply ? { reply } : {}), ...(embed ? { embed } : {}) }
    return call('POST', 'com.atproto.repo.createRecord', { body: { repo: s.did, collection: 'app.bsky.feed.post', record } })
  }

  return { raw, session, call, pub, post }
}

/** A language tag for a post: a plain BCP-47 code ("en", "ja", "pt-BR"), or English. */
export function cleanLang(lang) {
  const l = String(lang || '').trim()
  return /^[a-z]{2,3}(-[A-Za-z0-9]{2,8}){0,2}$/.test(l) ? l : 'en'
}
