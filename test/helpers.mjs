// A tiny in-memory stand-in for Workers KV and the static-assets binding.
export function memoryKV() {
  const m = new Map()
  return {
    m,
    async get(k, type) { const e = m.get(k); if (!e) return null; return type === 'json' ? JSON.parse(e.v) : e.v },
    async put(k, v, opts = {}) { m.set(k, { v: String(v), metadata: opts.metadata }) },
    async delete(k) { m.delete(k) },
    async list({ prefix = '' } = {}) { return { keys: [...m].filter(([k]) => k.startsWith(prefix)).map(([name, e]) => ({ name, metadata: e.metadata })), list_complete: true } },
  }
}
export const assets = { fetch: async (req) => new Response(new URL(req.url).pathname === '/content-index.json' ? '{"model":[{"slug":"results","title":"Results","url":"/model/results/","text":"tables"}]}' : '<!doctype html><title>page</title>', { headers: { 'Content-Type': 'text/html' } }) }
