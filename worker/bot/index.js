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
import { maybeDryRun, scheduledDry } from './dry.js'
import { sendNewsletter } from '../newsletter.js'
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
  const dry = new Set(String(env.BOT_DRY || '').split(',').map((x) => x.trim()).filter(Boolean))
  // the journal page's shell from the built site, for rendering dry-run pages as they'd be published
  const shell = async () => (env.ASSETS ? env.ASSETS.fetch(new Request('https://assets.local/_shell/journal.html')).then((r) => (r.ok ? r.text() : '')).catch(() => '') : '')
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
    // a dry run someone asked for (the steward's page, or scripts/dry-run.mjs): after the real work, never instead of it
    await step('dry-run', async () => maybeDryRun({ env, kv, api, model, now, shell: await shell() }))
  }
  if (hourly) {
    const follows = await kv.get('bot:follows', 'json')
    if (!follows || Date.now() - follows.at > 86400_000) await step('follows', () => refreshFollows(api, kv, env.BOT_SOURCE_ACTOR || 'jason-edelman.org'))
    // likes first, then follows and notes, so a new opt-in is followed and known before any question to them
    await step('optins', async () => refreshOptins({ kv, api, me: (await api.session()).did }))
    await step('follows-optin', async () => syncFollows({ kv, api, me: (await api.session()).did }))
    // the digest first: it reads dozens of articles, and everything after it stops starting new work near the cron's
    // fifteen-minute wall
    // BOT_DRY="digest": the day's digest and its feed questions become a dry-run artifact instead of being published
    if (now.getUTCHours() >= setting(env.BOT_JOURNAL_HOUR_UTC, 13, { min: 0, max: 23 })) {
      if (dry.has('digest')) await step('journal', async () => scheduledDry({ env, kv, api, model, what: 'digest,questions', now, shell: await shell() }))
      else await step('journal', () => runDigest({ env, kv, api, model, day, deadline: started + 11 * 60_000 }))
    }
    // the digest by email (newsletter.js): a published digest's broadcast, once; nothing without Resend's config
    await step('newsletter', () => sendNewsletter({ env, kv, now }))
    await step('acquaint', () => runAcquaint({ env, kv, api, model, deadline: started + 9 * 60_000 }))
    // the rest only with time left on the cron's fifteen minutes; what's skipped runs at the next hour
    const inTime = (name, fn) => (Date.now() < started + 12 * 60_000 ? step(name, fn) : console.log(JSON.stringify({ bot: name, ok: true, result: { skipped: 'out of time this run' } })))
    await inTime('question', () => runQuestion({ env, kv, api, model, day, now }))
    // fact-checks made by an older checker are redone, one entry a run
    await inTime('recheck', () => recheckEntries({ env, kv, api, model, day }))
    // once a day, a slower reflection, folded into the memory right after
    await inTime('dream', () => runDream({ env, kv, api, model, day, now }))
    await inTime('memory', () => foldMemory({ kv, api, model }))
  }
}
