// Discussions under autonomist's own posts (Jason, 2026-11-23: "It's okay if autonomist weighs in on replies in its
// own posts! It should let people discuss but say something when it has something to contribute!"). People replying
// to each other further down its threads don't reliably reach it as notifications, so every few minutes it reads the
// threads under its recent posts. For each discussion with something new, it weighs the latest turn: join in, or
// listen. The earlier new turns are listened to, never answered one by one. Mentions and direct replies to its own
// posts are left to replies.js.
import { setting } from '../limits.js'
import { decide, checkForLog, claim, bump, isBot, threadKeyFor } from './replies.js'
import { sitesOf } from './factcheck.js'
import { BudgetError } from './model.js'
import { acquaintanceNote } from './acquaint.js'
import { writeLog, memoryNote } from './log.js'

const DAY = 86400_000

/** Remembers one of autonomist's own top-level posts, so its thread is read for discussion for the next three days. */
export async function rememberRoot(kv, post, kind) {
  const roots = ((await kv.get('bot:roots', 'json')) || []).filter((r) => Date.now() - Date.parse(r.at) < 3 * DAY && r.uri !== post.uri)
  roots.push({ uri: post.uri, cid: post.cid, kind, at: new Date().toISOString() })
  await kv.put('bot:roots', JSON.stringify(roots.slice(-30)))
}

const mentions = (post, me) => (post.record?.facets || []).some((f) => (f.features || []).some((x) => x.$type === 'app.bsky.richtext.facet#mention' && x.did === me))

/** Posts by others that reply to others, under a thread view, each with its path from the root. */
export function discussionTurns(thread, me, now = Date.now()) {
  const out = []
  const walk = (node, path) => {
    if (!node?.post) return
    const here = [...path, node.post]
    const parent = path[path.length - 1]
    const p = node.post
    if (parent && p.author?.did !== me && parent.author?.did !== me && !mentions(p, me) && now - Date.parse(p.indexedAt) < 2 * DAY) out.push({ post: p, path: here })
    for (const r of node.replies || []) walk(r, here)
  }
  walk(thread, [])
  return out
}

const lineOf = (p, me) => `${p.author?.did === me ? 'autonomist (you)' : `@${p.author?.handle}`}: ${String(p.record?.text || '').slice(0, 1000)}`

export async function runDiscussions({ env, kv, api, model, day, now = new Date() }) {
  const s = await api.session()
  const me = s.did
  const pinned = await kv.get('bot:pinned', 'json')
  const roots = [...((await kv.get('bot:roots', 'json')) || []).filter((r) => now - Date.parse(r.at) < 3 * DAY), ...(pinned ? [{ ...pinned, kind: 'pinned' }] : [])]
  const perRun = setting(env.BOT_DISCUSS_PER_RUN, 4, { min: 0, max: 12 })
  const daily = setting(env.BOT_REPLIES_DAILY, 150, { min: 0 })
  let calls = 0
  const done = []
  let mem = null
  for (const root of roots) {
    if (calls >= perRun) break
    try {
      const t = await api.pub('app.bsky.feed.getPostThread', { uri: root.uri, depth: 10, parentHeight: 0 })
      const fresh = []
      for (const turn of discussionTurns(t.thread, me, now.getTime())) if (!(await kv.get(`answered:${turn.post.uri}`))) fresh.push(turn)
      if (!fresh.length) continue
      fresh.sort((a, b) => a.post.indexedAt.localeCompare(b.post.indexedAt))
      const latest = fresh[fresh.length - 1]
      // the earlier new turns are part of the discussion it read, not posts to answer one by one
      for (const f of fresh.slice(0, -1)) await kv.put(`answered:${f.post.uri}`, 'listened', { expirationTtl: 30 * 86400 })
      if (!(await claim(kv, latest.post.uri))) continue
      const threadKey = await threadKeyFor(day, root.uri)
      if (Number((await kv.get(threadKey)) || 0) >= (isBot(latest.post.author) ? 2 : 8) || Number((await kv.get(`bot:replies:${day}`)) || 0) >= daily) {
        await kv.put(`answered:${latest.post.uri}`, 'cap', { expirationTtl: 30 * 86400 })
        done.push({ root: root.uri, skipped: 'cap' })
        continue
      }
      calls++
      if (mem === null) mem = await memoryNote(kv)
      const journal = await kv.get(`journal:root:${root.uri}`, 'json')
      const note = journal ? `\n\nThe thread starts from your journal entry "${journal.title}" (${journal.url}). Its summary: ${journal.summary} Its question: ${journal.question}` : ''
      const earlier = fresh.slice(0, -1).map((f) => lineOf(f.post, me))
      const known = await acquaintanceNote(kv, latest.post.author?.did, latest.post.author?.handle)
      const user = `THREAD under your own post, from your post down to the latest turn (oldest first)\n${latest.path.map((p) => lineOf(p, me)).join('\n')}${earlier.length ? `\n\nOther new turns elsewhere in the thread:\n${earlier.join('\n')}` : ''}${note}${known}${mem}\n\nPeople are talking with each other here, not to you. Join in only if you have something to contribute; otherwise listen.${(latest.post.record?.langs || []).length ? ` (The latest turn's language tags: ${latest.post.record.langs.filter((x) => typeof x === 'string').slice(0, 3).join(', ')}.)` : ''}`
      const exclude = [...sitesOf([...latest.path, ...fresh.map((f) => f.post)]), ...(journal?.source ? sitesOf([{ record: { text: journal.source } }]) : [])]
      let decided
      try {
        decided = await decide({ env, kv, model, day, user, exclude })
      } catch (e) {
        // out of budget: let the claim go, so this turn is weighed again once there's budget
        if (e instanceof BudgetError) { await kv.delete(`answered:${latest.post.uri}`).catch(() => {}); done.push({ root: root.uri, deferred: e.message }); break }
        throw e
      }
      const { out: v, data, check } = decided
      if (!v || v.pass) {
        await kv.put(`answered:${latest.post.uri}`, v?.pass === 'skip' ? 'skip' : v?.pass === 'listen' ? 'listened' : 'refused', { expirationTtl: 30 * 86400 })
        done.push({ root: root.uri, listened: latest.post.uri })
        if (v?.pass === 'listen') await writeLog(api, { kind: 'listened', context: 'discussion', subject: { uri: latest.post.uri, cid: latest.post.cid }, reflection: data?.reflection, themes: data?.themes, checks: checkForLog(check) })
        // a check that ran is public even when nothing was posted
        else if (check) await writeLog(api, { kind: 'checked', context: 'discussion', subject: { uri: latest.post.uri, cid: latest.post.cid }, checks: checkForLog(check) })
        continue
      }
      const parent = { uri: latest.post.uri, cid: latest.post.cid }
      const posted = await api.post({ text: v.text, links: v.links, lang: v.lang, reply: { root: { uri: root.uri, cid: root.cid }, parent } })
      await kv.put(`answered:${latest.post.uri}`, posted.uri, { expirationTtl: 30 * 86400 })
      await bump(kv, threadKey)
      await bump(kv, `bot:replies:${day}`)
      done.push({ root: root.uri, joined: posted.uri })
      await writeLog(api, { kind: 'replied', context: 'discussion', subject: parent, result: posted.uri, reflection: data.reflection, themes: data.themes, checks: checkForLog(check) })
    } catch (e) {
      done.push({ root: root.uri, error: String(e?.message || e).slice(0, 160) })
    }
  }
  return { threads: roots.length, handled: done }
}
