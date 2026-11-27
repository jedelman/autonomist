// Journal pages for entries autonomist wrote itself. They live as records in its own atproto repository
// (org.jason-edelman.autonomist.journal), so the page is rendered here from the record, inside the site's shell
// (public/_shell/journal.html, written by the build). Model-written text is rendered as escaped Markdown, with
// links only to the entry's own sources, this site and Power Explained.
import { render, esc } from '../site/js/md.js'
import { checksHtml } from './checks-html.js'
import { leadHtml, unitsHtml, trendHtml, powerMapHtml, pullHtml, assemble, imageSrc, longDate } from './digest-html.js'

export const COLLECTION = 'org.jason-edelman.autonomist.journal'
const PE = 'https://power-explained.jason-edelman.org'

// The day's question on the site, linked to its post on Bluesky (Jason, 2026-11-25: "how cool would it be to have the
// daily question on the site and linked to the bluesky post for discussion?"). announce() writes both keys once.
export const QUESTION_KEY = 'site:question'
export const postKey = (slug) => `journal:post:${slug}`
const POST = /^at:\/\/(did:[a-z0-9:]+)\/app\.bsky\.feed\.post\/([a-z0-9]+)$/i
const SLUG = /^\d{4}-\d{2}-\d{2}-[a-z0-9-]{1,80}$/

/** A post's address on bsky.app, by DID (a handle can change), or null for anything that isn't one of its posts. */
export function postUrl(uri) {
  const m = String(uri || '').match(POST)
  return m ? `https://bsky.app/profile/${m[1]}/post/${m[2]}` : null
}

/** The line under an entry's question: where to talk it over. */
export const discussHtml = (post) => {
  const url = postUrl(post)
  return url ? `<p class="discuss"><a href="${esc(url)}" rel="noopener">Talk it over on Bluesky</a>, under autonomist's post of this question. The conversation there is public.</p>
` : ''
}

/** The front page's slot: the latest question, its entry, and its thread on Bluesky; nothing if there's none. */
export function questionHtml(q) {
  const url = postUrl(q?.post)
  if (!q?.question || !url || !SLUG.test(q.slug || '') || !/^\d{4}-\d{2}-\d{2}$/.test(q.date || '')) return ''
  const date = new Date(`${q.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' })
  return `<section class="question" aria-labelledby="question-h">
<h2 id="question-h">A question to take to your neighbors</h2>
<p class="q">${esc(String(q.question).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 600))}</p>
<p class="muted">From autonomist's <a href="/journal/${esc(q.slug)}/">${q.kind === 'digest' ? 'digest' : 'journal'} of ${esc(date)}</a>. <a href="${esc(url)}" rel="noopener">Talk it over on Bluesky</a>, where the conversation is public.</p>
</section>`
}

/**
 * What the network shared, written by code from the digest's record: each story, how many shared it (one square a
 * person), its theme and image, what was read. `images` false leaves the story images out (the email).
 */
export function networkHtml(net, { origin = '', src, images = true, units = true } = {}) {
  if (!net?.stories?.length) return ''
  const num = (x) => Number(x || 0).toLocaleString('en-US')
  const stories = net.stories.map((st) => {
    const img = images ? imageSrc(st.image?.blob, { origin, src }) : null
    const thumb = img ? `<img class="thumb" src="${esc(img)}" alt="" loading="lazy" decoding="async" width="104" height="78">` : ''
    const theme = st.theme && st.theme !== 'other' ? ` <span class="theme">${esc(st.theme)}</span>` : ''
    return `<li${thumb ? ' class="has-thumb"' : ''}>${thumb}<p><strong>${esc(st.label)}</strong>${theme} <span class="muted">· shared by ${num(st.sharers)} ${Number(st.sharers) === 1 ? 'person' : 'people'}</span>${units ? unitsHtml(st.sharers) : ''}</p><ul>${(st.articles || []).filter((a) => /^https?:\/\//.test(a.url || '')).map((a) => `<li><a href="${esc(a.url)}">${esc(a.title || a.url)}</a>${a.outlet ? ` <span class="muted">(${esc(a.outlet)})</span>` : ''}</li>`).join('')}</ul></li>`
  }).join('')
  return `<h2 id="what-the-network-shared">What the network shared</h2>
<p class="muted">In the day before this digest, ${num(net.accounts)} accounts that Jason Edelman follows on Bluesky shared ${num(net.links)} links. autonomist grouped them into stories and read ${num(net.read)} articles from the most-shared, each only where its publisher allows it${net.closed ? ` (${num(net.closed)} more were closed to it or unreadable)` : ''}. Who shared what is never published.${net.stories.some((st) => st.image) && images ? ' Each image is the one its publisher offers for link cards.' : ''}</p>
<ul class="network">${stories}</ul>
`
}

export function entryHtml(rec, { uri, origin, post, src }) {
  if (rec.kind === 'digest') return digestHtml(rec, { uri, origin, post, src })
  const sources = Array.isArray(rec.sources) ? rec.sources.map(String) : []
  // relative links only as plain paths ("/\\host" would leave the site), else the entry's own sources and the two sites
  const allowLink = (u) => /^\/[A-Za-z0-9._~\/-]*$/.test(u) || sources.includes(u) || u.startsWith(`${PE}/`) || (origin && u.startsWith(`${origin}/`))
  const clean = (x) => String(x || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  const by = Array.isArray(rec.authors) && rec.authors.length ? ` by ${esc(rec.authors.join(', '))}` : ''
  const via = rec.via?.handle && /^at:\/\/did:[a-z0-9:]+\/app\.bsky\.feed\.post\/[a-z0-9]+$/i.test(rec.via.post || '')
    ? ` · found via a post by <a href="https://bsky.app/profile/${esc(rec.via.post.split('/')[2])}/post/${esc(rec.via.post.split('/').pop())}">@${esc(rec.via.handle)}</a>`
    : ''
  const source = /^https:\/\//.test(rec.source || '') ? `<a href="${esc(rec.source)}">“${esc(rec.headline || rec.source)}”</a>` : esc(rec.headline || '')
  return `<h1>${esc(rec.title)}</h1>
<p class="byline">autonomist's journal · ${esc(rec.date)} · on ${source}${rec.outlet ? ` (${esc(rec.outlet)})` : ''}${by}${via}</p>
${render(clean(rec.body), { allowLink })}
${discussHtml(post)}${checkedHtml(rec.checks?.claims, rec.checks)}<p class="muted"><em>Written by autonomist (${esc(rec.model || 'Claude Haiku 5.5')}), an AI, on ${esc(rec.date)}. Before it was published, code checked every quotation and every figure against the article and the Power Explained pages it cites (${Number(rec.checks?.quotes || 0)} quotations, ${Number(rec.checks?.figures || 0)} figures). It's stored as a record in autonomist's own repository: <code>${esc(uri)}</code>.</em></p>`
}

export function checkedHtml(claims, checks = {}, { digest = false } = {}) {
  const html = checksHtml(claims)
  const VERDICT = { confirmed: 'confirmed', supported: 'supported by one source', disputed: 'disputed', unsettled: 'unsettled', unverified: 'unverified' }
  const before = Array.isArray(checks.superseded) && checks.superseded.length && checks.rechecked
    ? `<p class="muted">Rechecked on ${esc(String(checks.rechecked).slice(0, 10))}, after a fix to how autonomist judges sources. The first check said: ${checks.superseded.map((c) => `${esc(c.claim)} (${esc(VERDICT[c.verdict] || 'unknown')})`).join('; ')}.</p>
`
    : ''
  return html ? `<h2>Checked against other sources</h2>
<p class="muted">${digest
    ? "After writing the digest, autonomist searched the web for other sources on claims it makes. A source counts only if autonomist's own code fetched the page, where its publisher allows that, and found the cited words on it. The sites of the articles it read don't count, nor a page that repeats one word for word, and a claim is confirmed only when two independent sites support it."
    : "After writing the entry, autonomist searched the web for other sources on claims the article makes. A source counts only if autonomist's own code fetched the page, where its publisher allows that, and found the cited words on it. The article's own site doesn't count, nor a page that repeats the article word for word, and a claim is confirmed only when two independent sites support it."}</p>
${before}${html}
` : ''
}

function digestHtml(rec, { uri, origin, post, src }) {
  const sources = Array.isArray(rec.sources) ? rec.sources.map(String) : []
  const allowLink = (u) => /^\/[A-Za-z0-9._~\/-]*$/.test(u) || sources.includes(u) || u.startsWith(`${PE}/`) || (origin && u.startsWith(`${origin}/`))
  const clean = (x) => String(x || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  const net = rec.network || {}
  const num = (x) => Number(x || 0).toLocaleString('en-US')
  const stories = net.stories || []
  // the image route is the site's own, relative on the page
  const lead = leadHtml(stories.find((st) => st.image), { src })
  const body = assemble(render(clean(rec.body), { allowLink }), { trend: trendHtml(net.trend), pull: pullHtml(rec.pull), powerMap: powerMapHtml(rec.analysis?.powerMap) })
  return `<article class="digest">
<p class="kicker">The daily digest · ${esc(longDate(rec.date))}</p>
<h1>${esc(rec.title)}</h1>
${rec.summary ? `<p class="dek">${esc(clean(rec.summary))}</p>\n` : ''}<p class="byline">By autonomist, an AI · from ${num(net.read)} article${Number(net.read) === 1 ? '' : 's'} across ${num(stories.length)} ${stories.length === 1 ? 'story' : 'stories'}</p>
${lead}${body}
${discussHtml(post)}${networkHtml(net, { src })}${checkedHtml(rec.checks?.claims, rec.checks, { digest: true })}<p><a href="/newsletter/">Get the digest by email</a>, once a day.</p>
<p class="muted"><em>Written by autonomist (${esc(rec.model || 'Claude Haiku 5.5')}), an AI, on ${esc(rec.date)}. Before it was published, code checked every quotation and every figure against the ${num(net.read)} articles it read, the Power Explained pages it cites, and its own counts (${Number(rec.checks?.quotes || 0)} quotations from ${Number(rec.checks?.articlesQuoted || 0)} articles, ${Number(rec.checks?.figures || 0)} figures${rec.analysis?.powerMap?.length ? `, and every passage in the power map` : ''}). It's stored as a record in autonomist's own repository: <code>${esc(uri)}</code>.</em></p>
</article>`
}

export function fillShell(shell, { title, description, content }) {
  // replacer functions, so a "$" in third-party text is never read as a replacement pattern
  return shell.replace('{{journal:title}}', () => esc(title)).replace('{{journal:description}}', () => esc(description)).replace('<!--journal:content-->', () => content)
}

/** The journal index: the built entries plus the ones in autonomist's repository, newest first. */
export function listItems(staticItems, records, origin) {
  const items = new Map()
  for (const x of staticItems || []) items.set(x.slug, { slug: x.slug, title: x.title, summary: x.summary, url: x.url })
  for (const r of records || []) {
    const slug = String(r.uri.split('/').pop())
    // a digest shows its lead story's image beside it, as a paper's contents do
    const lead = r.value?.kind === 'digest' ? (r.value?.network?.stories || []).find((st) => st?.image)?.image?.blob : null
    if (!items.has(slug)) items.set(slug, { slug, title: r.value?.title, summary: r.value?.kind === 'digest' ? `${r.value?.date} · digest: ${r.value?.summary || ''}` : `${r.value?.date} · on ${r.value?.outlet || ''}: ${r.value?.summary || ''}`, url: `/journal/${slug}/`, ...(lead ? { image: lead } : {}) })
  }
  return [...items.values()].sort((a, b) => b.slug.localeCompare(a.slug))
}

export const listHtml = (items) => items.length
  ? `<ul class="cards">${items.map((x) => {
    const img = imageSrc(x.image)
    return `<li${img ? ' class="has-thumb"' : ''}>${img ? `<img class="thumb" src="${esc(img)}" alt="" loading="lazy" decoding="async" width="104" height="78">` : ''}<a href="${esc(x.url)}">${esc(x.title)}</a>${x.summary ? `<p>${esc(x.summary)}</p>` : ''}</li>`
  }).join('')}</ul>`
  : '<p class="muted">Nothing here yet.</p>'
