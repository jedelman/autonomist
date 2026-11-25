// A tiny in-memory stand-in for Workers KV and the static-assets binding.
export function memoryKV() {
  const m = new Map()
  return {
    m,
    async get(k, type) { const e = m.get(k); if (!e) return null; return type === 'json' ? JSON.parse(e.v) : e.v },
    async getWithMetadata(k) { const e = m.get(k); return e ? { value: e.v, metadata: e.metadata ?? null } : { value: null, metadata: null } },
    async put(k, v, opts = {}) { m.set(k, { v: String(v), metadata: opts.metadata }) },
    async delete(k) { m.delete(k) },
    async list({ prefix = '' } = {}) { return { keys: [...m].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata })), list_complete: true } },
  }
}
export const assets = { fetch: async (req) => new Response(new URL(req.url).pathname === '/content-index.json' ? '{"model":[{"slug":"results","title":"Results","url":"/model/results/","text":"tables"}]}' : '<!doctype html><title>page</title>', { headers: { 'Content-Type': 'text/html' } }) }

/**
 * KV that holds to Workers KV's limit of one write a second per key: a second write (or delete) to a key throws, as
 * Cloudflare's does ("KV PUT failed: 429"). Time moves only when `clock.t` does (a test's sleep advances it), so any
 * key written twice in one request or run fails the test.
 */
export function strictKV(clock = { t: 0 }) {
  const kv = memoryKV()
  const last = new Map()
  const guard = (k) => {
    if (last.has(k) && clock.t - last.get(k) < 1000) throw new Error(`KV PUT failed: 429 Too Many Requests (${k})`)
    last.set(k, clock.t)
  }
  return { ...kv, m: kv.m, clock, async put(k, v, o) { guard(k); return kv.put(k, v, o) }, async delete(k) { guard(k); return kv.delete(k) } }
}
