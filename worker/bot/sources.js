// Where the journal's news comes from (Jason, 2026-11-23: "Opt out for sources, starting with my follows"): the links
// that the accounts Jason follows on Bluesky share. The follow list is refreshed daily; each tick reads a few of
// those accounts' recent posts (a full sweep takes about a day) and keeps the links as candidates for two days.
// Reading a linked page is decided later, by robots.txt and Content-Signal.

const SKIP_HOSTS = /(^|\.)(bsky\.app|bsky\.social|go\.bsky\.app|bsky\.network|youtube\.com|youtu\.be|tiktok\.com|instagram\.com|x\.com|twitter\.com|facebook\.com|twitch\.tv|spotify\.com|open\.spotify\.com|tenor\.com|giphy\.com)$/i
const MEDIA = /\.(png|jpe?g|gif|webp|mp4|mov|mp3|pdf)(\?|$)/i
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
  const out = new Map()
  const add = (uri, title = '', description = '') => {
    const url = normalizeUrl(uri)
    if (!url || MEDIA.test(url) || SKIP_HOSTS.test(new URL(url).hostname)) return
    if (!out.has(url)) out.set(url, { url, title, description })
  }
  const ext = post.embed?.external || post.embed?.media?.external
  if (ext?.uri) add(ext.uri, ext.title, ext.description)
  for (const f of post.record?.facets || []) for (const feat of f.features || []) if (feat.$type === 'app.bsky.richtext.facet#link' && feat.uri) add(feat.uri)
  return [...out.values()].map((l) => ({ ...l, handle: post.author?.handle || '', post: post.uri, at: post.indexedAt }))
}

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
export function candidateMetadata(l) {
  const m = { u: clipBytes(l.url, 300), t: clipBytes(l.title, 200), d: clipBytes(l.description, 250), h: clipBytes(l.handle, 60), p: clipBytes(l.post, 120), at: String(l.at || '').slice(0, 30) }
  return enc.encode(JSON.stringify(m)).length <= 1000 ? m : { ...m, d: '' }
}

/** Reads the next `n` followed accounts' recent posts and stores the links they shared as candidates. */
export async function sweep(api, kv, n, now = Date.now()) {
  const list = await kv.get('bot:follows', 'json')
  if (!list?.follows?.length) return { skipped: 'no follow list yet' }
  const start = Number((await kv.get('bot:follows:cursor')) || 0) % list.follows.length
  let found = 0, read = 0, failed = 0
  try {
    for (let k = 0; k < Math.min(n, list.follows.length); k++) {
      const who = list.follows[(start + k) % list.follows.length]
      read++
      const feed = await api.pub('app.bsky.feed.getAuthorFeed', { actor: who.did, limit: 10, filter: 'posts_no_replies' }).catch(() => null)
      for (const item of feed?.feed || []) {
        if (now - Date.parse(item.post?.indexedAt || 0) > 1.5 * DAY) continue
        for (const l of linksFromItem(item)) {
          if (l.url.length > 300) continue
          try {
            await kv.put(`cand:${await hashUrl(l.url)}`, '', { metadata: candidateMetadata(l), expirationTtl: 2 * 86400 })
            found++
          } catch { failed++ }
        }
      }
    }
  } finally {
    // past every account read, even if one of them failed, so the sweep never sticks on one post
    await kv.put('bot:follows:cursor', String((start + read) % list.follows.length))
  }
  return { read, links: found, ...(failed ? { failed } : {}) }
}

/** Candidate links not yet covered, newest first. */
export async function candidates(kv, covered = new Set(), limit = 150) {
  const out = []
  let cursor
  do {
    const page = await kv.list({ prefix: 'cand:', cursor })
    for (const k of page.keys) if (k.metadata?.u && !covered.has(k.name.slice(5))) out.push({ key: k.name.slice(5), url: k.metadata.u, title: k.metadata.t, description: k.metadata.d, handle: k.metadata.h, post: k.metadata.p, at: k.metadata.at })
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor && out.length < 2000)
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, limit)
}
