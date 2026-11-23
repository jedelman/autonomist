// /thinking/: autonomist thinking in public. The current community memory and the latest reflections from its run
// journal, read from its own repository (bot/log.js writes them). Model-written text is escaped; links are built by
// code from record fields and checked.
import { esc } from '../site/js/md.js'
import { checksHtml } from './checks-html.js'
import { CSP } from './index.js'

// The one exception to connect-src 'self': this page's live view (site/js/live.js) opens a WebSocket to Bluesky's
// public Jetstream hosts, and only after the visitor clicks. Keep this list the same as the one in live.js (tested).
export const JETSTREAM_HOSTS = ['jetstream2.us-east.bsky.network', 'jetstream1.us-east.bsky.network', 'jetstream1.us-west.bsky.network', 'jetstream2.us-west.bsky.network']
export const THINKING_CSP = CSP.replace("connect-src 'self'", `connect-src 'self' ${JETSTREAM_HOSTS.map((h) => `wss://${h}`).join(' ')}`)

const KIND = {
  replied: { mention: 'Answered a mention', reply: 'Replied under its post', discussion: 'Joined a discussion', 'opt-in': 'Asked on an opted-in post' },
  listened: { reply: 'Listened to a reply', discussion: 'Listened to a discussion' },
  asked: { feed: 'Asked on its feed' },
  journaled: { journal: 'Wrote the journal' },
  answered: { chat: 'Answered in the chat' },
}

export const labelOf = (v) => KIND[v.kind]?.[v.context] || `${v.kind || 'note'}${v.context ? ` (${v.context})` : ''}`

/** A bsky.app link for an at:// post URI, or null if it isn't one. */
export function postLink(uri) {
  const m = /^at:\/\/(did:[a-z0-9:.]+)\/app\.bsky\.feed\.post\/([a-z0-9]+)$/i.exec(String(uri || ''))
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null
}

export function logHtml(records, origin) {
  const items = [...(records || [])].sort((a, b) => String(b.value?.createdAt).localeCompare(String(a.value?.createdAt)))
  if (!items.length) return '<p class="muted">Nothing yet. Each conversation adds one.</p>'
  return `<ul class="log">${items.map(({ value: v }) => {
    const when = String(v.createdAt || '').replace('T', ' ').slice(0, 16)
    const own = postLink(v.result) || (origin && String(v.result || '').startsWith(`${origin}/journal/`) ? v.result : null)
    const theirs = postLink(v.subject?.uri)
    const links = [theirs && `<a href="${esc(theirs)}">the post</a>`, own && `<a href="${esc(own)}">${v.kind === 'journaled' ? 'the entry' : 'its reply'}</a>`].filter(Boolean).join(' · ')
    const themes = Array.isArray(v.themes) && v.themes.length ? `<p class="muted">${v.themes.map((t) => esc(t)).join(' · ')}</p>` : ''
    const checks = checksHtml(v.checks)
    return `<li><p class="muted">${esc(when)} UTC · ${esc(labelOf(v))}${links ? ` · ${links}` : ''}</p>${v.reflection ? `<p>${esc(v.reflection)}</p>` : `<p class="muted">${esc(v.note || 'No reflection.')}</p>`}${themes}${checks ? `<details><summary>Fact-checked first</summary>${checks}</details>` : ''}</li>`
  }).join('')}</ul>`
}

export function memoryHtml(rec) {
  if (!rec?.value?.content) return '<p class="muted">No memory yet. It is written from the reflections below, once there are some.</p>'
  const lines = String(rec.value.content).split('\n')
  const out = []
  let list = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('## ')) { if (list) { out.push('</ul>'); list = false } out.push(`<h3>${esc(line.slice(3))}</h3>`); continue }
    if (/^[-*] /.test(line)) { if (!list) { out.push('<ul>'); list = true } out.push(`<li>${esc(line.slice(2))}</li>`); continue }
    if (list) { out.push('</ul>'); list = false }
    out.push(`<p>${esc(line)}</p>`)
  }
  if (list) out.push('</ul>')
  return `${out.join('')}<p class="muted">Folded from ${Number(rec.value.folded || 0)} new reflections on ${esc(String(rec.value.createdAt || '').slice(0, 10))}. Every version is kept: <code>${esc(rec.uri)}</code>.</p>`
}
