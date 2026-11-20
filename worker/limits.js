// Limits: settings read safely, visitor ids, and the daily spend cap. Adapted from Siren's
// worker/limits.js (github.com/jedelman/socrata-agent, MIT, the same author).

/** A numeric setting. A typo must not switch a limit off: anything not a finite number >= min falls back. */
export function setting(value, fallback, { min = 0, max = Infinity } = {}) {
  const n = Number(value)
  if (value === undefined || value === '' || !Number.isFinite(n) || n < min) return fallback
  return Math.min(n, max)
}

/** Who a visitor is, for per-visitor limits: the /64 for IPv6, the address for IPv4. */
export function visitorId(ip) {
  if (!ip) return 'unknown'
  if (!ip.includes(':')) return ip
  const [head, tail = ''] = ip.toLowerCase().split('::')
  const left = head ? head.split(':') : []
  const right = tail ? tail.split(':') : []
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/** Hash a visitor id under a salt, so limits never store an address. */
export async function visitorHash(salt, ip) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(salt), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(visitorId(ip))))
  return [...sig.slice(0, 16)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

// Spend: one KV key per priced model call (spend:<day>:<uuid>, cost in metadata), summed by
// listing, so concurrent calls can't overwrite each other. A listing can lag a few seconds.
export async function spentToday(kv, day) {
  let micros = 0
  let cursor
  do {
    const page = await kv.list({ prefix: `spend:${day}:`, cursor })
    for (const k of page.keys) micros += Number(k.metadata?.micros || 0)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return micros / 1e6
}

export function recordSpend(kv, day, usd) {
  const micros = Math.round(usd * 1e6)
  if (!micros) return Promise.resolve()
  return kv.put(`spend:${day}:${crypto.randomUUID()}`, '', { metadata: { micros }, expirationTtl: 8 * 86400 })
}

// Claude Haiku 5.5 prices, USD per million tokens (the claude-api reference, cached 2026-11-03):
// $0.10 in / $0.50 out for prompts of 100K tokens or fewer, $0.50 / $2.50 above; cache reads 0.1x
// input, 5-minute cache writes 1.25x. A model with no price here is refused, so spend is never
// uncounted.
export const PRICES = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, longOver: 100_000, long: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } },
}

export function priceOf(model, usage) {
  const p = PRICES[model]
  if (!p || !usage) return null
  const prompt = (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0)
  const r = p.longOver && prompt > p.longOver ? p.long : p
  return ((usage.input_tokens || 0) * r.input + (usage.output_tokens || 0) * r.output + (usage.cache_read_input_tokens || 0) * r.cacheRead + (usage.cache_creation_input_tokens || 0) * r.cacheWrite) / 1e6
}
