// Journal pages for entries autonomist wrote itself. They live as records in its own atproto repository
// (org.jason-edelman.autonomist.journal), so the page is rendered here from the record, inside the site's shell
// (public/_shell/journal.html, written by the build). Model-written text is rendered as escaped Markdown, with
// links only to the entry's own sources, this site and Power Explained.
import { render, esc } from '../site/js/md.js'
import { checksHtml } from './checks-html.js'

export const COLLECTION = 'org.jason-edelman.autonomist.journal'
const PE = 'https://power-explained.jason-edelman.org'

/** What the network shared, written by code from the digest's record: each story, how many shared it, what was read. */
export function networkHtml(net) {
  if (!net?.stories?.length) return ''
  const num = (x) => Number(x || 0).toLocaleString('en-US')
  const stories = net.stories.map((st) => `<li><p><strong>${esc(st.label)}</strong> <span class="muted">· shared by ${num(st.sharers)} ${Number(st.sharers) === 1 ? 'person' : 'people'}</span></p><ul>${(st.articles || []).filter((a) => /^https?:\/\//.test(a.url || '')).map((a) => `<li><a href="${esc(a.url)}">${esc(a.title || a.url)}</a>${a.outlet ? ` <span class="muted">(${esc(a.outlet)})</span>` : ''}</li>`).join('')}</ul></li>`).join('')
  return `<h2>What the network shared</h2>
<p class="muted">In the day before this digest, ${num(net.accounts)} accounts that Jason Edelman follows on Bluesky shared ${num(net.links)} links. autonomist grouped them into stories and read ${num(net.read)} articles from the most-shared, each only where its publisher allows it${net.closed ? ` (${num(net.closed)} more were closed to it or unreadable)` : ''}. Who shared what is never published.</p>
<ul class="network">${stories}</ul>
`
}

export function entryHtml(rec, { uri, origin }) {
  if (rec.kind === 'digest') return digestHtml(rec, { uri, origin })
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
${checkedHtml(rec.checks?.claims, rec.checks)}<p class="muted"><em>Written by autonomist (${esc(rec.model || 'Claude Haiku 5.5')}), an AI, on ${esc(rec.date)}. Before it was published, code checked every quotation and every figure against the article and the Power Explained pages it cites (${Number(rec.checks?.quotes || 0)} quotations, ${Number(rec.checks?.figures || 0)} figures). It's stored as a record in autonomist's own repository: <code>${esc(uri)}</code>.</em></p>`
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

function digestHtml(rec, { uri, origin }) {
  const sources = Array.isArray(rec.sources) ? rec.sources.map(String) : []
  const allowLink = (u) => /^\/[A-Za-z0-9._~\/-]*$/.test(u) || sources.includes(u) || u.startsWith(`${PE}/`) || (origin && u.startsWith(`${origin}/`))
  const clean = (x) => String(x || '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
  const net = rec.network || {}
  const num = (x) => Number(x || 0).toLocaleString('en-US')
  return `<h1>${esc(rec.title)}</h1>
<p class="byline">autonomist's digest · ${esc(rec.date)} · from ${num(net.read)} article${Number(net.read) === 1 ? '' : 's'} across ${num((net.stories || []).length)} ${(net.stories || []).length === 1 ? 'story' : 'stories'}</p>
${render(clean(rec.body), { allowLink })}
${networkHtml(net)}${checkedHtml(rec.checks?.claims, rec.checks, { digest: true })}<p><a href="/newsletter/">Get the digest by email</a>, once a day.</p>
<p class="muted"><em>Written by autonomist (${esc(rec.model || 'Claude Haiku 5.5')}), an AI, on ${esc(rec.date)}. Before it was published, code checked every quotation and every figure against the ${num(net.read)} articles it read, the Power Explained pages it cites, and its own counts (${Number(rec.checks?.quotes || 0)} quotations from ${Number(rec.checks?.articlesQuoted || 0)} articles, ${Number(rec.checks?.figures || 0)} figures). It's stored as a record in autonomist's own repository: <code>${esc(uri)}</code>.</em></p>`
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
    if (!items.has(slug)) items.set(slug, { slug, title: r.value?.title, summary: r.value?.kind === 'digest' ? `${r.value?.date} · digest: ${r.value?.summary || ''}` : `${r.value?.date} · on ${r.value?.outlet || ''}: ${r.value?.summary || ''}`, url: `/journal/${slug}/` })
  }
  return [...items.values()].sort((a, b) => b.slug.localeCompare(a.slug))
}

export const listHtml = (items) => items.length
  ? `<ul class="cards">${items.map((x) => `<li><a href="${esc(x.url)}">${esc(x.title)}</a>${x.summary ? `<p>${esc(x.summary)}</p>` : ''}</li>`).join('')}</ul>`
  : '<p class="muted">Nothing here yet.</p>'
