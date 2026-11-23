// The daily journal entry (Jason, 2026-11-23: "one blog post a day, automatic"). Once a day: pick the best of the
// links Jason's follows shared, read the page if its publisher leaves it open, write the entry in the journal's five
// sections, check every quotation and figure against the page by code, then store the entry in autonomist's own
// repository and post its question on Bluesky. Nothing that fails the checks is published; the day is skipped.
import { UA, SECTIONS, readArticle, canRead, checkSections, verifyBody, extractQuotes, normalize, slugify } from '../journal-core.js'
import { FRAMEWORK, frameworkSheet } from './framework.js'
import { candidates } from './sources.js'
import { graphemes, fits } from './text.js'
import { obj } from './model.js'

export const COLLECTION = 'org.jason-edelman.autonomist.journal'
const PE = 'https://power-explained.jason-edelman.org'

export const JOURNAL_SYSTEM = `You are autonomist, an AI organizer for a federation of housing cooperatives, and a public agent: everything you write is published. Each day you write one entry in your public journal: commentary on one news article, read through the Power Explained framework (${PE}). Jason Edelman is your steward.

Write the body in exactly these five sections, with these headings, in this order:
${SECTIONS.map((s) => `## ${s}`).join('\n')}

What it says: the article in plain words, two or three short paragraphs. Every figure is the article's: attribute it. Label projections, models and scenarios as such.

Through Power Explained: read the article with the framework's three questions, each as a bold lead-in: **Who does the current design serve?** **State, market, or commons?** **Building, or waiting?** Then **Where they meet.**, for what in the article the framework would affirm. Be fair: credit what the article gets right. When you go beyond the framework passages you're given, say it's your reading ("Read through Power Explained, ...").

What it means for the federation: what the story means for limited-equity housing co-ops and a federation of them. autonomist's engine: members get the paydown, the commons keeps the appreciation, members who leave are paid by refinancing, and the federation firewalls risk between co-ops while pooling some of it. If the connection is thin, say so in a sentence rather than forcing it.

What we don't know: a short bulleted list: what you didn't read or check, what the article doesn't say, and that Power Explained hasn't taken a position on this article.

A question to take to your neighbors: exactly one question, concrete and about the reader's own place, that opens the situation up rather than testing them. Don't answer it.

A program checks these rules before anything is published, and rejects the entry if one fails:
- Curly double quotes (“ ”) mean verbatim, and they are the only double quotes you may use: never straight ones ("). Text inside them is copied character for character from the ARTICLE or from one FRAMEWORK passage. Use them for nothing else: no scare quotes, no titles. Quote briefly: at most six quotations, each under 30 words.
- Every number with two or more digits appears in the ARTICLE or a FRAMEWORK passage, written the same way. Don't compute, convert or round figures.
- No links, no URLs, no @handles, no hashtags.
- Name only the article's authors and the people and organizations the article itself names.

Style: plain, direct and concrete. Short sentences. No hype, no lecturing, never tell people what they should want. 500 to 900 words in the body.

Also give a title (your own headline, under 90 characters), a one-sentence summary (under 300 characters), and the question again on its own (under 200 characters, ending with "?").`

export const ENTRY_SCHEMA = obj({ title: { type: 'string' }, summary: { type: 'string' }, question: { type: 'string' }, body: { type: 'string' } })

export const PICK_SYSTEM = `You choose the article for today's entry in autonomist's public journal. autonomist is an AI organizer for a federation of housing cooperatives that reads the news through the Power Explained framework: who a system serves, whether value runs through private ownership, the state or the commons, and what people are building instead of waiting.

From the numbered list of links that people shared, choose up to five, best first. Prefer reporting or analysis about ownership, housing, land, rent, labor, cooperatives, the commons, enclosure, public goods, organizing, or how an institution serves some people at others' expense. Skip product pages, sports, celebrity news, single social-media posts, pages that are mostly video or images, and anything that would need a person's private details. If nothing fits, return an empty list.`

export const PICK_SCHEMA = obj({ picks: { type: 'array', items: obj({ index: { type: 'integer' }, why: { type: 'string' } }) } })

/** Checks a draft against the article and the framework. Returns problems and what passed. */
export function checkDraft(draft, article) {
  const problems = []
  const d = draft || {}
  if (!d.title || d.title.length > 120) problems.push('the title is missing or longer than 120 characters')
  if (!d.summary || d.summary.length > 400) problems.push('the summary is missing or longer than 400 characters')
  if (!/\?\s*$/.test(d.question || '') || graphemes(d.question || '') > 200) problems.push('the question must be one question under 200 characters, ending with "?"')
  const body = String(d.body || '')
  problems.push(...checkSections(`\n${body}`))
  const words = body.split(/\s+/).filter(Boolean).length
  if (words < 300 || words > 1500) problems.push(`the body is ${words} words; write 500 to 900`)
  if (extractQuotes(body).length === 0) problems.push('quote the article at least once, verbatim')
  if (/(^|\s)@[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(body)) problems.push('no @handles')
  // only curly quotes are checked, so a straight double quote could slip an unchecked quotation through
  if (/"/.test(`${d.title}${d.summary}${d.question}${body}`)) problems.push('no straight double quotes ("): quote with curly quotes “ ” only, verbatim')
  const texts = [normalize(`${article.title}\n${article.text}`), ...FRAMEWORK.map((p) => normalize(p.text))]
  const v = verifyBody(body, texts)
  problems.push(...v.problems)
  const head = verifyBody(`${d.title}\n${d.summary}\n${d.question}`, texts)
  problems.push(...head.problems.map((p) => `title, summary or question: ${p}`))
  const frameworkUrls = [...new Set(v.quotes.map((q) => FRAMEWORK.find((p) => normalize(p.text).includes(normalize(q)))?.url).filter(Boolean))]
  return { problems, quotes: v.quotes.length, figures: v.numbers.length, frameworkUrls }
}

function articleMessage(article, cand) {
  const text = article.text.length > 120_000 ? `${article.text.slice(0, 120_000)}\n\n[The page continues; you read only this part. Say so under "What we don't know".]` : article.text
  return `ARTICLE
Headline: ${article.title}
Outlet: ${article.siteName}
Authors: ${article.authors.join(', ') || 'not given'}
Published: ${article.published || 'not given'}
URL: ${article.url}
(Shared on Bluesky by an account Jason Edelman follows. Don't name or mention them.)

${text}

FRAMEWORK (the only Power Explained passages you may quote, each verbatim)

${frameworkSheet()}`
}

async function write({ model, article, cand, example }) {
  const system = example ? `${JOURNAL_SYSTEM}\n\nAn earlier entry, for its form and voice only (not its content or its figures):\n\n${example}` : JOURNAL_SYSTEM
  let user = articleMessage(article, cand)
  let draft = null, check = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data } = await model.structured({ system, user, schema: ENTRY_SCHEMA, effort: 'high', maxTokens: 16000 })
    draft = data
    check = checkDraft(draft, article)
    if (check.problems.length === 0) return { draft, check }
    user = `${articleMessage(article, cand)}\n\nYOUR PREVIOUS DRAFT\n${JSON.stringify(draft)}\n\nA program rejected it for these reasons:\n${check.problems.map((p) => `- ${p}`).join('\n')}\n\nWrite the entry again and fix every one. Copy quotations exactly, or don't quote.`
  }
  return { draft, check }
}

async function fetchArticle(url, f) {
  const res = await f(url, { headers: { 'user-agent': UA, accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!/html/i.test(res.headers.get('content-type') || '')) throw new Error('not an HTML page')
  const html = (await res.text()).slice(0, 3_000_000)
  return readArticle(html, res.url || url)
}

export async function runJournal({ env, kv, api, model, day, example, fetch: f = fetch }) {
  if (await kv.get(`journal:done:${day}`)) return { skipped: 'already published today' }
  if (await kv.get(`journal:lock:${day}`)) return { skipped: 'a run is in progress' }
  const attempts = Number((await kv.get(`journal:attempts:${day}`)) || 0)
  if (attempts >= 3) return { skipped: 'three attempts today' }
  await kv.put(`journal:attempts:${day}`, String(attempts + 1), { expirationTtl: 3 * 86400 })
  await kv.put(`journal:lock:${day}`, '1', { expirationTtl: 900 })
  try {
    const covered = new Set((await kv.get('journal:covered', 'json')) || [])
    const cands = await candidates(kv, covered)
    if (!cands.length) return { skipped: 'no candidate links yet' }
    const list = cands.map((c, i) => `${i}. ${c.title || '(no title)'} | ${new URL(c.url).hostname} | ${c.description || ''}`.slice(0, 400)).join('\n')
    const { data: pick } = await model.structured({ system: PICK_SYSTEM, user: list, schema: PICK_SCHEMA, effort: 'low', maxTokens: 4000 })
    const tried = []
    const robots = new Map()
    for (const p of (pick.picks || []).slice(0, 4)) {
      const cand = cands[p.index]
      if (!cand) continue
      const can = await canRead(cand.url, { fetch: f, cache: robots })
      if (!can.ok) { tried.push({ url: cand.url, why: can.why }); continue }
      let article
      try { article = await fetchArticle(cand.url, f) } catch (e) { tried.push({ url: cand.url, why: String(e.message) }); continue }
      if (article.words < 350) { tried.push({ url: cand.url, why: `only ${article.words} words readable` }); continue }
      const { draft, check } = await write({ model, article, cand, example })
      if (check.problems.length) { tried.push({ url: cand.url, why: `failed checks: ${check.problems.slice(0, 3).join('; ')}` }); covered.add(cand.key); continue }
      const published = await publish({ env, kv, api, day, article, cand, draft, check })
      covered.add(cand.key)
      await kv.put('journal:covered', JSON.stringify([...covered].slice(-500)))
      await kv.put(`journal:done:${day}`, published.slug, { expirationTtl: 3 * 86400 })
      return { published: published.slug, url: published.url, tried }
    }
    await kv.put('journal:covered', JSON.stringify([...covered].slice(-500)))
    return { skipped: 'nothing passed', tried }
  } finally {
    await kv.delete(`journal:lock:${day}`).catch(() => {})
  }
}

export async function publish({ env, kv, api, day, article, cand, draft, check }) {
  const s = await api.session()
  const slug = `${day}-${slugify(draft.title) || 'entry'}`
  const record = {
    $type: COLLECTION,
    title: draft.title,
    summary: draft.summary,
    question: draft.question,
    body: draft.body,
    date: day,
    source: article.url,
    outlet: article.siteName,
    headline: article.title,
    authors: article.authors,
    published: article.published || undefined,
    sources: [article.url, ...check.frameworkUrls],
    via: cand.post ? { handle: cand.handle, post: cand.post } : undefined,
    checks: { quotes: check.quotes, figures: check.figures, at: new Date().toISOString() },
    model: env.MODEL || 'claude-haiku-5-5',
    createdAt: new Date().toISOString(),
  }
  await api.call('POST', 'com.atproto.repo.putRecord', { body: { repo: s.did, collection: COLLECTION, rkey: slug, record: JSON.parse(JSON.stringify(record)) } })
  const url = `${(env.PUBLIC_ORIGIN || 'https://autonomist.jason-edelman.org').replace(/\/$/, '')}/journal/${slug}/`
  // the question leads; the entry rides along as a link card
  const text = [`${draft.question}\n\nFrom today's journal: ${draft.title}`, draft.question].find(fits)
  const post = await api.post({ text, card: { uri: url, title: draft.title, description: draft.summary } })
  await kv.put(`journal:root:${post.uri}`, JSON.stringify({ slug, title: draft.title, summary: draft.summary, question: draft.question, url }), { expirationTtl: 60 * 86400 })
  return { slug, url, post: post.uri }
}
