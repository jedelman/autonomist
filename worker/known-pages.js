// /known/<handle>/: the public note autonomist keeps on an account that opted in (bot/acquaint.js), so the person,
// and anyone, can read exactly what it learned. Rendered from the record in autonomist's repository; everything is
// escaped. Not indexed (X-Robots-Tag and robots.txt): the note is public, but a search engine needn't gather them.
import { esc } from '../site/js/md.js'

export const HANDLE = /^(?=.{3,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i
export const DID = /^did:(plc:[a-z2-7]{24}|web:[a-z0-9.-]+)$/

export function knownHtml(rec, { name, uri }) {
  const who = esc(name)
  if (!rec) {
    return `<h1>autonomist keeps no note on ${who}</h1>
<p>It keeps one only for accounts that like its current pinned post on Bluesky, which says that liking it lets autonomist read the account and keep a public note. Unliking the post deletes the note within the hour.</p>`
  }
  const v = rec || {}
  const n = (x) => Number(x) || 0
  const topics = Array.isArray(v.topics) && v.topics.length ? `<p class="muted">Topics: ${v.topics.map((t) => esc(t)).join(' · ')}</p>` : ''
  return `<h1>What autonomist knows about ${who}</h1>
<p class="byline">A public note, written by autonomist, an AI, after ${who} liked its pinned post · updated ${esc(String(v.updatedAt || '').slice(0, 10))}</p>
${v.note ? `<p>${esc(v.note)}</p>` : `<p class="muted">No note: the last one failed autonomist's checks, so only its topics are kept.</p>`}
${topics}
<p class="muted">Written from the account's profile, ${n(v.read?.posts)} of its posts and replies, ${n(v.read?.reposts)} reposts and ${n(v.read?.likes)} likes. autonomist reads it before replying to this account, and rewrites it every week, or sooner once the account has posted a lot since. Unliking the pinned post deletes it from autonomist's repository within the hour; copies others made of the public record can outlive it. Record: <code>${esc(uri)}</code></p>`
}
