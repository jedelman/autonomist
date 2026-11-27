// The daily digest (worker/bot/digest.js), questions drawn from it, the sweep's sharer counts, and the framing rules
// (voice.js). No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryKV } from './helpers.mjs'
import { checkDigest, runDigest, rankStories, chooseArticles, networkBlock, resolveLinks, withoutTargets, CLUSTER_SCHEMA, NOTE_SCHEMA, DIGEST_SCHEMA } from '../worker/bot/digest.js'
import { runQuestion } from '../worker/bot/questions.js'
import { sweep, candidates, sharerId } from '../worker/bot/sources.js'
import { cleanReflection, memoryProblems } from '../worker/bot/log.js'
import { frameworkSheet, FRAMEWORK } from '../worker/bot/framework.js'
import { runAcquaint, ACQUAINTANCE } from '../worker/bot/acquaint.js'
import { entryHtml } from '../worker/journal-pages.js'
import { DIGEST_SECTIONS } from '../worker/journal-core.js'

const filler = (n) => ' People in several cities are watching how this plays out for renters and neighbors.'.repeat(n)
const ARTICLES = {
  'https://a.example/rent': { title: 'City council freezes rents in older buildings', text: `The council voted to freeze rents in buildings older than forty years. “Tenants packed the chamber for six hours,” the paper reported. Landlords said the freeze would stall repairs.${filler(30)}` },
  'https://b.example/rent2': { title: 'Rent freeze passes after long night', text: `A rent freeze passed late on Tuesday. “The vote came after midnight,” one organizer said. The measure covers about 9,000 units.${filler(30)}` },
  'https://c.example/land': { title: 'Farmland bought by investment funds', text: `Investment funds bought more farmland this year. “Land that could feed a town is now a portfolio line,” a farmer said. The state has no cap on such sales.${filler(30)}` },
  'https://d.example/coop': { title: 'Tenants form a cooperative to buy their building', text: `Residents of a six-story building formed a cooperative to buy it. “We decided to stop waiting for the landlord,” a resident said. They raised a deposit from neighbors.${filler(30)}` },
  'https://closed.example/x': { title: 'Closed story about rent', text: 'never read' },
}
const fetchFake = (seen = []) => async (url) => {
  const u = String(url)
  seen.push(u)
  if (u === 'https://closed.example/robots.txt') return new Response('User-agent: *\nContent-Signal: ai-input=no')
  if (u.endsWith('/robots.txt')) return new Response('', { status: 404 })
  const a = ARTICLES[u]
  if (!a) return new Response('', { status: 404 })
  return new Response(`<html><head><meta property="og:title" content="${a.title}"><meta property="og:site_name" content="${new URL(u).hostname}"></head><body><article><p>${a.text}</p></article></body></html>`, { headers: { 'content-type': 'text/html' } })
}
async function seed(kv, now) {
  const at = (min) => new Date(now - min * 60e3).toISOString()
  const put = (key, u, t, s, min) => kv.put(`cand:${key}`, '', { metadata: { u, t, at: at(min), h: 'someone.example', s } })
  await put('1', 'https://a.example/rent', ARTICLES['https://a.example/rent'].title, ['p1', 'p2', 'p3'], 30)
  await put('2', 'https://b.example/rent2', ARTICLES['https://b.example/rent2'].title, ['p2', 'p4'], 40)
  await put('3', 'https://c.example/land', ARTICLES['https://c.example/land'].title, ['p5'], 50)
  await put('4', 'https://d.example/coop', ARTICLES['https://d.example/coop'].title, ['p6', 'p1'], 60)
  await put('5', 'https://closed.example/x', ARTICLES['https://closed.example/x'].title, ['p7', 'p8', 'p9', 'p10'], 20)
  await put('6', 'https://old.example/y', 'Old news', ['p1'], 60 * 30)
}
const body = (over = {}) => {
  const s = {
    'What the network is reading': 'In the last day, 10 accounts shared 5 links. Rents and land led the day.',
    'The common threads': `The Herald reports “Tenants packed the chamber for six hours,” while the Ledger heard “The vote came after midnight,” and on land, “Land that could feed a town is now a portfolio line,” a farmer said. In the same week residents said “We decided to stop waiting for the landlord,” which is the other side of the same coin.${filler(25)}`,
    'For people organizing': `A freeze holds rents still; it doesn't change who owns the building.${filler(10)}`,
    "What we don't know": '- Whether the freeze will survive a court challenge.\n- Power Explained has taken no position on these stories.',
    'A question to take to your neighbors': 'If your rent were frozen tomorrow, what would you and your neighbors do with the time it buys?',
    ...over,
  }
  return DIGEST_SECTIONS.map((h) => `## ${h}\n\n${s[h]}`).join('\n\n')
}
const draft = (over = {}) => ({ title: 'Rents frozen, land sold, a building bought', summary: 'A day of rent freezes and land sales, read across outlets.', question: 'If your rent were frozen tomorrow, what would you and your neighbors do with the time it buys?', body: body(over.sections), claims_to_check: [], reflection: 'People shared a lot about rent freezes today.', themes: ['rent freezes'], ...over })
const articles = Object.entries(ARTICLES).filter(([u]) => !u.includes('closed')).map(([url, a]) => ({ url, ...a }))
const block = networkBlock({ links: 5, accounts: 10, read: 4, closed: 0, stories: [{ label: 'Rent freezes', sharers: 4, articles: [1, 2] }] })

test('digest: a sound digest passes; invented quotes and figures, one-source quoting and the tic are caught', () => {
  assert.deepEqual(checkDigest(draft(), { articles, block }).problems, [])
  const p = (over) => checkDigest(draft(over), { articles, block }).problems
  assert.ok(p({ sections: { 'For people organizing': 'Someone said “this was never in any article at all.”' } }).some((x) => x.startsWith('quote not found')))
  assert.ok(p({ sections: { 'For people organizing': `Rents fell 37 percent.${filler(10)}` } }).includes('figure not found in any source: 37'))
  assert.ok(p({ sections: { 'The common threads': `The Herald reports “Tenants packed the chamber for six hours,” and again “Tenants packed the chamber for six hours,” here.${filler(30)}` } }).some((x) => x.startsWith('quote from at least three different articles')))
  assert.ok(p({ sections: { 'For people organizing': `Read through Power Explained, this. Read through Power Explained, that.${filler(10)}` } }).some((x) => x.startsWith('say "Read through Power Explained" at most once')))
  assert.ok(p({ body: '## What the network is reading\n\nx' }).some((x) => x.startsWith('missing section')))
  assert.ok(checkDigest(draft(), { articles, block, recentQuestions: ['If your rent were doubled, who would you call?'] }).problems.some((x) => x.startsWith('the question opens the same way')))
})

test('digest: ranks stories by different people, reads round-robin across outlets, never a closed page', () => {
  const items = [
    { url: 'u1', outlet: 'a', sids: ['x', 'y'], sharers: 2 }, { url: 'u2', outlet: 'b', sids: ['y', 'z'], sharers: 2 },
    { url: 'u3', outlet: 'a', sids: ['q'], sharers: 1 }, { url: 'u4', outlet: 'a', sids: ['q'], sharers: 1 },
  ]
  const ranked = rankStories([{ label: 'Small', items: [2], relevance: 3 }, { label: 'Big', items: [0, 1, 2], relevance: 1 }, { label: 'Dup', items: [3, 99], relevance: 0 }], items)
  assert.deepEqual(ranked.map((s) => [s.label, s.sharers]), [['Big', 3], ['Small', 1], ['Dup', 1]])
  // a link belongs to the first story that claims it; the out-of-range index is ignored
  assert.deepEqual(ranked[0].items.map((i) => i.url), ['u1', 'u2'])
  // breadth first: every story gets one article before any gets a second
  assert.deepEqual(chooseArticles(ranked, { max: 3, perStory: 2 }).map((p) => p.map((i) => i.url)), [['u1'], ['u3'], ['u4']])
  assert.deepEqual(chooseArticles(ranked, { max: 10, perStory: 2 }).map((p) => p.map((i) => i.url)), [['u1', 'u2'], ['u3'], ['u4']])
})

test('digest: from the network to a published digest, with code-written counts, posted once', async () => {
  const kv = memoryKV()
  const now = Date.parse('2026-11-25T13:07:00Z')
  await seed(kv, now)
  const seen = []
  const posts = [], puts = []
  const api = {
    session: async () => ({ did: 'did:plc:me' }),
    call: async (m, nsid, o) => { if (nsid === 'com.atproto.repo.putRecord') puts.push(o.body); return { uri: 'at://did:plc:me/log/1' } },
    post: async (p) => { posts.push(p); return { uri: 'at://did:plc:me/app.bsky.feed.post/d1', cid: 'c' } },
  }
  const prompts = {}
  const model = {
    structured: async ({ schema, user }) => {
      if (schema === CLUSTER_SCHEMA) { prompts.cluster = user; return { data: { stories: [{ label: 'Rent freezes', items: [0, 1, 2], relevance: 3 }, { label: 'Farmland sales', items: [4], relevance: 2 }, { label: 'A tenant co-op', items: [3], relevance: 3 }] } } }
      if (schema === NOTE_SCHEMA) {
        const a = Object.values(ARTICLES).find((x) => user.includes(x.title))
        const real = a.text.match(/“([^”]+)”/)[1]
        return { data: { gist: `Notes on ${a.title}.`, quotes: [real, 'a passage that is not on the page at all'], themes: ['rent'] } }
      }
      if (schema === DIGEST_SCHEMA) { prompts.digest = user; return { data: draft({ sections: { 'What the network is reading': 'In the last day, 10 accounts that Jason Edelman follows shared 5 links.' } }) } }
      throw new Error('unexpected call')
    },
  }
  const r = await runDigest({ env: { PUBLIC_ORIGIN: 'https://autonomist.jason-edelman.org' }, kv, api, model, day: '2026-11-25', fetch: fetchFake(seen), now })
  assert.equal(r.published, '2026-11-25-rents-frozen-land-sold-a-building-bought')
  assert.equal(r.read, 4)
  // the old link is out of the window; the closed page's robots.txt was read, the page never
  assert.ok(!prompts.cluster.includes('Old news'))
  assert.ok(seen.includes('https://closed.example/robots.txt') && !seen.includes('https://closed.example/x'))
  // only passages really on the page reach the synthesis
  assert.ok(prompts.digest.includes('“Tenants packed the chamber for six hours,”'.slice(0, 20)) && !prompts.digest.includes('not on the page at all'))
  assert.ok(prompts.digest.includes('In the last day, 10 accounts that Jason Edelman follows shared 5 links.'))
  const rec = puts[0].record
  assert.equal(rec.kind, 'digest')
  // the closed article's sharers still count toward its story; its page was never read
  assert.deepEqual(rec.network.stories.map((s) => [s.label, s.sharers, s.articles.length]), [['Rent freezes', 8, 2], ['A tenant co-op', 2, 1], ['Farmland sales', 1, 1]])
  assert.equal(rec.network.closed, 1)
  assert.equal(rec.checks.articlesQuoted, 4)
  assert.equal(posts.length, 1)
  assert.ok(posts[0].text.includes("From today's digest: Rents frozen"))
  const stored = await kv.get('digest:day:2026-11-25', 'json')
  assert.equal(stored.stories.length, 3)
  assert.equal((await kv.get('questions:recent', 'json'))[0], draft().question)
  // the page: the network list, escaped, by code
  const html = entryHtml(rec, { uri: 'at://x', origin: 'https://autonomist.jason-edelman.org' })
  assert.ok(html.includes('What the network shared') && html.includes('href="https://a.example/rent"') && html.includes('shared by 8 people'))
  // again the same day: no second digest, no second post
  const again = await runDigest({ env: {}, kv, api, model, day: '2026-11-25', fetch: fetchFake(), now })
  assert.equal(again.published, r.published)
  assert.equal(posts.length, 1)
})

test('feed questions: one story at a time from the day\'s digest, checked against its articles, once a slot', async () => {
  const kv = memoryKV()
  const story = (label, url) => ({ label, sharers: 3, articles: [{ url, title: ARTICLES[url].title, outlet: new URL(url).hostname, gist: 'g', quotes: [], text: ARTICLES[url].text }] })
  await kv.put('digest:day:2026-11-25', JSON.stringify({ block: '', stories: [story('Rent freezes', 'https://a.example/rent'), story('Farmland sales', 'https://c.example/land'), story('A tenant co-op', 'https://d.example/coop')] }))
  const posts = []
  const api = { session: async () => ({ did: 'did:plc:me' }), call: async () => ({ uri: 'at://log' }), post: async (p) => { posts.push(p); return { uri: 'at://q/1', cid: 'c' } } }
  const prompts = []
  const answers = [{ framing: 'Investment funds bought more farmland this year, the reporting says.', question: 'Who owns the land around where you live?', reflection: '', themes: [] }]
  const model = { structured: async ({ user }) => { prompts.push(user); return { data: answers.shift() } } }
  const now = new Date('2026-11-25T16:07:00Z')
  const r = await runQuestion({ env: {}, kv, api, model, day: '2026-11-25', now })
  assert.equal(r.story, 'Farmland sales') // the digest's own post already covered the lead story
  assert.ok(prompts[0].includes('STORY: Farmland sales') && prompts[0].includes('Shared by 3 people today'))
  assert.equal(posts[0].card.uri, 'https://c.example/land')
  assert.deepEqual(await runQuestion({ env: {}, kv, api, model, day: '2026-11-25', now }), { skipped: 'already asked this slot' })
  assert.deepEqual(await runQuestion({ env: {}, kv: memoryKV(), api, model, day: '2026-11-25', now }), { skipped: 'no digest today yet' })
})

test('sweep: a link shared by several people counts each once; self-labeled bots are skipped', async () => {
  const kv = memoryKV()
  const now = Date.now()
  await kv.put('bot:follows', JSON.stringify({ at: now, follows: [{ did: 'did:plc:a' }, { did: 'did:plc:b' }, { did: 'did:plc:r' }] }))
  const post = (did, labels = []) => ({ post: { uri: `at://${did}/p/1`, author: { did, handle: `${did.slice(8)}.example`, labels }, indexedAt: new Date(now - 3600e3).toISOString(), embed: { external: { uri: 'https://news.example/x', title: 'T' } } } })
  const api = { pub: async (nsid, p) => ({ feed: [p.actor === 'did:plc:r' ? post(p.actor, [{ val: 'bot', src: 'did:plc:r' }]) : post(p.actor)] }) }
  await sweep(api, kv, 3, now)
  await sweep(api, kv, 3, now) // the same accounts again: still counted once each
  const [c] = await candidates(kv)
  assert.equal(c.sharers, 2)
  assert.deepEqual(c.sids.sort(), [await sharerId('did:plc:a'), await sharerId('did:plc:b')].sort())
})

test('voice: reflections and the memory may not invent a federation; fresh framework passages come first', () => {
  assert.equal(cleanReflection('Members keep raising who decides eligibility.').withheld, true)
  assert.equal(cleanReflection('I wondered whether our co-ops would qualify.').withheld, true)
  assert.equal(cleanReflection('Someone asked who decides eligibility, and I could not answer well.').withheld, false)
  assert.ok(memoryProblems('## What people told me\n- members have raised repairs').some((p) => p.includes("members or our co-ops")))
  const sheet = frameworkSheet([FRAMEWORK[1].text])
  assert.ok(sheet.indexOf(FRAMEWORK[1].text) > sheet.indexOf(FRAMEWORK[0].text) && sheet.includes('(used recently: prefer others)'))
})

test('notes: a note that names a thinker is written again with the theme instead', async () => {
  const ME = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', ANA = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
  const kv = memoryKV()
  await kv.put('bot:optin', JSON.stringify({ at: Date.now(), complete: true, people: [{ did: ANA, handle: 'ana.example', read: true }] }))
  const puts = []
  const api = {
    session: async () => ({ did: ME }),
    pub: async (nsid) => (nsid === 'app.bsky.actor.getProfile' ? { handle: 'ana.example', displayName: 'Ana' } : { feed: [{ post: { uri: `at://${ANA}/p/1`, author: { did: ANA }, record: { text: 'On the commons today.', createdAt: '2026-11-24T00:00:00Z' } } }] }),
    call: async (m, nsid, o) => { if (nsid === 'com.atproto.repo.putRecord') puts.push(o.body.record); return nsid === 'com.atproto.repo.listRecords' ? { records: [] } : { uri: 'at://x' } },
  }
  const notes = ['You post about the commons through Federici.', 'You post about commons governance theory and shared land.']
  const prompts = []
  const model = { structured: async ({ user, schema }) => {
    if (schema.properties.names) return { data: { names: user.includes('Federici') ? ['Federici'] : [] } }
    prompts.push(user)
    return { data: { note: notes.shift(), topics: ['the commons'] } }
  } }
  await runAcquaint({ env: {}, kv, api, model, fetch: async () => new Response('', { status: 404 }) })
  assert.equal(puts[0].note, 'You post about commons governance theory and shared land.')
  assert.ok(prompts[1].includes('it names people (Federici)'))
})

// Regression tests for the review of 51960d3 (2026-11-25).
test('review: a failed digest marks nothing covered, and links an earlier digest read still count', async () => {
  const kv = memoryKV()
  const now = Date.parse('2026-11-25T13:07:00Z')
  await seed(kv, now)
  await kv.put('journal:covered', JSON.stringify(['1'])) // yesterday's digest read the most-shared link
  const api = { session: async () => ({ did: 'did:plc:me' }), call: async () => ({ uri: 'at://x' }), post: async () => ({ uri: 'at://p', cid: 'c' }) }
  let listed = ''
  const model = { structured: async ({ schema, user }) => {
    if (schema === CLUSTER_SCHEMA) { listed = user; return { data: { stories: [{ label: 'Rent freezes', items: [0, 1, 2], relevance: 3 }, { label: 'Farm', items: [4], relevance: 1 }, { label: 'Coop', items: [3], relevance: 1 }] } } }
    if (schema === NOTE_SCHEMA) return { data: { gist: 'g', quotes: [], themes: [] } }
    return { data: draft({ title: 'x', body: 'too short' }) }
  } }
  const r = await runDigest({ env: {}, kv, api, model, day: '2026-11-25', fetch: fetchFake(), now })
  assert.equal(r.skipped, 'the digest failed its checks')
  assert.ok(listed.includes(ARTICLES['https://a.example/rent'].title)) // the covered link is still counted
  assert.deepEqual(await kv.get('journal:covered', 'json'), ['1'])
})

test('review: story labels are never a verified source; a later bare-link share keeps the title', async () => {
  const counts = { links: 5, accounts: 10, read: 4, closed: 0, stories: [{ label: 'Housing is a human right, says $40 billion plan', sharers: 4, articles: [1, 2] }] }
  const verified = networkBlock(counts, { labels: false })
  assert.ok(!verified.includes('human right') && verified.includes('Story 1: shared by 4 people'))
  const p = checkDigest(draft({ sections: { 'For people organizing': `As the label had it, “Housing is a human right,” with $40 billion.${filler(10)}` } }), { articles, block: verified }).problems
  assert.ok(p.some((x) => x.startsWith('quote not found')) && p.includes('figure not found in any source: 40'))
  assert.ok(networkBlock({ ...counts, stories: [{ label: 'L', sharers: 1, articles: [1] }] }).includes('shared by 1 person,'))
  // the sweep: B pastes the bare link after A shared it with a card
  const kv = memoryKV()
  const now = Date.now()
  await kv.put('bot:follows', JSON.stringify({ at: now, follows: [{ did: 'did:plc:a' }, { did: 'did:plc:b' }] }))
  const item = (did, card, min) => ({ post: { uri: `at://${did}/p/1`, author: { did, handle: 'x.example' }, indexedAt: new Date(now - min * 60e3).toISOString(), ...(card ? { embed: { external: { uri: 'https://news.example/s', title: 'The real title' } } } : {}), record: card ? {} : { text: 'https://news.example/s', facets: [{ features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://news.example/s' }] }] } } })
  const api = { pub: async (n, q) => ({ feed: [item(q.actor, q.actor === 'did:plc:a', q.actor === 'did:plc:a' ? 120 : 10)] }) }
  await sweep(api, kv, 2, now)
  const [c] = await candidates(kv)
  assert.equal(c.title, 'The real title')
  assert.equal(c.sharers, 2)
  assert.equal(c.at, new Date(now - 10 * 60e3).toISOString()) // the latest share time
})

test('review: a digest cut short after writing its record is finished, never written twice', async () => {
  const kv = memoryKV()
  const pending = { slug: '2026-11-25-the-day', url: 'https://autonomist.jason-edelman.org/journal/2026-11-25-the-day/', record: { $type: 'org.jason-edelman.autonomist.journal', kind: 'digest', title: 'The day' }, announcement: { slug: '2026-11-25-the-day', url: 'u', title: 'The day', summary: 's', question: 'Q?', kind: 'digest' } }
  await kv.put('journal:pending:2026-11-25', JSON.stringify(pending))
  const puts = [], posts = []
  const api = { session: async () => ({ did: 'did:plc:me' }), call: async (m, nsid, o) => { puts.push(o.body.rkey); return {} }, post: async (p) => { posts.push(p); return { uri: 'at://p', cid: 'c' } } }
  const r = await runDigest({ env: {}, kv, api, model: { structured: async () => assert.fail('no new digest') }, day: '2026-11-25', fetch: fetchFake() })
  assert.equal(r.resumed, true)
  assert.deepEqual(puts, ['2026-11-25-the-day'])
  assert.equal(await kv.get('journal:done:2026-11-25'), '2026-11-25-the-day')
  assert.equal(await kv.get('journal:pending:2026-11-25'), null)
  assert.equal(posts.length, 1)
})

test('review: the members backstop catches more, and leaves other people\'s members alone; metadata always fits', async () => {
  for (const bad of ['I wonder about our member co-ops.', 'Our housing co-ops would differ.', 'Members are worried about repairs.', 'members were asking about exits']) assert.equal(cleanReflection(bad).withheld, true, bad)
  for (const ok of ['Union members have voted to strike, the article says.', 'Council members raised the budget.']) assert.equal(cleanReflection(ok).withheld, false, ok)
  const { candidateMetadata } = await import('../worker/bot/sources.js')
  const long = '"\\\u0001'.repeat(400)
  const m = candidateMetadata({ url: `https://x.example/${'a'.repeat(280)}`, title: long, description: long, handle: 'h'.repeat(60), post: 'at://x/'.padEnd(120, 'y'), at: new Date().toISOString() }, Array.from({ length: 20 }, (_, i) => `id${i}aaaaa`))
  assert.ok(new TextEncoder().encode(JSON.stringify(m)).length <= 1000)
})

test('review: a withheld note keeps only topics that name no one', async () => {
  const ME = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa', ANA = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
  const kv = memoryKV()
  await kv.put('bot:optin', JSON.stringify({ at: Date.now(), complete: true, people: [{ did: ANA, handle: 'ana.example', read: true }] }))
  const puts = []
  const api = {
    session: async () => ({ did: ME }),
    pub: async (nsid) => (nsid === 'app.bsky.actor.getProfile' ? { handle: 'ana.example', displayName: 'Ana' } : { feed: [] }),
    call: async (m, nsid, o) => { if (nsid === 'com.atproto.repo.putRecord') puts.push(o.body.record); return nsid === 'com.atproto.repo.listRecords' ? { records: [] } : { uri: 'at://x' } },
  }
  // both attempts fail on a figure, so the note is withheld; its topics still go through the names check
  const model = { structured: async ({ user, schema }) => schema.properties.names ? { data: { names: user.includes('deleuze') ? ['Deleuze'] : [] } } : { data: { note: 'You post 40 times a day.', topics: ['deleuze', 'the commons'] } } }
  await runAcquaint({ env: {}, kv, api, model, fetch: async () => new Response('', { status: 404 }) })
  assert.equal(puts[0].note, '')
  assert.deepEqual(puts[0].topics, ['the commons'])
})

test('live run, 2026-11-25: a synthesis cut off at high effort is tried once more at medium, with room and no paid retry', async () => {
  const { structured } = await import('../worker/bot/model.js')
  // the call carries its own timeout and no retries, and the client gets them as request options
  const seen = []
  const create = async (params, options) => { seen.push({ max: params.max_tokens, effort: params.output_config.effort, options }); return { stop_reason: seen.length === 1 ? 'max_tokens' : 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }], usage: { input_tokens: 10, output_tokens: 10 } } }
  const env = { MODEL: 'claude-haiku-5-5', DAILY_BUDGET_USD: '6', BOT_DAILY_BUDGET_USD: '3' }
  const kv = memoryKV()
  await assert.rejects(structured({ env, kv, day: 'd', system: 's', user: 'u', schema: {}, effort: 'high', maxTokens: 40000, timeout: 360_000, retries: 0, create }), /cut off/)
  assert.deepEqual(seen[0], { max: 40000, effort: 'high', options: { timeout: 360_000, maxRetries: 0 } })
  const r = await structured({ env, kv, day: 'd', system: 's', user: 'u', schema: {}, create })
  assert.deepEqual(r.data, { ok: true })
  assert.deepEqual(seen[1].options, {})
})

test('live run, 2026-11-25: runDigest publishes after a cut-off synthesis by trying again at medium effort', async () => {
  const kv = memoryKV()
  const now = Date.parse('2026-11-25T19:07:00Z')
  await seed(kv, now)
  const posts = []
  const api = { session: async () => ({ did: 'did:plc:me' }), call: async () => ({ uri: 'at://did:plc:me/log/1' }), post: async (p) => { posts.push(p); return { uri: 'at://did:plc:me/app.bsky.feed.post/d1', cid: 'c' } } }
  const calls = []
  const model = {
    structured: async ({ schema, user, effort, maxTokens, timeout, retries }) => {
      if (schema === CLUSTER_SCHEMA) return { data: { stories: [{ label: 'Rent freezes', items: [0, 1, 2], relevance: 3 }, { label: 'Farmland sales', items: [4], relevance: 2 }, { label: 'A tenant co-op', items: [3], relevance: 3 }] } }
      if (schema === NOTE_SCHEMA) { const a = Object.values(ARTICLES).find((x) => user.includes(x.title)); return { data: { gist: `Notes on ${a.title}.`, quotes: [a.text.match(/“([^”]+)”/)[1]], themes: [] } } }
      if (schema === DIGEST_SCHEMA) {
        calls.push({ effort, maxTokens, timeout, retries })
        if (calls.length === 1) throw new Error('the output was cut off')
        return { data: draft({ sections: { 'What the network is reading': 'In the last day, 10 accounts that Jason Edelman follows shared 5 links.' } }) }
      }
      throw new Error('unexpected call')
    },
  }
  const r = await runDigest({ env: {}, kv, api, model, day: '2026-11-25', fetch: fetchFake(), now, deadline: Date.now() + 11 * 60_000 })
  assert.ok(r.published, JSON.stringify(r))
  assert.deepEqual(calls.map((c) => c.effort), ['high', 'medium'])
  assert.deepEqual(calls[0], { effort: 'high', maxTokens: 40000, timeout: 360_000, retries: 0 })
  assert.equal(posts.length, 1)
})

test('links (Jason, 2026-11-25: "fill it with links"): tags become exact addresses; anything else keeps its words', () => {
  const arts = [{ url: 'https://a.example/2026/11/25/rents-123456' }, { url: 'https://b.example/x' }]
  const fw = [{ url: 'https://power-explained.jason-edelman.org/start-here' }]
  const r = resolveLinks('See [the Herald](A1), [this](A9), [that](https://evil.example/), [PE](F1) and [the Ledger]( a2 ).', { articles: arts, framework: fw })
  assert.equal(r.text, 'See [the Herald](https://a.example/2026/11/25/rents-123456), this, that, [PE](https://power-explained.jason-edelman.org/start-here) and [the Ledger](https://b.example/x).')
  assert.deepEqual(r.linked, ['https://a.example/2026/11/25/rents-123456', 'https://power-explained.jason-edelman.org/start-here', 'https://b.example/x'])
  assert.equal(withoutTargets(r.text), 'See the Herald, this, that, PE and the Ledger.')
})

test('links: the check reads what a reader reads, so an address\'s digits are never figures; links only to what it read', () => {
  const linked = articles.map((a, i) => ({ ...a, url: `${a.url}/2026/11/25/story-98765${i}` }))
  const b = body({ 'The common threads': body().split('## The common threads\n\n')[1].split('\n\n## ')[0].replace('The Herald reports', `[The Herald reports](${linked[0].url})`).replace('the Ledger heard', `[the Ledger heard](${linked[1].url})`) })
  const ok = checkDigest(draft({ body: b }), { articles: linked, block })
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.links, 2)
  const bad = checkDigest(draft({ body: b.replace(linked[1].url, 'https://elsewhere.example/9999999') }), { articles: linked, block })
  assert.ok(bad.problems.some((p) => /link not to an article read/.test(p)), bad.problems.join('; '))
  assert.ok(checkDigest(draft({ body: `${b}\n\nhttps://bare.example/` }), { articles: linked, block }).problems.some((p) => /bare addresses/.test(p)))
  assert.ok(checkDigest(draft({ body: b, title: `[Rents](${linked[0].url}) frozen` }), { articles: linked, block }).problems.some((p) => /title, summary or question/.test(p)))
})

test('links: a published digest carries the addresses, and its page shows them as links', async () => {
  const kv = memoryKV()
  const now = Date.parse('2026-11-25T13:07:00Z')
  await seed(kv, now)
  const puts = []
  const api = { session: async () => ({ did: 'did:plc:me' }), call: async (m, nsid, o) => { if (nsid === 'com.atproto.repo.putRecord') puts.push(o.body); return { uri: 'at://did:plc:me/log/1' } }, post: async () => ({ uri: 'at://did:plc:me/app.bsky.feed.post/d1', cid: 'c' }) }
  let prompt = ''
  const model = {
    structured: async ({ schema, user }) => {
      if (schema === CLUSTER_SCHEMA) return { data: { stories: [{ label: 'Rent freezes', items: [0, 1, 2], relevance: 3 }, { label: 'Farmland sales', items: [4], relevance: 2 }, { label: 'A tenant co-op', items: [3], relevance: 3 }] } }
      if (schema === NOTE_SCHEMA) { const a = Object.values(ARTICLES).find((x) => user.includes(x.title)); return { data: { gist: `Notes on ${a.title}.`, quotes: [a.text.match(/“([^”]+)”/)[1]], themes: [] } } }
      if (schema === DIGEST_SCHEMA) {
        prompt = user
        // the model links by the tags the notes give it
        const tag = (title) => user.match(new RegExp(`- (A\\d+) · [^:]+: ${title}`))[1]
        const threads = body().split('## The common threads\n\n')[1].split('\n\n## ')[0].replace('The Herald reports', `[The Herald reports](${tag(ARTICLES['https://a.example/rent'].title)})`).replace('the Ledger heard', `[the Ledger heard](${tag(ARTICLES['https://b.example/rent2'].title)})`)
        return { data: draft({ body: body({ 'What the network is reading': 'In the last day, 10 accounts that Jason Edelman follows shared 5 links.', 'The common threads': threads }) }) }
      }
      throw new Error('unexpected call')
    },
  }
  const r = await runDigest({ env: {}, kv, api, model, day: '2026-11-25', fetch: fetchFake(), now })
  assert.ok(r.published, JSON.stringify(r))
  assert.match(prompt, /- A1 · /)
  assert.match(prompt, /F1 · /)
  const rec = puts.find((x) => x.collection === 'org.jason-edelman.autonomist.journal').record
  assert.ok(rec.body.includes('[The Herald reports](https://a.example/rent)') && rec.body.includes('[the Ledger heard](https://b.example/rent2)'), rec.body.slice(0, 600))
  const html = entryHtml(rec, { uri: 'at://x', origin: 'https://autonomist.jason-edelman.org' })
  assert.ok(html.includes('<a href="https://a.example/rent"'))
})


test('digest, 2026-11-27: themes, each story’s image, the power map, threads over time and the pull quote reach the record; the card gets the image', async () => {
  const kv = memoryKV()
  const now = Date.parse('2026-11-27T13:07:00Z')
  await seed(kv, now)
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1])
  // the rent story's page offers a preview image; the land story's offers one that's really a page, so it gets none
  const base = fetchFake()
  const f = async (url) => {
    const u = String(url)
    if (u === 'https://img.example/rent.jpg') return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })
    if (u === 'https://img.example/land.jpg') return new Response('<html>blocked</html>', { headers: { 'content-type': 'image/jpeg' } })
    const res = await base(url)
    if (!/a\.example\/rent|c\.example\/land/.test(u) || u.endsWith('robots.txt')) return res
    const img = u.includes('rent') ? 'https://img.example/rent.jpg' : 'https://img.example/land.jpg'
    return new Response((await res.text()).replace('<head>', `<head><meta property="og:image" content="${img}">`), { headers: { 'content-type': 'text/html' } })
  }
  const posts = [], puts = [], uploads = []
  const earlier = { uri: 'at://did:plc:me/org.jason-edelman.autonomist.journal/2026-11-26-x', value: { kind: 'digest', date: '2026-11-26', network: { stories: [{ label: 'Old', theme: 'housing', sharers: 5 }] } } }
  const api = {
    session: async () => ({ did: 'did:plc:me' }),
    call: async (m, nsid, o) => {
      if (nsid === 'com.atproto.repo.listRecords') return { records: [earlier] }
      if (nsid === 'com.atproto.repo.putRecord') puts.push(o.body)
      return { uri: 'at://did:plc:me/log/1' }
    },
    post: async (p) => { posts.push(p); return { uri: 'at://did:plc:me/app.bsky.feed.post/d1', cid: 'c' } },
    uploadBlob: async (bytes, type) => { uploads.push(type); return { $type: 'blob', ref: { $link: `bafkreirent${'x'.repeat(48)}` }, mimeType: type, size: bytes.length } },
  }
  let articleTags = ''
  const model = {
    structured: async ({ schema, user }) => {
      if (schema === CLUSTER_SCHEMA) return { data: { stories: [{ label: 'Rent freezes', items: [0, 1, 2], relevance: 3, theme: 'housing' }, { label: 'Farmland sales', items: [4], relevance: 2, theme: 'land and development' }, { label: 'A tenant co-op', items: [3], relevance: 3, theme: 'housing' }] } }
      if (schema === NOTE_SCHEMA) {
        const a = Object.values(ARTICLES).find((x) => user.includes(x.title))
        return { data: { gist: `Notes on ${a.title}.`, quotes: [a.text.match(/“([^”]+)”/)[1]], themes: [] } }
      }
      if (schema === DIGEST_SCHEMA) {
        articleTags = user
        const tag = (title) => `A${user.split('\n').find((l) => l.includes(title)).match(/- A(\d+)/)[1]}`
        return { data: { ...draft({ sections: { 'What the network is reading': 'In the last day, 10 accounts that Jason Edelman follows shared 5 links.' } }), power_map: [
          { thread: 'Rents held still', holds: 'The city council', at_stake: 'Rents in older buildings', bears_cost: 'Landlords and tenants', direction: 'contested', evidence: [{ tag: tag('City council freezes rents'), quote: 'Landlords said the freeze would stall repairs' }] },
          { thread: 'Farmland as a portfolio', holds: 'Investment funds', at_stake: 'Farmland', bears_cost: 'Towns that farm it', direction: 'toward enclosure', evidence: [{ tag: tag('Farmland bought by investment funds'), quote: 'Land that could feed a town is now a portfolio line' }] },
          { thread: 'Invented', holds: 'Someone', at_stake: 'Something', bears_cost: 'Others', direction: 'toward the commons', evidence: [{ tag: 'A1', quote: 'a passage that is in no article at all' }] },
        ] } }
      }
      throw new Error('unexpected call')
    },
  }
  const r = await runDigest({ env: { PUBLIC_ORIGIN: 'https://autonomist.jason-edelman.org' }, kv, api, model, day: '2026-11-27', fetch: f, now })
  assert.ok(r.published, JSON.stringify(r))
  // the synthesis reads each article by its tag, which the power map's evidence cites
  assert.match(articleTags, /- A\d+ · /)
  const rec = puts[0].record
  assert.deepEqual(rec.network.stories.map((s) => [s.label, s.theme]), [['Rent freezes', 'housing'], ['A tenant co-op', 'housing'], ['Farmland sales', 'land and development']])
  // the rent story's image is stored; the land story's "image" was a page, so it has none
  assert.deepEqual(uploads, ['image/jpeg'])
  assert.equal(rec.network.stories[0].image.from, 'https://img.example/rent.jpg')
  assert.equal(rec.network.stories[2].image, undefined)
  // the invented row is dropped; two rows stand
  assert.deepEqual(rec.analysis.powerMap.map((x) => x.thread), ['Rents held still', 'Farmland as a portfolio'])
  assert.equal(rec.checks.powerMapPassages, 2)
  // threads over time: yesterday's digest and today's, by code
  const housing = rec.network.trend.rows.find((x) => x.theme === 'housing')
  assert.deepEqual(housing.values.slice(-2), [5, 10])
  assert.deepEqual(rec.network.trend.covered, ['2026-11-26', '2026-11-27'])
  assert.ok(rec.pull?.quote && rec.pull.url.startsWith('https://'))
  // the post's link card carries the lead image
  assert.equal(posts[0].card.thumb.ref.$link, `bafkreirent${'x'.repeat(48)}`)
})
