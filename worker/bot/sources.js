// Where the journal's news comes from (Jason, 2026-11-23: "Opt out for sources, starting with my follows"): the links
// that the accounts Jason follows on Bluesky share. The follow list is refreshed daily; each tick reads a few of
// those accounts' recent posts (a full sweep takes about a day) and keeps the links as candidates for two days.
// Reading a linked page is decided later, by robots.txt and Content-Signal.

const SKIP_HOSTS = /(^|\.)(bsky\.app|bsky\.social|go\.bsky\.app|bsky\.network|youtube\.com|youtu\.be|tiktok\.com|instagram\.com|x\.com|twitter\.com|facebook\.com|twitch\.tv|spotify\.com|open\.spotify\.com|tenor\.com|giphy\.com)$/i
const MEDIA = /\.(png|jpe?g|gif|webp|mp4|mov|mp3|pdf)(\?|$)/i
// Never news: autonomist's own site and posts, and the rest of Jason's (Power Explained, his site, Claude's). Jason
// follows autonomist, so without this the sweep read its own journal announcement and the 16:07 question on
// 2026-11-24 was about its own entry, a second post on the same story.
const OWN_HOSTS = /(^|\.)jason-edelman\.org$/i
const OWN_HANDLES = /(^|\.)jason-edelman\.org$/i

/** Whether a link is one of autonomist's own or its steward's, which are never news for it. */
export function isOwn(url) {
  try { return OWN_HOSTS.test(new URL(url).hostname) } catch { return false }
}
const DAY = 86400_000

export function normalizeUrl(u) {
  try {
    const url = new URL(u)
    if (!/^https?:$/.test(url.protocol)) return null
    url.hash = ''
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$|ref_src|s$|si$)/i.test(k)) url.searchParams.delete(k)
    url.protocol = 'https:'
    return url.toString().replace(/\/$/, '')
  } catch { return null }
}

/** Links shared in one author-feed item: an external embed, or link facets. Original posts only, not reposts. */
export function linksFromItem(item) {
  if (item?.reason) return []
  const post = item?.post
  if (!post) return []
  // autonomist's own posts (and any account on Jason's domain) are never a source of news for it
  if (OWN_HANDLES.test(post.author?.handle || '') || post.author?.did === 'did:plc:kmswr7d5c55rc4ot2dbn6sfq') return []
  const out = new Map()
  const add = (uri, title = '', description = '') => {
    const url = normalizeUrl(uri)
    if (!url || MEDIA.test(url) || SKIP_HOSTS.test(new URL(url).hostname) || isOwn(url)) return
    if (!out.has(url)) out.set(url, { url, title, description })
  }
  const ext = post.embed?.external || post.embed?.media?.external
  if (ext?.uri) add(ext.uri, ext.title, ext.description)
  for (const f of post.record?.facets || []) for (const feat of f.features || []) if (feat.$type === 'app.bsky.richtext.facet#link' && feat.uri) add(feat.uri)
  return [...out.values()].map((l) => ({ ...l, handle: post.author?.handle || '', did: post.author?.did || '', post: post.uri, cid: post.cid || '', at: post.indexedAt }))
}

/**
 * Whether an account is the publisher of a link: its handle is the link's site, or one of the site's own names
 * ("theguardian.com" for www.theguardian.com, "bsky.example.com" for example.com). Quote-posts (Jason, 2026-11-25: "let's
 * have autonomist prefer quote-posts"; his pick: publishers' own posts and opted-in people's) only ever quote these and
 * the opted-in.
 */
export function isPublisher(handle, url) {
  const h = String(handle || '').toLowerCase()
  let host
  try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return false }
  if (!h.includes('.') || /\.bsky\.social$/.test(h) || OWN_HANDLES.test(h)) return false
  return host === h || host.endsWith(`.${h}`) || h.endsWith(`.${host}`)
}

/** A quotable post of a link (a publisher's own, or an opted-in person's), kept three days. */
export const quoteKey = async (url) => `quote:${await hashUrl(url)}`

export async function hashUrl(url) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url)))
  return [...d.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function refreshFollows(api, kv, actor) {
  const follows = []
  let cursor
  do {
    const r = await api.pub('app.bsky.graph.getFollows', { actor, limit: 100, cursor })
    for (const f of r.follows || []) follows.push({ did: f.did, handle: f.handle })
    cursor = r.cursor
  } while (cursor && follows.length < 10000)
  await kv.put('bot:follows', JSON.stringify({ at: Date.now(), actor, follows }))
  return { follows: follows.length }
}

const enc = new TextEncoder()
/** Cuts a string to at most `max` UTF-8 bytes, on a character boundary. */
export function clipBytes(s, max) {
  let out = ''
  for (const ch of String(s || '')) {
    if (enc.encode(out + ch).length > max) break
    out += ch
  }
  return out
}

/** KV metadata for a candidate, under KV's 1,024-byte limit whatever the script. */
export function candidateMetadata(l, sids = []) {
  // s: short ids (hashes) of the accounts that shared it, so the digest can count different people without keeping
  // who they are; up to twenty
  let m = { u: clipBytes(l.url, 300), t: clipBytes(l.title, 200), d: clipBytes(l.description, 200), h: clipBytes(l.handle, 60), p: clipBytes(l.post, 120), at: String(l.at || '').slice(0, 30), s: sids.slice(0, 20) }
  // KV metadata is capped at 1,024 bytes: shed the description, then shorten the title and the sharer list, measuring
  // each time (JSON escaping can grow a string)
  const size = () => enc.encode(JSON.stringify(m)).length
  if (size() > 1000) m = { ...m, d: '' }
  if (size() > 1000) m = { ...m, t: clipBytes(m.t, 100), s: m.s.slice(0, 10) }
  if (size() > 1000) m = { ...m, t: clipBytes(m.t, 40), p: '', s: m.s.slice(0, 5) }
  return m
}

/** A short, one-way id for an account: enough to count different sharers, not to say who they are. */
export const sharerId = async (did) => (await hashUrl(`sharer:${did}`)).slice(0, 8)

/** Reads the next `n` followed accounts' recent posts and stores the links they shared as candidates. */
export async function sweep(api, kv, n, now = Date.now()) {
  const list = await kv.get('bot:follows', 'json')
  if (!list?.follows?.length) return { skipped: 'no follow list yet' }
  const start = Number((await kv.get('bot:follows:cursor')) || 0) % list.follows.length
  let found = 0, read = 0, failed = 0
  // Workers KV takes one write a second per key: two follows sharing one link in a run would write its key twice, and
  // the second would throw. So the run gathers each link's merge here and writes every key once, at the end.
  const merges = new Map()
  const quotes = new Map()
  const opted = new Set(((await kv.get('bot:optin', 'json'))?.people || []).filter((p) => !p.bot).map((p) => p.did))
  try {
    for (let k = 0; k < Math.min(n, list.follows.length); k++) {
      const who = list.follows[(start + k) % list.follows.length]
      read++
      const feed = await api.pub('app.bsky.feed.getAuthorFeed', { actor: who.did, limit: 10, filter: 'posts_no_replies' }).catch(() => null)
      const sid = await sharerId(who.did)
      for (const item of feed?.feed || []) {
        if (now - Date.parse(item.post?.indexedAt || 0) > 1.5 * DAY) continue
        // a self-labeled bot's links aren't the network's reading
        if ((item.post?.author?.labels || []).some((l) => l.val === 'bot' && l.src === item.post.author.did)) continue
        for (const l of linksFromItem(item)) {
          if (l.url.length > 300) continue
          try {
            const key = `cand:${await hashUrl(l.url)}`
            // the same link from someone else adds them to its sharers
            const prev = merges.has(key) ? merges.get(key) : kv.getWithMetadata ? (await kv.getWithMetadata(key))?.metadata : null
            const sids = [...new Set([...(prev?.s || []), sid])]
            // a later share that only pastes the bare link has no title: keep the card's title and description; and the
            // latest share time, so a link still being shared today counts today
            const merged = { ...l, title: l.title || prev?.t || '', description: l.description || prev?.d || '', at: prev?.at && prev.at > l.at ? prev.at : l.at }
            merges.set(key, candidateMetadata(merged, sids))
            // a post autonomist may quote: the publisher's own, or an opted-in person's (a publisher's is preferred)
            const kind = isPublisher(l.handle, l.url) ? 'publisher' : opted.has(l.did) ? 'opted-in' : null
            if (kind && l.post && l.cid) {
              const qk = await quoteKey(l.url)
              const had = quotes.get(qk)
              if (!had || (had.kind !== 'publisher' && kind === 'publisher')) quotes.set(qk, { uri: l.post, cid: l.cid, did: l.did, handle: l.handle, kind, at: l.at })
            }
            found++
          } catch { failed++ }
        }
      }
    }
  } finally {
    for (const [key, metadata] of merges) await kv.put(key, '', { metadata, expirationTtl: 2 * 86400 }).catch(() => { failed++ })
    for (const [key, q] of quotes) {
      // a publisher's post already kept isn't replaced by an opted-in person's
      const have = await kv.get(key, 'json').catch(() => null)
      if (have?.kind === 'publisher' && q.kind !== 'publisher') continue
      await kv.put(key, JSON.stringify(q), { expirationTtl: 3 * 86400 }).catch(() => { failed++ })
    }
    // past every account read, even if one of them failed, so the sweep never sticks on one post
    await kv.put('bot:follows:cursor', String((start + read) % list.follows.length))
  }
  return { read, links: found, ...(quotes.size ? { quotable: quotes.size } : {}), ...(failed ? { failed } : {}) }
}

/** Candidate links not yet covered, newest first. */
export async function candidates(kv, covered = new Set(), limit = 150) {
  const out = []
  let cursor
  do {
    const page = await kv.list({ prefix: 'cand:', cursor })
    // candidates stored before the own-links rule are skipped here too
    for (const k of page.keys) if (k.metadata?.u && !covered.has(k.name.slice(5)) && !isOwn(k.metadata.u) && !OWN_HANDLES.test(k.metadata.h || '')) out.push({ key: k.name.slice(5), url: k.metadata.u, title: k.metadata.t, description: k.metadata.d, handle: k.metadata.h, post: k.metadata.p, at: k.metadata.at, sids: k.metadata.s?.length ? k.metadata.s : [k.metadata.h || k.name], sharers: Math.max(1, k.metadata.s?.length || 0) })
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor && out.length < 6000)
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit)
}
