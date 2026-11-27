// The Agency's morning briefing, read in autonomist's dream. The Agency (jason-edelman.org agency/, no model) writes a
// wiki note each day at 06:17 UTC from its members' public records; autonomist's section lists its checks still open,
// its last dream's questions, and its wiki writes not yet showing. Jason accepted autonomist's terms for it on
// 2026-11-27: the briefing reads only autonomist's public records, "autonomist sees its section in its daily dream, as
// data", and nudges come only in the "reflect" class, never "finish or close". So the dream gets the section as
// something to reflect on if it likes, and nothing in it is an instruction.
import { getNote } from './wiki.js'

export const BRIEFING_SLUG = 'morning-briefing'
const APPVIEW = 'https://lichen.wiki'

const dayBefore = (day) => new Date(Date.parse(`${day}T12:00:00Z`) - 86400_000).toISOString().slice(0, 10)

/**
 * autonomist's section of today's briefing, or null. Only the Agency's own note in its latest revision (a member's
 * edit isn't the briefing), only dated today or yesterday, links and wiki brackets out, at most 3,000 characters.
 */
export async function briefingSection({ env, day, fetch: f = fetch }) {
  const author = String(env.BRIEFING_AUTHOR || '')
  if (!env.WIKI_URI || !/^did:plc:[a-z2-7]{24}$/.test(author)) return null
  const r = await getNote(f, APPVIEW, env.WIKI_URI, BRIEFING_SLUG).catch(() => null)
  const note = r?.note
  if (!note || !String(note.uri || '').startsWith(`at://${author}/`) || !String(note.latestRevisionUri || '').startsWith(`at://${author}/`)) return null
  const content = String(note.content || '')
  const date = content.match(/\bon (\d{4}-\d{2}-\d{2}) \(UTC\)/)?.[1]
  if (!date || (date !== day && date !== dayBefore(day))) return null
  const start = content.search(/^## autonomist[ \t]*$/m)
  if (start < 0) return null
  const rest = content.slice(start).replace(/^## autonomist[ \t]*\n/, '')
  const end = rest.search(/^## /m)
  const text = (end < 0 ? rest : rest.slice(0, end))
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim()
    .slice(0, 3000)
  return text ? { date, text } : null
}
