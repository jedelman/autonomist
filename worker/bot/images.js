// Each story's image in the digest (Jason, 2026-11-27; his pick: kept in autonomist's own repository). The image is
// the one the publisher offers for link cards (og:image or twitter:image), fetched only where robots.txt and
// Content-Signal allow, the way autonomist reads a page. It's stored as a blob in autonomist's repository, as a
// Bluesky link card's thumbnail is, and the site serves it from its own origin (/journal/img/<cid>), so the strict
// CSP stays as it is and no reader's browser calls a publisher. Credited to the outlet; taken down on request.
import { fetchReadable } from '../journal-core.js'

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const MAX_IMAGE_BYTES = 1_000_000

/** An image's type from its first bytes, or null: the server's Content-Type is never trusted. */
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || [])
  if (b.length < 12) return null
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a) return 'image/png'
  const tag = (i) => String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3])
  if (tag(0) === 'RIFF' && tag(8) === 'WEBP') return 'image/webp'
  return null
}

/** A blob's CID, if it's one this site will serve: CIDv1 in base32. */
export const blobCid = (blob) => {
  const cid = String(blob?.ref?.$link || blob?.ref || '')
  return /^baf[a-z2-7]{20,100}$/.test(cid) ? cid : null
}

/** Reads a body up to `max` bytes; null if it's longer. */
async function readCapped(res, max) {
  if (!res.body?.getReader) {
    const b = new Uint8Array(await res.arrayBuffer())
    return b.length > max ? null : b
  }
  const reader = res.body.getReader()
  const parts = []
  let n = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    n += value.length
    if (n > max) { await reader.cancel().catch(() => {}); return null }
    parts.push(value)
  }
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

/** Fetches one image, where its host allows: { bytes, type } or null. */
export async function fetchImage(url, { fetch: f = fetch, cache = new Map() } = {}) {
  if (!/^https:\/\/[^\s]+$/.test(String(url || ''))) return null
  try {
    const { res } = await fetchReadable(url, { fetch: f, cache, accept: 'image/webp,image/jpeg,image/png;q=0.9' })
    if (!res.ok) return null
    if (Number(res.headers.get('content-length') || 0) > MAX_IMAGE_BYTES) return null
    const bytes = await readCapped(res, MAX_IMAGE_BYTES)
    const type = bytes && sniffImage(bytes)
    return type ? { bytes, type } : null
  } catch { return null }
}

/**
 * Gives each of the top `limit` stories an image: the first of its articles (at most two tried) whose publisher offers
 * one autonomist may fetch. Sets `story.image` to { blob, alt, outlet, article, from }. Never throws: a story without
 * an image is a story without an image.
 */
export async function storeImages({ api, stories, fetch: f = fetch, cache = new Map(), limit = 6 }) {
  if (typeof api?.uploadBlob !== 'function') return 0
  let stored = 0
  await Promise.all(stories.slice(0, limit).map(async (st) => {
    for (const a of (st.articles || []).filter((x) => x.image).slice(0, 2)) {
      const img = await fetchImage(a.image, { fetch: f, cache })
      if (!img) continue
      try {
        const blob = await api.uploadBlob(img.bytes, img.type)
        if (!blobCid(blob)) continue
        st.image = { blob, alt: String(a.title || '').slice(0, 300), outlet: String(a.outlet || '').slice(0, 80), article: a.url, from: a.image }
        stored++
        return
      } catch { /* the next article's image, if any */ }
    }
  }))
  return stored
}
