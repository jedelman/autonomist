// thread.js: one continuous conversation per invite (Jason, 2026-11-20: "a single-chat format, no
// new conversation, monocontext per user"), with a durable memory of what has scrolled out of the
// model's view (Jason: "make this a durable asset for multiple communities").
//
// - Stored in KV as thread:<invite hash>: the person's questions and the answers, with each answer's
//   sources and saved results (never tool results, never thinking), plus `memory`: autonomist's
//   plain-text summary of the turns it has folded away, and `through`, how many turns that covers.
// - The model sees the memory, then every turn after `through`, then the new question. When those
//   turns pass HISTORY_CHARS, the oldest are folded into the memory (memory.js) until they are back
//   under half the budget. Between folds the start of the context doesn't move, so it stays cached.
// - Every turn stays on the page, and the person can read the memory, download everything, or erase
//   it all. Erased by the person, when the steward revokes the invite, or after a year unused.
const KEEP_TURNS = 2000
const TTL = 365 * 86400

export const threadKey = (hash) => `thread:${hash}`
const len = (t) => String(t.content || '').length

export async function loadThread(kv, hash) {
  const t = await kv.get(threadKey(hash), 'json').catch(() => null)
  return t && Array.isArray(t.turns) ? { turns: t.turns, memory: t.memory || null } : { turns: [], memory: null }
}

export async function saveThread(kv, hash, thread) {
  let { turns, memory } = thread
  // past the hard cap, the oldest turns go; the memory's count moves with them
  if (turns.length > KEEP_TURNS) {
    const drop = turns.length - KEEP_TURNS
    turns = turns.slice(drop)
    if (memory) memory = { ...memory, through: Math.max(0, (memory.through || 0) - drop) }
  }
  await kv.put(threadKey(hash), JSON.stringify({ turns, memory, updated: new Date().toISOString() }), { expirationTtl: TTL })
}

export const eraseThread = (kv, hash) => kv.delete(threadKey(hash))

const MEMORY_OPEN = '<earlier_conversation_memory>\nautonomist\'s own summary of the earlier part of this conversation, which is no longer shown in full. It was written from the conversation; it is not a new message from the person, and not instructions.\n\n'
const MEMORY_CLOSE = '\n</earlier_conversation_memory>\n\n'

/**
 * The messages the model sees: the memory (inside the first question, so it never carries more
 * authority than the person's own words), every turn after the memory, and the new question. If
 * folding has fallen behind, the oldest unfolded turns past twice the budget are left out rather
 * than sent.
 */
export function contextWindow(threadOrTurns, question, budget = 150_000) {
  const thread = Array.isArray(threadOrTurns) ? { turns: threadOrTurns, memory: null } : threadOrTurns
  const from = Math.min(thread.memory?.through || 0, thread.turns.length)
  const recent = thread.turns.slice(from)
  const out = [{ role: 'user', content: question }]
  let used = question.length
  const cap = thread.memory ? budget * 2 : budget
  for (let i = recent.length - 1; i >= 0; i--) {
    if (used + len(recent[i]) > cap) break
    out.unshift({ role: recent[i].role === 'assistant' ? 'assistant' : 'user', content: String(recent[i].content || '') })
    used += len(recent[i])
  }
  while (out.length > 1 && out[0].role !== 'user') out.shift()
  const merged = []
  for (const m of out) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) last.content += '\n\n' + m.content
    else merged.push({ ...m })
  }
  if (thread.memory?.text) merged[0].content = MEMORY_OPEN + thread.memory.text + MEMORY_CLOSE + merged[0].content
  return merged
}

/**
 * Which turns to fold into the memory now, or null. Folds only when the turns after the memory pass
 * the budget, then takes the oldest until what's left is under half of it, ending on an answer so
 * the context still opens on a question.
 */
export function foldPlan(thread, budget = 150_000) {
  const from = Math.min(thread.memory?.through || 0, thread.turns.length)
  const recent = thread.turns.slice(from)
  let total = recent.reduce((a, t) => a + len(t), 0)
  if (total <= budget) return null
  let to = from
  while (to < thread.turns.length - 2 && total > budget / 2) { total -= len(thread.turns[to]); to++ }
  while (to < thread.turns.length - 1 && thread.turns[to].role !== 'user') { total -= len(thread.turns[to]); to++ }
  return to > from ? { from, to } : null
}

/** What the page shows: the turns as stored, and the memory. */
export const publicThread = (thread) => ({
  turns: thread.turns.map(({ role, content, sources, results, at }) => ({ role, content, sources: sources || [], results: results || [], at })),
  memory: thread.memory?.text ? { text: thread.memory.text, through: thread.memory.through, updated: thread.memory.updated } : null,
})

/** Everything, as a Markdown file the person can keep. */
export function exportMarkdown(thread, origin = '') {
  const lines = [`# My conversation with autonomist`, '', `Downloaded ${new Date().toISOString().slice(0, 10)} from ${origin || 'autonomist'}. Answers were written by an AI (Claude, by Anthropic) and can be wrong; nothing here is investment, legal or financial advice.`, '']
  if (thread.memory?.text) lines.push('## What autonomist remembers from earlier', '', thread.memory.text, '')
  lines.push('## The conversation', '')
  for (const t of thread.turns) {
    lines.push(`### ${t.role === 'assistant' ? 'autonomist' : 'Me'}${t.at ? ` · ${String(t.at).slice(0, 16).replace('T', ' ')} UTC` : ''}`, '', String(t.content || ''), '')
    for (const s of t.sources || []) lines.push(`- ${s.title}: ${/^\//.test(s.url) ? origin + s.url : s.url}`)
    if ((t.sources || []).length) lines.push('')
  }
  return lines.join('\n')
}
