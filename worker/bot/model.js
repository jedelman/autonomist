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

export async function structured({ env, kv, day, system, user, schema, effort = 'medium', maxTokens = 16000, create }) {
  const model = env.MODEL || 'claude-haiku-5-5'
  if (!PRICES[model]) throw new Error(`no price for ${model}`)
  if ((await spentToday(kv, day)) >= setting(env.DAILY_BUDGET_USD, 3, { min: 0 })) throw new BudgetError('site budget reached')
  if ((await botSpentToday(kv, day)) >= setting(env.BOT_DAILY_BUDGET_USD, 1, { min: 0 })) throw new BudgetError('bot budget reached')
  if (!create) {
    if (!env.ANTHROPIC_API_KEY) throw new Error('no ANTHROPIC_API_KEY')
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 180_000 })
    create = (params) => client.messages.create(params)
  }
  const res = await create({
    model,
    max_tokens: maxTokens,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    output_config: { effort, format: { type: 'json_schema', schema } },
    messages: [{ role: 'user', content: user }],
  })
  const usd = priceOf(model, res.usage) || 0
  const micros = Math.round(usd * 1e6)
  // fails closed: if the spend can't be recorded, the step stops here rather than spend uncounted
  await Promise.all([
    recordSpend(kv, day, usd),
    micros ? kv.put(`botspend:${day}:${crypto.randomUUID()}`, '', { metadata: { micros }, expirationTtl: 8 * 86400 }) : null,
  ])
  if (res.stop_reason === 'refusal') throw new Error('the model declined')
  if (res.stop_reason === 'max_tokens') throw new Error('the output was cut off')
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  return { data: JSON.parse(text), usd }
}

/** A JSON schema object with every property required and nothing extra (what structured outputs need). */
export const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
