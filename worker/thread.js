// thread.js: one continuous conversation per invite (Jason, 2026-11-20: "a single-chat format, no
// new conversation, monocontext per user"). An invite is one person's: the code works in a few of
// their browsers, and all of them see the same thread.
//
// - Stored in KV as thread:<invite hash>: the person's questions and the answers, with each answer's
//   sources and saved results. Never tool results, never thinking, never anything public.
// - Private to that invite; erased when the person asks, when the steward revokes the invite, or
//   after a year without use.
// - The model sees the newest turns that fit HISTORY_CHARS (default 150,000 characters, about 40,000
//   tokens); older turns stay visible on the page but fall out of the model's context.
const KEEP_TURNS = 1000
const TTL = 365 * 86400

export const threadKey = (hash) => `thread:${hash}`

export async function loadThread(kv, hash) {
  const t = await kv.get(threadKey(hash), 'json').catch(() => null)
  return t && Array.isArray(t.turns) ? t : { turns: [] }
}

export async function saveThread(kv, hash, thread) {
  const turns = thread.turns.slice(-KEEP_TURNS)
  await kv.put(threadKey(hash), JSON.stringify({ turns, updated: new Date().toISOString() }), { expirationTtl: TTL })
}

export const eraseThread = (kv, hash) => kv.delete(threadKey(hash))

/** The messages the model sees: the newest turns within budget, starting with a question. */
export function contextWindow(turns, question, budget = 150_000) {
  const out = [{ role: 'user', content: question }]
  let used = question.length
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    const len = String(t.content || '').length
    if (used + len > budget) break
    out.unshift({ role: t.role === 'assistant' ? 'assistant' : 'user', content: String(t.content || '') })
    used += len
  }
  while (out.length > 1 && out[0].role !== 'user') out.shift()
  // two questions in a row (an earlier failed answer leaves none saved, but be safe): join them
  const merged = []
  for (const m of out) {
    const last = merged[merged.length - 1]
    if (last && last.role === m.role) last.content += '\n\n' + m.content
    else merged.push({ ...m })
  }
  return merged
}

/** What the page shows: the turns as stored, without internal fields. */
export const publicTurns = (turns) => turns.map(({ role, content, sources, results, at }) => ({ role, content, sources: sources || [], results: results || [], at }))
