// Fact-checking (worker/bot/factcheck.js) and where it shows: replies, the journal, the run journal. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryKV } from './helpers.mjs'
import { onPage, siteOf, citationsOf, verdictOf, factCheck, checkNote } from '../worker/bot/factcheck.js'
import { decide, vetReply } from '../worker/bot/replies.js'
import { claimsToCheck, checkClaims } from '../worker/bot/journal.js'
import { searchCall, SEARCH_USD } from '../worker/bot/model.js'
import { checksHtml } from '../worker/checks-html.js'
import { entryHtml } from '../worker/journal-pages.js'
import { logHtml } from '../worker/thinking-pages.js'
import { normalize } from '../worker/journal-core.js'

const CLAIM = 'The council voted 7 to 2 to sell the complex.'
const PAGES = {
  'https://gov.example/minutes': 'The council voted 7 to 2 to approve the sale of the Elm Street complex to a private buyer.',
  'https://paper.example/story': 'Last night the council voted 7 to 2 to approve the sale of the Elm Street complex, officials said.',
  'https://other.example/news': 'The vote on the complex was postponed until next month by the council chair.',
  'https://closed.example/a': 'The council voted 7 to 2 to approve the sale of the Elm Street complex to a private buyer.',
}
const search = (citations) => async () => ({ content: [{ type: 'text', text: 'Sources agree.', citations }], searches: 2 })
const cite = (url, cited_text) => ({ type: 'web_search_result_location', url, title: url, cited_text })
const fetchFake = async (url) => {
  const u = String(url)
  if (u === 'https://closed.example/robots.txt') return new Response('User-agent: *\nDisallow: /')
  if (u.endsWith('/robots.txt')) return new Response('', { status: 404 })
  if (PAGES[u]) return new Response(`<html><body><p>${PAGES[u]}</p></body></html>`, { headers: { 'content-type': 'text/html' } })
  return new Response('', { status: 404 })
}

test('factcheck: only the span really on the page is kept; sites and verdicts', () => {
  const page = normalize(PAGES['https://gov.example/minutes'])
  assert.equal(onPage('The council voted 7 to 2 to approve the sale', page), 'The council voted 7 to 2 to approve the sale')
  // the first fifteen words match, the tail doesn't: only the fifteen are kept, marked as cut
  assert.equal(onPage('The council voted 7 to 2 to approve the sale of the Elm Street complex to a public trust instead', page), 'The council voted 7 to 2 to approve the sale of the Elm Street complex …')
  assert.equal(onPage('The council voted 9 to 0 to approve the sale', page), null)
  assert.equal(onPage('voted 7 to 2', page), null)
  assert.equal(onPage('The council voted 7 … to a private buyer', page), null) // fewer than six words before the ellipsis
  assert.equal(onPage('The council voted 7 to 2 … to a private buyer', page), 'The council voted 7 to 2 …')
  assert.equal(siteOf('https://news.bbc.co.uk/x'), 'bbc.co.uk')
  assert.equal(siteOf('https://www.gov.example/a'), 'gov.example')
  assert.equal(verdictOf([{ site: 'a', stance: 'supports' }, { site: 'a', stance: 'supports' }]), 'supported') // one site, twice
  assert.equal(verdictOf([{ site: 'a', stance: 'supports' }, { site: 'b', stance: 'supports' }]), 'confirmed')
  assert.equal(verdictOf([{ site: 'a', stance: 'supports' }, { site: 'b', stance: 'supports' }, { site: 'c', stance: 'contradicts' }]), 'disputed')
  assert.equal(verdictOf([{ site: 'a', stance: 'unclear' }]), 'unsettled')
  assert.equal(verdictOf([]), 'unverified')
  assert.deepEqual(citationsOf([{ type: 'text', citations: [cite('https://a.example/1', 'x'), cite('https://a.example/1', 'y'), cite('javascript:alert(1)', 'z')] }]).map((c) => [c.url, c.quotes]), [['https://a.example/1', ['x', 'y']]])
})

test('factcheck: cited pages are fetched by its own code; closed, missing and unmatched sources count for nothing', async () => {
  const kv = memoryKV()
  const stanceInputs = []
  const model = {
    search: search([
      cite('https://gov.example/minutes', 'The council voted 7 to 2 to approve the sale of the Elm Street complex'),
      cite('https://paper.example/story', 'the council voted 7 to 2 to approve the sale of the Elm Street complex'),
      cite('https://closed.example/a', 'The council voted 7 to 2 to approve the sale of the Elm Street complex'),
      cite('https://other.example/news', 'The council voted 7 to 2 to sell it to a developer last week'), // not on the page
      cite('https://gone.example/x', 'The council voted 7 to 2 to approve the sale of the Elm Street complex'), // 404
      cite('https://src.example/article', 'The council voted 7 to 2 to approve the sale of the Elm Street complex'), // the claim's own outlet
    ]),
    structured: async ({ user }) => { stanceInputs.push(user); return { data: { stances: [{ index: 0, stance: 'supports' }, { index: 1, stance: 'supports' }] } } },
  }
  const c = await factCheck({ env: {}, kv, model, day: 'd', claim: CLAIM, exclude: ['src.example'], fetch: fetchFake })
  assert.equal(c.verdict, 'confirmed')
  assert.deepEqual(c.sources.map((s) => s.site), ['gov.example', 'paper.example'])
  assert.equal(c.dropped, 3)
  assert.ok(!stanceInputs[0].includes('closed.example'))
  assert.equal(await kv.get('bot:searches:d'), '2')
  // the note offers only verified URLs
  assert.ok(checkNote(c).includes('https://gov.example/minutes') && !checkNote(c).includes('other.example'))
  // the day's searches are capped
  await kv.put('bot:searches:d', '30')
  assert.equal(await factCheck({ env: {}, kv, model, day: 'd', claim: CLAIM, fetch: fetchFake }), null)
})

test('factcheck: a reply asks for a check, answers from it, and may link only a source the check verified', async () => {
  const kv = memoryKV()
  const check = { claim: CLAIM, verdict: 'supported', sources: [{ url: 'https://gov.example/minutes', site: 'gov.example', quote: 'The council voted 7 to 2', stance: 'supports' }] }
  const prompts = []
  const answers = [
    { action: 'reply', text: 'Let me check.', why: '', check: CLAIM },
    { action: 'reply', text: 'The minutes say so: https://gov.example/minutes', why: '', check: '' },
  ]
  const model = { search: async () => assert.fail('decide goes through the injected check'), structured: async ({ user }) => { prompts.push(user); return { data: answers.shift() } } }
  const r = await decide({ env: {}, kv, model, day: 'd', user: 'THREAD', factCheckFn: async () => check })
  assert.equal(r.out.text, 'The minutes say so: https://gov.example/minutes')
  assert.ok(prompts[1].includes('FACT-CHECK') && prompts[1].includes('Verdict: supported'))
  assert.equal(r.check, check)
  // a link the check didn't verify is refused, and only one outside link is allowed
  assert.equal(vetReply('See https://paper.example/story', ['https://gov.example/minutes']).ok, false)
  assert.equal(vetReply('See https://gov.example/minutes and https://gov.example/minutes?x', ['https://gov.example/minutes', 'https://gov.example/minutes?x']).ok, false)
  assert.equal(vetReply('See https://autonomist.jason-edelman.org/model/ and https://gov.example/minutes', ['https://gov.example/minutes']).ok, true)
  // without search, no check is run and the reply stands on its own
  const plain = await decide({ env: {}, kv, model: { structured: async () => ({ data: { action: 'reply', text: 'Hello.', why: '', check: CLAIM } }) }, day: 'd', user: 'T', factCheckFn: async () => assert.fail('no search') })
  assert.equal(plain.out.text, 'Hello.')
  // a check that throws leaves the reply unchecked, and the model is told it couldn't be run
  const told = []
  const failing = await decide({ env: {}, kv, model: { search: () => {}, structured: async ({ user }) => { told.push(user); return { data: { action: 'reply', text: 'I could not check that.', why: '', check: CLAIM } } } }, day: 'd', user: 'T', factCheckFn: async () => { throw new Error('site budget reached') } })
  assert.equal(failing.out.text, 'I could not check that.')
  assert.equal(failing.check, null)
  assert.ok(told[1].includes('none could be run'))
})

test('factcheck: journal claims are held to the article; checks skip its own site and never block the entry', async () => {
  const article = { title: 'Council sells complex', text: 'The council voted 7 to 2 to sell the complex for $38 million.', url: 'https://www.src.example/article' }
  const claims = claimsToCheck({ claims_to_check: ['The article reports the council voted 7 to 2.', 'It sold for $45 million.', 'It says “sold”.', 'See https://x.example', 'A third claim.', 'A fourth.'] }, article)
  assert.deepEqual(claims, ['The article reports the council voted 7 to 2.', 'A third claim.'])
  const seen = []
  const out = await checkClaims({ env: {}, kv: memoryKV(), model: { search: () => {} }, day: 'd', draft: { claims_to_check: claims }, article, factCheckFn: async (o) => { seen.push(o.exclude); return { claim: o.claim, verdict: 'unverified', sources: [] } } })
  assert.equal(out.length, 2)
  assert.deepEqual(seen[0], ['src.example'])
  const failing = await checkClaims({ env: {}, kv: memoryKV(), model: { search: () => {} }, day: 'd', draft: { claims_to_check: claims }, article, factCheckFn: async () => { throw new Error('bot budget reached') } })
  assert.deepEqual(failing, [])
})

test('factcheck: search calls are priced per search and continue a paused turn within the cap', async () => {
  const kv = memoryKV()
  const calls = []
  const create = async (p) => {
    calls.push(p)
    return calls.length === 1
      ? { stop_reason: 'pause_turn', usage: { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 2 } }, content: [{ type: 'text', text: 'a' }] }
      : { stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 1 } }, content: [{ type: 'text', text: 'b' }] }
  }
  const r = await searchCall({ env: {}, kv, day: 'd', system: 's', user: 'u', maxUses: 3, create })
  assert.equal(r.searches, 3)
  assert.ok(Math.abs(r.usd - 3 * SEARCH_USD) < 1e-9)
  assert.equal(calls[0].tools[0].max_uses, 3)
  assert.equal(calls[1].tools[0].max_uses, 1)
  assert.equal(calls[1].messages.length, 2)
  assert.ok(!('format' in calls[0].output_config))
})

test('factcheck: pages show checks escaped, with code-given verdicts and only http(s) links', () => {
  const checks = [{ claim: 'A <b>claim</b>', verdict: 'confirmed', sources: [{ url: 'https://gov.example/m', quote: 'words <script>', stance: 'supports' }, { url: 'javascript:alert(1)', quote: 'x', stance: 'supports' }] }, { claim: 'Made up', verdict: 'true!' }]
  const html = checksHtml(checks)
  assert.ok(html.includes('A &lt;b&gt;claim&lt;/b&gt;') && html.includes('words &lt;script&gt;'))
  assert.ok(html.includes('href="https://gov.example/m"') && !html.includes('javascript:'))
  assert.ok(!html.includes('Made up'))
  const entry = entryHtml({ title: 'T', date: '2026-11-24', body: 'Body.', sources: [], checks: { quotes: 1, figures: 0, claims: checks } }, { uri: 'at://x', origin: 'https://autonomist.jason-edelman.org' })
  assert.ok(entry.includes('Checked against other sources'))
  assert.ok(!entryHtml({ title: 'T', date: 'd', body: 'B', sources: [] }, { uri: 'at://x' }).includes('Checked against'))
  const log = logHtml([{ value: { kind: 'replied', context: 'reply', createdAt: '2026-11-24T00:00:00Z', checks } }])
  assert.ok(log.includes('Fact-checked first'))
})

test('live view: the /thinking/ CSP widens only connect-src, to exactly the Jetstream hosts live.js uses', async () => {
  const { readFileSync } = await import('node:fs')
  const { THINKING_CSP, JETSTREAM_HOSTS } = await import('../worker/thinking-pages.js')
  const { CSP } = await import('../worker/index.js')
  const live = readFileSync(new URL('../site/js/live.js', import.meta.url), 'utf8')
  const used = JSON.parse(live.match(/const HOSTS = (\[[^\]]*\])/)[1].replace(/'/g, '"'))
  assert.deepEqual(used, JETSTREAM_HOSTS)
  const dir = (p) => Object.fromEntries(p.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]))
  const a = dir(CSP), b = dir(THINKING_CSP)
  for (const k of Object.keys(a)) if (k !== 'connect-src') assert.deepEqual(b[k], a[k], k)
  assert.deepEqual(b['connect-src'], ["'self'", ...JETSTREAM_HOSTS.map((h) => `wss://${h}`)])
  // it connects only on a click, builds no markup from records, and sets no inline style or handler attribute
  assert.ok(/addEventListener\('click'/.test(live) && !/innerHTML|insertAdjacentHTML|document\.write|\.style\.|setAttribute\('on/.test(live))
})
