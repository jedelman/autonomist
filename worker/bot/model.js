// One structured call to the model, priced and capped. Every bot call asks for JSON against a schema
// (output_config.format), which works with Haiku 5.5's thinking; forced tool choice would not be reliable there.
// Spend counts toward the site's daily cap (DAILY_BUDGET_USD) and the bot's own (BOT_DAILY_BUDGET_USD), so the
// bot can never use up the chat's budget.
import Anthropic from '@anthropic-ai/sdk'
import { PRICES, priceOf, spentToday, recordSpend, setting } from '../limits.js'

export class BudgetError extends Error {}

async function botSpentToday(kv, day) {
  let micros = 0, cursor
  do {
    const page = await kv.list({ prefix: `botspend:${day}:`, cursor })
    for (const k of page.keys) micros += Number(k.metadata?.micros || 0)
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return micros / 1e6
}

// Web search, $10 per 1,000 searches on the Claude API, on top of tokens (the web search tool's page, read
// 2026-11-23). Counted from usage.server_tool_use.web_search_requests.
export const SEARCH_USD = 0.01

async function ready({ env, kv, day, create }) {
  const model = env.MODEL || 'claude-haiku-5-5'
  if (!PRICES[model]) throw new Error(`no price for ${model}`)
  if ((await spentToday(kv, day)) >= setting(env.DAILY_BUDGET_USD, 3, { min: 0 })) throw new BudgetError('site budget reached')
  if ((await botSpentToday(kv, day)) >= setting(env.BOT_DAILY_BUDGET_USD, 1, { min: 0 })) throw new BudgetError('bot budget reached')
  if (!create) {
    if (!env.ANTHROPIC_API_KEY) throw new Error('no ANTHROPIC_API_KEY')
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 180_000 })
    create = (params, options) => client.messages.create(params, options)
  }
  return { model, create }
}

async function charge(kv, day, usd) {
  const micros = Math.round(usd * 1e6)
  // fails closed: if the spend can't be recorded, the step stops here rather than spend uncounted
  await Promise.all([
    recordSpend(kv, day, usd),
    micros ? kv.put(`botspend:${day}:${crypto.randomUUID()}`, '', { metadata: { micros }, expirationTtl: 8 * 86400 }) : null,
  ])
}

/**
 * A call with Anthropic's web search tool (basic version, which Haiku 5.5 supports). Plain text out, with the
 * citations the API attaches; no structured output in the same call, since search citations are always on and
 * citations don't mix with output_config.format. Continues a paused turn up to twice. Returns the content blocks.
 */
export async function searchCall({ env, kv, day, system, user, maxUses = 3, maxTokens = 8000, create }) {
  const r = await ready({ env, kv, day, create })
  const messages = [{ role: 'user', content: user }]
  let res, usd = 0, searches = 0
  for (let turn = 0; turn < 3; turn++) {
    // max_uses holds per request, so a continued turn gets only what's left of the call's searches
    res = await r.create({ model: r.model, max_tokens: maxTokens, system, tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: Math.max(1, maxUses - searches) }], output_config: { effort: 'medium' }, messages })
    const n = Number(res.usage?.server_tool_use?.web_search_requests || 0)
    searches += n
    const cost = (priceOf(r.model, res.usage) || 0) + n * SEARCH_USD
    usd += cost
    await charge(kv, day, cost)
    if (res.stop_reason !== 'pause_turn' || searches >= maxUses) break
    messages.push({ role: 'assistant', content: res.content })
  }
  if (res.stop_reason === 'refusal') throw new Error('the model declined')
  return { content: res.content || [], usd, searches }
}

// `timeout` and `retries` override the client's (3 minutes, 2 retries) for one call: a long call (the digest's
// synthesis, whose thinking counts toward max_tokens) needs longer, and shouldn't be paid for again on a timeout.
export async function structured({ env, kv, day, system, user, schema, effort = 'medium', maxTokens = 16000, timeout, retries, create: given }) {
  const { model, create } = await ready({ env, kv, day, create: given })
  const options = { ...(timeout ? { timeout } : {}), ...(retries !== undefined ? { maxRetries: retries } : {}) }
  const res = await create({
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  }, options)
  const usd = priceOf(model, res.usage) || 0
  await charge(kv, day, usd)
  if (res.stop_reason === 'refusal') throw new Error('the model declined')
  if (res.stop_reason === 'max_tokens') throw new Error('the output was cut off')
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  return { data: JSON.parse(text), usd }
}

/** A JSON schema object with every property required and nothing extra (what structured outputs need). */
export const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
