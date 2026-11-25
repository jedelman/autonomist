// The journal's shared pieces. Since 2026-11-25 each day's entry is a digest of the network's reading (digest.js);
// this file keeps what every entry uses: reading an article under robots.txt and Content-Signal, checking claims
// against other sources, rechecking entries made by an older checker, and posting the day's entry on Bluesky once.
import { readArticle, fetchReadable, verifyBody, hasControlChars, normalize } from '../journal-core.js'
import { fits } from './text.js'
import { rememberRoot } from './threads.js'
import { writeLog } from './log.js'
import { factCheck, siteOf, CHECKER_VERSION } from './factcheck.js'

export const COLLECTION = 'org.jason-edelman.autonomist.journal'
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
      const c = await factCheckFn({ env, kv, model, day, claim, exclude: [siteOf(article.url)], sourceText: `${article.title}\n${article.text}`, fetch: f })
      if (!c) break
      out.push({ claim: c.claim, verdict: c.verdict, sources: c.sources.map((x) => ({ url: x.url, title: x.title, quote: x.quote, stance: x.stance })), ...(c.republished ? { republished: c.republished } : {}) })
    } catch (e) {
      console.log(JSON.stringify({ bot: 'journal', check: 'failed', error: String(e?.message || e).slice(0, 160) }))
      break
    }
  }
  return out
}

/** Reads an article, checking robots.txt and Content-Signal on every redirect hop before any body is read. */
export async function fetchArticle(url, f, cache) {
  const { res, url: at } = await fetchReadable(url, { fetch: f, cache })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  if (!/html/i.test(res.headers.get('content-type') || '')) throw new Error('not an HTML page')
  return readArticle((await res.text()).slice(0, 3_000_000), at)
}

/** Posts the day's entry on Bluesky, once: the question leads and the entry rides along as a link card. */
export async function announce({ kv, api, day }) {
  const a = await kv.get(`journal:announce:${day}`, 'json')
  if (!a || a.post) return { announced: a?.post || null }
  if (a.claimed) return { announced: null, note: 'an earlier post attempt may have gone out; not posting again' }
  await kv.put(`journal:announce:${day}`, JSON.stringify({ ...a, claimed: true }), { expirationTtl: 3 * 86400 })
  const text = [`${a.question}\n\nFrom today's ${a.kind === 'digest' ? 'digest' : 'journal'}: ${a.title}`, a.question].find(fits)
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

/**
 * Redoes the fact-checks on recent entries whose checks were made by an older checker (CHECKER_VERSION), and
 * updates each entry in place, keeping the earlier verdicts on the record (`checks.superseded`) so the correction
 * shows. One entry a run. The article is read again under robots.txt and Content-Signal; if it can't be, the
 * entry is left as it is.
 */
export async function recheckEntries({ env, kv, api, model, day, fetch: f = fetch, factCheckFn = factCheck, now = Date.now() }) {
  if (!model.search) return { skipped: 'search is off' }
  const s = await api.session()
  const r = await api.call('GET', 'com.atproto.repo.listRecords', { params: { repo: s.did, collection: COLLECTION, limit: 10 } })
  // a digest is checked against dozens of articles at once and born with the current checker: never rechecked here
  const due = (r.records || []).find((x) => x.value?.kind !== 'digest' && x.value?.checks?.claims?.length && (x.value.checks.version || 1) < CHECKER_VERSION && now - Date.parse(x.value.createdAt) < 14 * 86400_000)
  if (!due) return { rechecked: 0 }
  const v = due.value
  let article
  try { article = await fetchArticle(v.source, f, new Map()) } catch (e) { return { skipped: `article unreadable: ${String(e.message).slice(0, 80)}` } }
  const claims = await checkClaims({ env, kv, model, day, draft: { claims_to_check: v.checks.claims.map((c) => c.claim) }, article, fetch: f, factCheckFn })
  if (!claims.length) return { skipped: 'no checks could be run' }
  const superseded = v.checks.claims.map((c) => ({ claim: c.claim, verdict: c.verdict }))
  const record = {
    ...v,
    sources: [...new Set([...(v.sources || []), ...claims.flatMap((c) => c.sources.map((x) => x.url))])],
    checks: { ...v.checks, claims, version: CHECKER_VERSION, rechecked: new Date(now).toISOString(), superseded: [...(v.checks.superseded || []), ...superseded] },
  }
  const rkey = due.uri.split('/').pop()
  await api.call('POST', 'com.atproto.repo.putRecord', { body: { repo: s.did, collection: COLLECTION, rkey, record: JSON.parse(JSON.stringify(record)) } })
  await writeLog(api, { kind: 'rechecked', context: 'journal', source: v.source, result: `${(env.PUBLIC_ORIGIN || 'https://autonomist.jason-edelman.org').replace(/\/$/, '')}/journal/${rkey}/`, checks: claims })
  return { rechecked: rkey, verdicts: claims.map((c) => c.verdict) }
}
