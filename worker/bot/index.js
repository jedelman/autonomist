// autonomist's life on Bluesky, run by two crons. Every five minutes: mentions and replies, the discussions under its
// own posts (join in or listen), questions on opted-in people's posts (from its home feed), and a few of Jason's
// follows read for links. Hourly also: the opted-in are followed or unfollowed, and their notes written. Hourly (at :07): the follow list (daily), the opt-in sweep, the journal entry (daily,
// from BOT_JOURNAL_HOUR_UTC), a problem-posing question on its own feed (at each of BOT_QUESTION_HOURS_UTC), and the
// community memory folded from the run journal's new reflections (log.js). Chat answers are reflected on every five
// minutes. The pinned opt-in post is made once, by whichever runs first.
// Off unless BOT_ENABLED is "true". Each step logs one line of JSON and never stops the others.
import { client } from './atproto.js'
import { structured, searchCall } from './model.js'
import { refreshFollows, sweep } from './sources.js'
import { runReplies } from './replies.js'
import { ensurePinned, refreshOptins, syncFollows, runOptin } from './optin.js'
import { runAcquaint } from './acquaint.js'
import { runQuestion } from './questions.js'
import { runDiscussions } from './threads.js'
import { drainChatReflections, foldMemory } from './log.js'
import { runDream } from './dream.js'
import { recheckEntries } from './journal.js'
import { runDigest } from './digest.js'
import { setting } from '../limits.js'

export const FAST = '*/5 * * * *'
export const HOURLY = '7 * * * *'


export async function runBot(env, event, { pdsFetch, create } = {}) {
  if (env.BOT_ENABLED !== 'true' || !env.KV || !env.PDS_PASSWORD) return
  const kv = env.KV
  const now = new Date(event?.scheduledTime || Date.now())
  const day = now.toISOString().slice(0, 10)
  const api = client(env, { pdsFetch, kv })
  // web search for fact-checks (bot/factcheck.js): off when BOT_SEARCHES_DAILY is 0, and at most BOT_CHECKS_PER_RUN
  // checks in one cron run, so a run stays well inside its wall time and the replies lock (a check over the limit
  // throws, and the reply or entry goes out unchecked)
  const perRun = setting(env.BOT_CHECKS_PER_RUN, 3, { min: 0, max: 10 })
  let checks = 0
  const model = {
    structured: (opts) => structured({ env, kv, day, create, ...opts }),
    ...(setting(env.BOT_SEARCHES_DAILY, 30, { min: 0 }) > 0 && perRun > 0 ? {
      search: (opts) => {
        if (++checks > perRun) throw new Error('enough fact-checks for this run')
        return searchCall({ env, kv, day, create, ...opts })
      },
    } : {}),
  }
  const started = Date.now()
  const step = async (name, fn) => {
    try { console.log(JSON.stringify({ bot: name, ok: true, result: await fn() })) } catch (e) { console.log(JSON.stringify({ bot: name, ok: false, error: String(e?.message || e).slice(0, 300) })) }
  }
  // two schedules: the five-minute one stays quick (replies, the link sweep); the hourly one does the slow work, so a
  // long journal run never holds up a reply. A run with no cron string (a manual test) does both.
  const fast = event?.cron !== HOURLY, hourly = event?.cron !== FAST
  await step('pinned', () => ensurePinned({ kv, api }))
  if (fast) {
    await step('replies', () => runReplies({ env, kv, api, model, day, now }))
    await step('discussions', () => runDiscussions({ env, kv, api, model, day, now }))
    // questions on opted-in people's posts, from its home feed: it follows them (syncFollows, hourly)
    await step('optin', () => runOptin({ env, kv, api, model, day, now }))
    await step('reflect', () => drainChatReflections({ env, kv, api, model }))
    await step('sweep', () => sweep(api, kv, setting(env.BOT_SWEEP_PER_TICK, 8, { min: 0, max: 40 }), now.getTime()))
  }
  if (hourly) {
    const follows = await kv.get('bot:follows', 'json')
    if (!follows || Date.now() - follows.at > 86400_000) await step('follows', () => refreshFollows(api, kv, env.BOT_SOURCE_ACTOR || 'jason-edelman.org'))
    // likes first, then follows and notes, so a new opt-in is followed and known before any question to them
    await step('optins', async () => refreshOptins({ kv, api, me: (await api.session()).did }))
    await step('follows-optin', async () => syncFollows({ kv, api, me: (await api.session()).did }))
    // the digest first: it reads dozens of articles, and everything after it stops starting new work near the cron's
    // fifteen-minute wall
    if (now.getUTCHours() >= setting(env.BOT_JOURNAL_HOUR_UTC, 13, { min: 0, max: 23 })) await step('journal', () => runDigest({ env, kv, api, model, day }))
    await step('acquaint', () => runAcquaint({ env, kv, api, model, deadline: started + 9 * 60_000 }))
    await step('question', () => runQuestion({ env, kv, api, model, day, now }))
    // fact-checks made by an older checker are redone, one entry a run
    await step('recheck', () => recheckEntries({ env, kv, api, model, day }))
    // once a day, a slower reflection, folded into the memory right after
    await step('dream', () => runDream({ env, kv, api, model, day, now }))
    await step('memory', () => foldMemory({ kv, api, model }))
  }
}
