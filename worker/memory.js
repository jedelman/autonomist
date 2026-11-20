// memory.js: folds turns that have scrolled out of the model's view into autonomist's memory of the
// conversation, a plain-text summary that stays with the thread (thread.js). It's written by a
// separate model call, priced and capped like every other, and kept short.
import Anthropic from '@anthropic-ai/sdk'
import { priceOf } from './limits.js'

export const MEMORY_SYSTEM = `You keep autonomist's memory of one ongoing conversation. autonomist is a public-interest AI organizer that helps people work out how buildings can pass to the people who live in them through limited-equity cooperatives. You are given the memory so far and the turns that are leaving the conversation's working view. Write the updated memory.

Keep what the conversation will need later:
- what the person is working toward, and their situation as they described it;
- buildings and places discussed, by address or name, with the facts found about them and where they came from;
- numbers that were computed, with the inputs and assumptions behind them, marked as computed or assumed;
- decisions made, plans, open questions and next steps;
- preferences about how the person wants to work.

Rules:
- Use only what the turns and the existing memory say. Never add facts, figures or conclusions.
- Keep no names, contact details or personal circumstances of anyone other than the person, beyond what is needed to follow the work (an organization's name is fine).
- Merge the new material into the existing memory; drop what was superseded.
- Plain text with short headed sections and bullets. At most 900 words. No preamble: start with the first section.`

const MAX_CHARS = 9000

/**
 * Write the updated memory. turns: the turns being folded. Returns { text, cost }.
 * create(params) replaces the SDK call in tests.
 */
export async function foldMemory({ memory, turns, env = {}, create, model = 'claude-haiku-5-5' }) {
  if (!create) {
    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 2, timeout: 60_000 })
    create = (params) => client.messages.create(params)
  }
  const transcript = turns.map((t) => `${t.role === 'assistant' ? 'autonomist' : 'Person'}: ${String(t.content || '')}`).join('\n\n')
  const res = await create({
    model,
    max_tokens: 4000,
    system: MEMORY_SYSTEM,
    output_config: { effort: 'medium' },
    messages: [{ role: 'user', content: `<memory_so_far>\n${memory || '(none yet)'}\n</memory_so_far>\n\n<turns_leaving_view>\n${transcript}\n</turns_leaving_view>\n\nWrite the updated memory.` }],
  })
  const cost = priceOf(model, res.usage)
  if (cost == null) throw new Error(`No price for ${model}`)
  if (res.stop_reason === 'refusal') return { text: null, cost }
  let text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim()
  if (!text) return { text: null, cost }
  if (text.length > MAX_CHARS) text = text.slice(0, MAX_CHARS).replace(/\s+\S*$/, '') + ' …'
  return { text, cost }
}
