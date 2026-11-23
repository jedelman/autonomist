// The daily journal entry (Jason, 2026-11-23: "one blog post a day, automatic"). Once a day: pick the best of the
// links Jason's follows shared, read the page if its publisher leaves it open, write the entry in the journal's five
// sections, check every quotation and figure against the page by code, then store the entry in autonomist's own
// repository and post its question on Bluesky. Nothing that fails the checks is published; the day is skipped.
import { SECTIONS, readArticle, fetchReadable, checkSections, verifyBody, extractQuotes, quoteProblems, hasControlChars, normalize, slugify } from '../journal-core.js'
import { FRAMEWORK, frameworkSheet } from './framework.js'
import { candidates } from './sources.js'
import { graphemes, fits } from './text.js'
import { obj } from './model.js'
import { rememberRoot } from './threads.js'
import { REFLECTION_FIELDS, REFLECTION_RULES, writeLog, memoryNote } from './log.js'
import { factCheck, siteOf } from './factcheck.js'

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

Also give a title (your own headline, under 90 characters), a one-sentence summary (under 300 characters), and the question again on its own (under 200 characters, ending with "?").

claims_to_check: up to two factual claims the article makes that your reading leans on and that other sources could confirm or contradict (a figure, a law, an event). Write each as one plain sentence saying what the article reports, under 250 characters, with figures exactly as the article writes them. After you write, your own code will search the web for independent sources on them and publish what it finds under the entry. Leave it empty if nothing is worth checking.

If your community memory shows problems people keep raising, let them shape what you emphasize and the question you ask.

${REFLECTION_RULES}`

export const ENTRY_SCHEMA = obj({ title: { type: 'string' }, summary: { type: 'string' }, question: { type: 'string' }, body: { type: 'string' }, claims_to_check: { type: 'array', items: { type: 'string' } }, ...REFLECTION_FIELDS })

/**
 * The claims worth checking, held to the entry's own rules (no quotations, links, handles or control characters;
 * every figure is the article's). A claim that fails is dropped rather than checked.
 */
export function claimsToCheck(draft, article) {
  const texts = [normalize(`${article.title}\n${article.text}`)]
  return (Array.isArray(draft?.claims_to_check) ? draft.claims_to_check : []).map((c) => String(c).trim()).filter((c) =>
    c && c.length <= 300 && !/["“”]/.test(c) && !/https?:\/\/|www\.|@[a-z0-9-]+\./i.test(c) && !hasControlChars(c) && verifyBody(c, texts).problems.length === 0,
  ).slice(0, 2)
}

/**
 * Checks the entry's claims against other sources (bot/factcheck.js), never counting the article's own site. Best
 * effort: a search that fails or runs out of budget leaves the entry unchecked rather than unpublished.
 */
export async function checkClaims({ env, kv, model, day, draft, article, fetch: f = fetch, factCheckFn = factCheck }) {
  const out = []
  if (!model.search) return out
  for (const claim of claimsToCheck(draft, article)) {
    try {
      const c = await factCheckFn({ env, kv, model, day, claim, exclude: [siteOf(article.url)], fetch: f })
      if (!c) break
      out.push({ claim: c.claim, verdict: c.verdict, sources: c.sources.map((x) => ({ url: x.url, title: x.title, quote: x.quote, stance: x.stance })) })
    } catch (e) {
      console.log(JSON.stringify({ bot: 'journal', check: 'failed', error: String(e?.message || e).slice(0, 160) }))
      break
    }
  }
  return out
}

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
  const all = `${d.title}\n${d.summary}\n${d.question}\n${body}`
  if (/(^|[^\w@/])@[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(all)) problems.push('no @handles')
  // only curly quotes are checked, so a straight double quote could slip an unchecked quotation through
  if (/"/.test(all)) problems.push('no straight double quotes ("): quote with curly quotes “ ” only, verbatim')
  problems.push(...quoteProblems(all))
  if (hasControlChars(all)) problems.push('no control characters')
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

async function write({ kv, model, article, cand, example }) {
  const system = example ? `${JOURNAL_SYSTEM}\n\nAn earlier entry, for its form and voice only (not its content or its figures):\n\n${example}` : JOURNAL_SYSTEM
  const mem = kv ? await memoryNote(kv) : ''
  let user = `${articleMessage(article, cand)}${mem}`
  let draft = null, check = null
  for (let attempt = 0; attempt < 2; attempt++) {
    const { data } = await model.structured({ system, user, schema: ENTRY_SCHEMA, effort: 'high', maxTokens: 16000 })
    draft = data
    check = checkDraft(draft, article)
    if (check.problems.length === 0) return { draft, check }
    user = `${articleMessage(article, cand)}${mem}\n\nYOUR PREVIOUS DRAFT\n${JSON.stringify(draft)}\n\nA program rejected it for these reasons:\n${check.problems.map((p) => `- ${p}`).join('\n')}\n\nWrite the entry again and fix every one. Copy quotations exactly, or don't quote.`
  }
  return { draft, check }
}

/** Reads an article, checking robots.txt and Content-Signal on every redirect hop before any body is read. */
export async function fetchArticle(url, f, cache) {
  const { res, url: at } = await fetchReadable(url, { fetch: f, cache })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!/html/i.test(res.headers.get('content-type') || '')) throw new Error('not an HTML page')
  return readArticle((await res.text()).slice(0, 3_000_000), at)
}

export async function runJournal({ env, kv, api, model, day, example, fetch: f = fetch }) {
  const done = await kv.get(`journal:done:${day}`)
  if (done) return { ...(await announce({ kv, api, day })), published: done }
  if (await kv.get(`journal:lock:${day}`)) return { skipped: 'a run is in progress' }
  const attempts = Number((await kv.get(`journal:attempts:${day}`)) || 0)
  if (attempts >= 3) return { skipped: 'three attempts today' }
  await kv.put(`journal:attempts:${day}`, String(attempts + 1), { expirationTtl: 3 * 86400 })
  // longer than a cron run can last (15 minutes), so two runs never overlap
  await kv.put(`journal:lock:${day}`, '1', { expirationTtl: 1800 })
  const covered = new Set((await kv.get('journal:covered', 'json')) || [])
  try {
    const cands = await candidates(kv, covered)
    if (!cands.length) return { skipped: 'no candidate links yet' }
    const list = cands.map((c, i) => `${i}. ${c.title || '(no title)'} | ${new URL(c.url).hostname} | ${c.description || ''}`.slice(0, 400)).join('\n')
    const { data: pick } = await model.structured({ system: PICK_SYSTEM, user: list, schema: PICK_SCHEMA, effort: 'low', maxTokens: 4000 })
    const tried = []
    const robots = new Map()
    for (const p of (pick.picks || []).slice(0, 3)) {
      const cand = cands[p.index]
      if (!cand || covered.has(cand.key)) continue
      covered.add(cand.key)
      let article
      try { article = await fetchArticle(cand.url, f, robots) } catch (e) { tried.push({ url: cand.url, why: String(e.message) }); continue }
      if (article.words < 350) { tried.push({ url: cand.url, why: `only ${article.words} words readable` }); continue }
      const { draft, check } = await write({ kv, model, article, cand, example })
      if (check.problems.length) { tried.push({ url: cand.url, why: `failed checks: ${check.problems.slice(0, 3).join('; ')}` }); continue }
      const claims = await checkClaims({ env, kv, model, day, draft, article, fetch: f })
      const published = await publish({ env, kv, api, day, article, cand, draft, check: { ...check, claims } })
      await writeLog(api, { kind: 'journaled', context: 'journal', source: article.url, result: published.url, reflection: draft.reflection, themes: draft.themes, checks: claims })
      return { published: published.slug, url: published.url, ...(await announce({ kv, api, day })), tried }
    }
    return { skipped: 'nothing passed', tried }
  } finally {
    await kv.put('journal:covered', JSON.stringify([...covered].slice(-500))).catch(() => {})
    await kv.delete(`journal:lock:${day}`).catch(() => {})
  }
}

/**
 * Stores the entry in autonomist's repository and marks the day done at once, so a later failure can never lead to
 * a second entry. The Bluesky post is a separate step (announce), retried until it goes out.
 */
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
    // every page quoted on the entry page, the fact-checks' included
    sources: [...new Set([article.url, ...check.frameworkUrls, ...(check.claims || []).flatMap((c) => c.sources.map((x) => x.url))])],
    via: cand.post ? { handle: cand.handle, post: cand.post } : undefined,
    checks: { quotes: check.quotes, figures: check.figures, ...(check.claims?.length ? { claims: check.claims } : {}), at: new Date().toISOString() },
    model: env.MODEL || 'claude-haiku-5-5',
    createdAt: new Date().toISOString(),
  }
  await api.call('POST', 'com.atproto.repo.putRecord', { body: { repo: s.did, collection: COLLECTION, rkey: slug, record: JSON.parse(JSON.stringify(record)) } })
  const url = `${(env.PUBLIC_ORIGIN || 'https://autonomist.jason-edelman.org').replace(/\/$/, '')}/journal/${slug}/`
  await kv.put(`journal:done:${day}`, slug, { expirationTtl: 3 * 86400 })
  await kv.put(`journal:announce:${day}`, JSON.stringify({ slug, url, title: draft.title, summary: draft.summary, question: draft.question, source: article.url }), { expirationTtl: 3 * 86400 })
  return { slug, url }
}

/** Posts the day's entry on Bluesky, once: the question leads and the entry rides along as a link card. */
export async function announce({ kv, api, day }) {
  const a = await kv.get(`journal:announce:${day}`, 'json')
  if (!a || a.post) return { announced: a?.post || null }
  if (a.claimed) return { announced: null, note: 'an earlier post attempt may have gone out; not posting again' }
  await kv.put(`journal:announce:${day}`, JSON.stringify({ ...a, claimed: true }), { expirationTtl: 3 * 86400 })
  const text = [`${a.question}\n\nFrom today's journal: ${a.title}`, a.question].find(fits)
  let post
  try {
    post = await api.post({ text, card: { uri: a.url, title: a.title, description: a.summary } })
  } catch (e) {
    // the post goes to autonomist's own PDS in-process, so a failure here means it didn't go out: release the claim
    await kv.put(`journal:announce:${day}`, JSON.stringify({ ...a, claimed: false }), { expirationTtl: 3 * 86400 })
    throw e
  }
  await kv.put(`journal:announce:${day}`, JSON.stringify({ ...a, claimed: true, post: post.uri }), { expirationTtl: 3 * 86400 })
  await kv.put(`journal:root:${post.uri}`, JSON.stringify({ slug: a.slug, title: a.title, summary: a.summary, question: a.question, url: a.url, source: a.source }), { expirationTtl: 60 * 86400 })
  await rememberRoot(kv, post, 'journal')
  return { announced: post.uri }
}
