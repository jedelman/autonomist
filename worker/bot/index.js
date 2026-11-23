// autonomist's life on Bluesky, run by the Worker's cron (every five minutes). Each tick:
//   the pinned opt-in post (once) · replies to every reply and mention · a few of Jason's follows read for links
// and, when due: the follow list (daily) · the opt-in sweep (hourly) · the journal entry (daily, from BOT_JOURNAL_HOUR_UTC).
// Off unless BOT_ENABLED is "true". Each step logs one line of JSON and never stops the others.
import { client } from './atproto.js'
import { structured } from './model.js'
import { refreshFollows, sweep } from './sources.js'
import { runJournal } from './journal.js'
import { runReplies } from './replies.js'
import { ensurePinned, runOptin } from './optin.js'
import { setting } from '../limits.js'
import firstEntry from '../../content/journal/2026-11-23-piketty-global-justice.md'
import { frontMatter } from '../journal-core.js'

const EXAMPLE = frontMatter(firstEntry).body.replace(/<p class="byline">[\s\S]*?<\/p>\n*/, '').replace(/<p class="muted">[\s\S]*?<\/p>\n*/, '').trim()

export async function runBot(env, event, { pdsFetch, create } = {}) {
  if (env.BOT_ENABLED !== 'true' || !env.KV || !env.PDS_PASSWORD) return
  const kv = env.KV
  const now = new Date(event?.scheduledTime || Date.now())
  const day = now.toISOString().slice(0, 10)
  const api = client(env, { pdsFetch, kv })
  const model = { structured: (opts) => structured({ env, kv, day, create, ...opts }) }
  const step = async (name, fn) => {
    try { console.log(JSON.stringify({ bot: name, ok: true, result: await fn() })) } catch (e) { console.log(JSON.stringify({ bot: name, ok: false, error: String(e?.message || e).slice(0, 300) })) }
  }
  await step('pinned', () => ensurePinned({ kv, api }))
  await step('replies', () => runReplies({ env, kv, api, model, day, now }))
  const follows = await kv.get('bot:follows', 'json')
  if (!follows || Date.now() - follows.at > 86400_000) await step('follows', () => refreshFollows(api, kv, env.BOT_SOURCE_ACTOR || 'jason-edelman.org'))
  await step('sweep', () => sweep(api, kv, setting(env.BOT_SWEEP_PER_TICK, 8, { min: 0, max: 40 }), now.getTime()))
  if (now.getUTCMinutes() < 5) await step('optin', () => runOptin({ env, kv, api, model, day, now }))
  if (now.getUTCHours() >= setting(env.BOT_JOURNAL_HOUR_UTC, 13, { min: 0, max: 23 })) await step('journal', () => runJournal({ env, kv, api, model, day, example: EXAMPLE }))
}
