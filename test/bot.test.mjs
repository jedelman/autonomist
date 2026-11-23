// The bot (worker/bot/), against a fake KV, a fake Bluesky and a fake model. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryKV } from './helpers.mjs'
import { graphemes, bytes, fits, linkFacets } from '../worker/bot/text.js'
import { normalizeUrl, linksFromItem, sweep, candidates } from '../worker/bot/sources.js'
import { checkDraft, runJournal, COLLECTION } from '../worker/bot/journal.js'
import { runReplies, vetReply } from '../worker/bot/replies.js'
import { ensurePinned, runOptin, PINNED_TEXT, PROFILE_DESCRIPTION } from '../worker/bot/optin.js'
import { checkQuestion, dueSlot, runQuestion } from '../worker/bot/questions.js'
import { fetchReadable, numberIn, normalize, readArticle } from '../worker/journal-core.js'
import { candidateMetadata } from '../worker/bot/sources.js'
import { fillShell } from '../worker/journal-pages.js'
import { structured, BudgetError } from '../worker/bot/model.js'
import { client, jwtExp } from '../worker/bot/atproto.js'
import { entryHtml, listItems } from '../worker/journal-pages.js'
import { FRAMEWORK } from '../worker/bot/framework.js'
import { SECTIONS } from '../worker/journal-core.js'

const ARTICLE_TEXT = 'The city council voted 7 to 2 to sell the 140-unit public housing complex to a private developer for $38 million. Tenants said they were not consulted. "We found out from the newspaper," said one resident. The developer plans renovations that would raise rents by 40 percent over five years. A tenants union has formed and is asking for a right of first refusal.'
const article = { title: 'Council sells public housing to developer', text: ARTICLE_TEXT, url: 'https://news.example/housing-sale', siteName: 'News Example', authors: ['A. Reporter'], published: '2026-11-23', words: 400 }

const body = (over = {}) => {
  const s = {
    'What it says': 'The council sold a 140-unit complex for $38 million. The article reports that rents would rise by 40 percent. One tenant: “We found out from the newspaper.”',
    'Through Power Explained': `**Who does the current design serve?** The developer. Power Explained says “${FRAMEWORK[1].text}” **State, market, or commons?** The state sold to the market. **Building, or waiting?** The tenants are organizing. **Where they meet.** The union.`,
    'What it means for the federation': 'A federation could help tenants buy.',
    "What we don't know": '- Whether the sale can be stopped.\n- Power Explained has taken no position on this article.',
    'A question to take to your neighbors': 'Who on your block would you call first?',
    ...over,
  }
  const filler = ' The tenants met again.'.repeat(70)
  return SECTIONS.map((h) => `## ${h}\n\n${s[h]}${h === 'What it means for the federation' ? filler : ''}`).join('\n\n')
}
const draft = (over = {}) => ({ title: 'A sale nobody asked the tenants about', summary: 'A city sold public housing; read through Power Explained.', question: 'Who on your block would you call first?', body: body(over.sections), ...over })

test('text: graphemes, bytes, and link facets by UTF-8 byte range', () => {
  assert.equal(graphemes('a👍🏽b'), 3)
  assert.equal(bytes('é'), 2)
  assert.ok(fits('x'.repeat(300)) && !fits('x'.repeat(301)))
  const t = 'Read 🏠 https://a.example/x now'
  const [f] = linkFacets(t, ['https://a.example/x'])
  assert.equal(new TextDecoder().decode(new TextEncoder().encode(t).slice(f.index.byteStart, f.index.byteEnd)), 'https://a.example/x')
})

test('sources: links from external embeds and facets; reposts, media and social hosts skipped; tracking stripped', () => {
  assert.equal(normalizeUrl('http://x.example/a/?utm_source=bsky&id=3#top'), 'https://x.example/a/?id=3')
  const item = { post: { uri: 'at://did:plc:a/app.bsky.feed.post/1', author: { handle: 'a.example' }, indexedAt: new Date().toISOString(), embed: { $type: 'app.bsky.embed.external#view', external: { uri: 'https://news.example/story?utm_medium=x', title: 'Story', description: 'D' } }, record: { facets: [{ features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://bsky.app/profile/x' }, { $type: 'app.bsky.richtext.facet#link', uri: 'https://img.example/p.jpg' }, { $type: 'app.bsky.richtext.facet#link', uri: 'https://other.example/b' }] }] } } }
  assert.deepEqual(linksFromItem(item).map((l) => l.url), ['https://news.example/story', 'https://other.example/b'])
  assert.deepEqual(linksFromItem({ ...item, reason: { $type: 'app.bsky.feed.defs#reasonRepost' } }), [])
})

test('sources: a sweep reads the next accounts, keeps fresh links as candidates, and moves its cursor', async () => {
  const kv = memoryKV()
  await kv.put('bot:follows', JSON.stringify({ at: Date.now(), follows: [{ did: 'did:plc:a' }, { did: 'did:plc:b' }, { did: 'did:plc:c' }] }))
  const now = Date.now()
  const api = { pub: async (nsid, p) => ({ feed: p.actor === 'did:plc:b' ? [{ post: { uri: 'at://b/1', author: { handle: 'b.example' }, indexedAt: new Date(now - 3600e3).toISOString(), embed: { external: { uri: 'https://news.example/x', title: 'T' } } } }, { post: { uri: 'at://b/0', author: { handle: 'b.example' }, indexedAt: new Date(now - 5 * 86400e3).toISOString(), embed: { external: { uri: 'https://old.example/y' } } } }] : [] }) }
  const r = await sweep(api, kv, 2, now)
  assert.deepEqual(r, { read: 2, links: 1 })
  assert.equal(await kv.get('bot:follows:cursor'), '2')
  const c = await candidates(kv)
  assert.equal(c.length, 1)
  assert.equal(c[0].url, 'https://news.example/x')
})

test('journal: a sound draft passes; invented quotes, figures, links, handles and missing sections are caught', () => {
  const ok = checkDraft(draft(), article)
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.quotes, 2)
  assert.deepEqual(ok.frameworkUrls, [FRAMEWORK[1].url])
  const fake = checkDraft(draft({ sections: { 'What it says': 'The council sold it. “Tenants were thrilled,” the article says.' } }), article)
  assert.ok(fake.problems.some((p) => p.startsWith('quote not found')))
  const num = checkDraft(draft({ sections: { 'What it says': 'It sold for $52 million. “We found out from the newspaper.”' } }), article)
  assert.ok(num.problems.includes('figure not found in any source: 52'))
  const link = checkDraft(draft({ sections: { 'What it says': 'See https://evil.example now. “We found out from the newspaper.”' } }), article)
  assert.ok(link.problems.some((p) => p.startsWith('link not allowed')))
  const handle = checkDraft(draft({ sections: { 'What it says': 'As @someone.bsky.social said. “We found out from the newspaper.”' } }), article)
  assert.ok(handle.problems.includes('no @handles'))
  assert.ok(checkDraft({ ...draft(), body: '## What it says\n\nx' }, article).problems.some((p) => p.startsWith('missing section')))
  assert.ok(checkDraft(draft({ question: 'Not a question.' }), article).problems.some((p) => p.startsWith('the question')))
  assert.ok(checkDraft(draft({ sections: { 'What it says': 'They said "tenants loved it". “We found out from the newspaper.”' } }), article).problems.some((p) => p.startsWith('no straight double quotes')))
})

function fakeApi({ notifications = [], threads = {}, likes = [], feeds = {} } = {}) {
  const calls = [], posts = []
  let n = 0
  return {
    calls, posts,
    session: async () => ({ did: 'did:plc:me', accessJwt: 'x' }),
    call: async (method, nsid, opts) => {
      calls.push({ method, nsid, opts })
      if (nsid === 'app.bsky.notification.listNotifications') return { notifications }
      if (nsid === 'com.atproto.repo.getRecord') return { uri: 'at://did:plc:me/app.bsky.actor.profile/self', cid: 'c0', value: { $type: 'app.bsky.actor.profile', displayName: 'autonomist', labels: { $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'bot' }] } } }
      return { uri: 'at://x', cid: 'c' }
    },
    pub: async (nsid, p) => {
      if (nsid === 'app.bsky.feed.getPostThread') return threads[p.uri] || { thread: { post: { author: { handle: 'someone.example', did: 'did:plc:s' }, record: { text: 'hi' } } } }
      if (nsid === 'app.bsky.feed.getLikes') return { likes }
      if (nsid === 'app.bsky.feed.getAuthorFeed') return { feed: feeds[p.actor] || [] }
      return {}
    },
    post: async (p) => { posts.push(p); n++; return { uri: `at://did:plc:me/app.bsky.feed.post/${n}`, cid: `c${n}` } },
  }
}

test('journal: picks, reads an open page, writes, checks, stores the record in its repo and posts the question', async () => {
  const kv = memoryKV()
  await kv.put('cand:abc', '', { metadata: { u: article.url, t: article.title, d: 'd', h: 'friend.example', p: 'at://did:plc:f/app.bsky.feed.post/9', at: new Date().toISOString() } })
  const api = fakeApi()
  const answers = [{ picks: [{ index: 0, why: 'housing' }] }, draft()]
  const model = { structured: async () => ({ data: answers.shift() }) }
  const html = `<html><head><meta property="og:title" content="${article.title}"><meta property="og:site_name" content="News Example"></head><body><article>${ARTICLE_TEXT.split('. ').map((s) => `<p>${s}. ${'Context sentence about the city and its tenants. '.repeat(10)}</p>`).join('')}</article></body></html>`
  const f = async (url) => (String(url).endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response(html, { headers: { 'content-type': 'text/html' } }))
  const r = await runJournal({ env: { PUBLIC_ORIGIN: 'https://autonomist.jason-edelman.org' }, kv, api, model, day: '2026-11-24', fetch: f })
  assert.equal(r.published, '2026-11-24-a-sale-nobody-asked-the-tenants-about')
  const put = api.calls.find((c) => c.nsid === 'com.atproto.repo.putRecord')
  assert.equal(put.opts.body.collection, COLLECTION)
  assert.equal(put.opts.body.record.via.handle, 'friend.example')
  assert.deepEqual(put.opts.body.record.sources, [article.url, FRAMEWORK[1].url])
  assert.equal(api.posts.length, 1)
  assert.ok(api.posts[0].text.startsWith('Who on your block would you call first?'))
  assert.equal(api.posts[0].card.uri, `https://autonomist.jason-edelman.org/journal/${r.published}/`)
  assert.ok(await kv.get('journal:done:2026-11-24'))
  const again = await runJournal({ env: {}, kv, api, model, day: '2026-11-24', fetch: f })
  assert.equal(again.published, r.published)
  assert.equal(api.posts.length, 1)
})

test('journal: a page closed by Content-Signal is never fetched, and a draft that fails twice is not published', async () => {
  const kv = memoryKV()
  await kv.put('cand:abc', '', { metadata: { u: 'https://closed.example/a', t: 'Closed', at: new Date().toISOString() } })
  await kv.put('cand:def', '', { metadata: { u: article.url, t: 'Open', at: new Date(Date.now() - 1000).toISOString() } })
  const api = fakeApi()
  const bad = draft({ sections: { 'What it says': '“Invented words entirely.”' } })
  const answers = [{ picks: [{ index: 0, why: '' }, { index: 1, why: '' }] }, bad, bad]
  const model = { structured: async () => ({ data: answers.shift() }) }
  const fetched = []
  const f = async (url) => {
    fetched.push(String(url))
    if (String(url) === 'https://closed.example/robots.txt') return new Response('User-agent: *\nContent-Signal: ai-input=no')
    if (String(url).endsWith('/robots.txt')) return new Response('', { status: 404 })
    return new Response(`<p>${ARTICLE_TEXT} ${'More reporting on the sale and the tenants. '.repeat(40)}</p>`, { headers: { 'content-type': 'text/html' } })
  }
  const r = await runJournal({ env: {}, kv, api, model, day: '2026-11-24', fetch: f })
  assert.equal(r.skipped, 'nothing passed')
  assert.ok(!fetched.includes('https://closed.example/a'))
  assert.equal(api.posts.length, 0)
  assert.equal(api.calls.filter((c) => c.nsid === 'com.atproto.repo.putRecord').length, 0)
})

test('replies: answers a reply in its thread, once; caps a bot; skips spam; moves the cursor', async () => {
  const kv = memoryKV()
  await kv.put('bot:notif:seen', '2026-11-24T00:00:00.000Z')
  const reply = (i, author) => ({ uri: `at://did:plc:u/app.bsky.feed.post/${i}`, cid: `c${i}`, reason: 'reply', indexedAt: `2026-11-24T00:0${i}:00.000Z`, author, record: { reply: { root: { uri: 'at://did:plc:me/app.bsky.feed.post/root', cid: 'rc' }, parent: { uri: 'at://did:plc:me/app.bsky.feed.post/root', cid: 'rc' } } } })
  const human = { did: 'did:plc:u', handle: 'u.example' }
  const api = fakeApi({ notifications: [reply(1, human), reply(2, human), { uri: 'at://like', reason: 'like', indexedAt: '2026-11-24T00:03:00.000Z', author: human }] })
  const answers = [{ action: 'reply', text: 'Good question. Who owns your building?', why: '' }, { action: 'skip', text: '', why: 'spam' }]
  const model = { structured: async () => ({ data: answers.shift() }) }
  const r = await runReplies({ env: {}, kv, api, model, day: '2026-11-24', now: new Date('2026-11-24T00:05:00Z') })
  assert.equal(api.posts.length, 1)
  assert.deepEqual(api.posts[0].reply, { root: { uri: 'at://did:plc:me/app.bsky.feed.post/root', cid: 'rc' }, parent: { uri: 'at://did:plc:u/app.bsky.feed.post/1', cid: 'c1' } })
  assert.equal(r.handled[1].skipped, 'spam')
  assert.equal(await kv.get('bot:notif:seen'), '2026-11-24T00:03:00.000Z')
  assert.ok(api.calls.some((c) => c.nsid === 'app.bsky.notification.updateSeen'))
  // run again: nothing new, nothing posted
  await kv.put('bot:notif:seen', '2026-11-24T00:00:00.000Z')
  await runReplies({ env: {}, kv, api, model, day: '2026-11-24' })
  assert.equal(api.posts.length, 1)
  // a self-labeled bot gets at most two answers per thread per day
  const kv2 = memoryKV()
  await kv2.put('bot:notif:seen', '2026-11-24T00:00:00.000Z')
  const bot = { did: 'did:plc:b', handle: 'b.example', labels: [{ val: 'bot', src: 'did:plc:b' }] }
  const api2 = fakeApi({ notifications: [1, 2, 3].map((i) => reply(i, bot)) })
  const model2 = { structured: async () => ({ data: { action: 'reply', text: 'Hello.', why: '' } }) }
  await runReplies({ env: {}, kv: kv2, api: api2, model: model2, day: '2026-11-24' })
  assert.equal(api2.posts.length, 2)
})

test('replies: a reply with an @handle, a stray link or too many characters is refused', () => {
  assert.equal(vetReply('Ask @someone.bsky.social').ok, false)
  assert.equal(vetReply('See https://evil.example').ok, false)
  assert.equal(vetReply('x'.repeat(301)).ok, false)
  assert.deepEqual(vetReply('Try https://autonomist.jason-edelman.org/chat/').links, ['https://autonomist.jason-edelman.org/chat/'])
})

test('opt-in: the pinned post is made once, pinned, and described; likers get at most one reply a day; bots none', async () => {
  const kv = memoryKV()
  const api = fakeApi({
    likes: [{ actor: { did: 'did:plc:h', handle: 'h.example' } }, { actor: { did: 'did:plc:r', handle: 'r.example', labels: [{ val: 'bot', src: 'did:plc:r' }] } }],
    feeds: { 'did:plc:h': [{ post: { uri: 'at://did:plc:h/app.bsky.feed.post/1', cid: 'h1', author: { did: 'did:plc:h' }, indexedAt: new Date().toISOString(), record: { text: 'Our landlord raised rent again.' } } }, { post: { uri: 'at://did:plc:h/app.bsky.feed.post/0', cid: 'h0', author: { did: 'did:plc:h' }, indexedAt: new Date().toISOString(), record: { text: 'older' } } }] },
  })
  assert.ok(graphemes(PINNED_TEXT) <= 300 && graphemes(PROFILE_DESCRIPTION) <= 256)
  const p = await ensurePinned({ kv, api })
  assert.equal(p.created, true)
  const prof = api.calls.find((c) => c.nsid === 'com.atproto.repo.putRecord').opts.body.record
  assert.equal(prof.pinnedPost.uri, 'at://did:plc:me/app.bsky.feed.post/1')
  assert.deepEqual(prof.labels, { $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'bot' }] })
  assert.equal(prof.displayName, 'autonomist')
  assert.deepEqual(await ensurePinned({ kv, api }), { pinned: 'known' })
  const model = { structured: async () => ({ data: { action: 'reply', text: 'Who else in your building got that notice?', why: '' } }) }
  const r = await runOptin({ env: {}, kv, api, model, day: '2026-11-24' })
  assert.equal(r.optedIn, 2)
  assert.equal(r.replied, 1)
  assert.equal(api.posts.at(-1).reply.parent.uri, 'at://did:plc:h/app.bsky.feed.post/1')
  const again = await runOptin({ env: {}, kv, api, model, day: '2026-11-24' })
  assert.equal(again.replied, 0)
})

test('model: priced, capped, parsed; a refusal throws', async () => {
  const kv = memoryKV()
  const env = { DAILY_BUDGET_USD: '3', BOT_DAILY_BUDGET_USD: '1' }
  const create = async (params) => {
    assert.equal(params.output_config.format.type, 'json_schema')
    return { stop_reason: 'end_turn', usage: { input_tokens: 100_000, output_tokens: 0 }, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"a":1}' }] }
  }
  const r = await structured({ env, kv, day: 'd', system: 's', user: 'u', schema: { type: 'object' }, create })
  assert.deepEqual(r.data, { a: 1 })
  assert.ok(Math.abs(r.usd - 0.01) < 1e-9)
  await kv.put('botspend:d:x', '', { metadata: { micros: 1_000_000 } })
  await assert.rejects(structured({ env, kv, day: 'd', system: 's', user: 'u', schema: {}, create }), BudgetError)
  await assert.rejects(structured({ env: {}, kv: memoryKV(), day: 'd', system: 's', user: 'u', schema: {}, create: async () => ({ stop_reason: 'refusal', usage: {}, content: [] }) }), /declined/)
})

test('atproto: keeps the session, refreshes near expiry, and logs in only when it must', async () => {
  const kv = memoryKV()
  const jwt = (exp) => `x.${btoa(JSON.stringify({ exp })).replace(/=+$/, '')}.y`
  assert.equal(jwtExp(jwt(123)), 123)
  const seen = []
  const t0 = 1_800_000_000_000
  const pdsFetch = async (req) => {
    const nsid = new URL(req.url).pathname.split('/').pop()
    seen.push(nsid)
    const s = { did: 'did:plc:me', handle: 'me', accessJwt: jwt(t0 / 1000 + 7200), refreshJwt: jwt(t0 / 1000 + 86400 * 30) }
    return new Response(JSON.stringify(nsid.includes('Session') ? s : { ok: true }))
  }
  const api = client({ HOSTNAME: 'pds.example', PDS_PASSWORD: 'p' }, { pdsFetch, kv, now: () => t0 })
  await api.call('GET', 'x.y.z')
  await api.call('GET', 'x.y.z')
  assert.deepEqual(seen, ['com.atproto.server.createSession', 'x.y.z', 'x.y.z'])
  const later = client({ HOSTNAME: 'pds.example', PDS_PASSWORD: 'p' }, { pdsFetch, kv, now: () => t0 + 7000_000 })
  await later.call('GET', 'x.y.z')
  assert.equal(seen.at(-2), 'com.atproto.server.refreshSession')
  assert.equal(await kv.get(`bot:logins:${new Date(t0).toISOString().slice(0, 10)}`), '1')
})

test('journal pages: model text is escaped, links only to its sources, and lists merge newest first', () => {
  const html = entryHtml({ title: 'T <b>', date: '2026-11-24', source: 'https://news.example/a', headline: 'H', outlet: 'O', authors: ['A'], sources: ['https://news.example/a'], via: { handle: 'f.example', post: 'at://did:plc:abc/app.bsky.feed.post/3x' }, body: '## What it says\n\n<script>x</script> [ok](https://news.example/a) [bad](https://evil.example/)', checks: { quotes: 2, figures: 1 } }, { uri: 'at://did:plc:me/x/y', origin: 'https://autonomist.jason-edelman.org' })
  assert.ok(!html.includes('<script>') && html.includes('T &lt;b&gt;'))
  assert.ok(html.includes('href="https://news.example/a"'))
  assert.ok(!html.includes('href="https://evil.example/"'))
  assert.ok(html.includes('https://bsky.app/profile/did:plc:abc/post/3x'))
  const items = listItems([{ slug: '2026-11-23-a', title: 'A', url: '/journal/2026-11-23-a/' }], [{ uri: 'at://did/c/2026-11-24-b', value: { title: 'B', date: '2026-11-24', outlet: 'O', summary: 'S' } }])
  assert.deepEqual(items.map((x) => x.slug), ['2026-11-24-b', '2026-11-23-a'])
})

test('atproto: a 401 for an unaccepted token logs in again; a 401 from a proxied upstream does not', async () => {
  const kv = memoryKV()
  const jwt = (exp) => `x.${btoa(JSON.stringify({ exp })).replace(/=+$/, '')}.y`
  const t0 = 1_800_000_000_000
  let logins = 0, mode = 'stale'
  const pdsFetch = async (req) => {
    const nsid = new URL(req.url).pathname.split('/').pop()
    if (nsid === 'com.atproto.server.createSession') { logins++; return new Response(JSON.stringify({ did: 'did:plc:me', accessJwt: jwt(t0 / 1000 + 7200), refreshJwt: jwt(t0 / 1000 + 86400) })) }
    if (mode === 'stale' && logins < 2) return new Response(JSON.stringify({ error: 'AuthenticationRequired', message: 'Authentication required' }), { status: 401 })
    if (mode === 'upstream') return new Response(JSON.stringify({ error: 'AuthenticationRequired', message: 'identity unknown' }), { status: 401 })
    return new Response('{"ok":true}')
  }
  const api = client({ HOSTNAME: 'pds.example', PDS_PASSWORD: 'p' }, { pdsFetch, kv, now: () => t0 })
  assert.deepEqual(await api.call('GET', 'x.y.z'), { ok: true })
  assert.equal(logins, 2)
  mode = 'upstream'
  await assert.rejects(api.call('GET', 'app.bsky.notification.listNotifications'), /identity unknown/)
  assert.equal(logins, 2)
})

test('questions: due slots; a sound question passes; invented figures, links, handles and length are refused', () => {
  assert.equal(dueSlot([16, 20], new Date('2026-11-24T15:59:00Z')), null)
  assert.equal(dueSlot([16, 20], new Date('2026-11-24T17:10:00Z')), 16)
  assert.equal(dueSlot([16, 20], new Date('2026-11-24T23:00:00Z')), 20)
  const ok = checkQuestion({ framing: 'A report in News Example says the council sold a 140-unit complex to a developer.', question: 'Who would your building be sold to, and would anyone ask you first?' }, article)
  assert.deepEqual(ok.problems, [])
  assert.ok(ok.text.endsWith('first?'))
  assert.ok(checkQuestion({ framing: 'The council sold 900 units.', question: 'Who owns yours?' }, article).problems.includes('figure not found in any source: 900'))
  assert.ok(checkQuestion({ framing: 'See https://x.example', question: 'Who owns yours?' }, article).problems.includes('no links'))
  assert.ok(checkQuestion({ framing: 'As @a.example says.', question: 'Who owns yours?' }, article).problems.includes('no @handles'))
  assert.ok(checkQuestion({ framing: 'x'.repeat(270), question: 'Who owns yours?' }, article).problems.some((p) => p.startsWith('too long')))
  assert.ok(checkQuestion({ framing: 'Tenants met.', question: 'Not a question.' }, article).problems.some((p) => p.startsWith('the question')))
})

test('questions: at a due slot, reads an open article, posts the question with the article as a card, once', async () => {
  const kv = memoryKV()
  await kv.put('cand:abc', '', { metadata: { u: article.url, t: article.title, at: new Date().toISOString() } })
  const api = fakeApi()
  const answers = [{ picks: [{ index: 0, why: '' }] }, { framing: 'A report in News Example says the council sold a 140-unit complex.', question: 'Who would your building be sold to, and would anyone ask you first?' }]
  const model = { structured: async () => ({ data: answers.shift() }) }
  const html = `<html><head><meta property="og:title" content="${article.title}"><meta property="og:description" content="The sale."></head><body><p>${ARTICLE_TEXT} ${'More reporting on the sale and the tenants. '.repeat(40)}</p></body></html>`
  const f = async (url) => (String(url).endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response(html, { headers: { 'content-type': 'text/html' } }))
  const now = new Date('2026-11-24T16:02:00Z')
  const r = await runQuestion({ env: {}, kv, api, model, day: '2026-11-24', now, fetch: f })
  assert.equal(r.slot, 16)
  assert.equal(api.posts.length, 1)
  assert.ok(api.posts[0].text.endsWith('ask you first?'))
  assert.equal(api.posts[0].card.uri, article.url)
  assert.equal(api.posts[0].card.description, 'The sale.')
  assert.deepEqual(await runQuestion({ env: {}, kv, api, model, day: '2026-11-24', now, fetch: f }), { skipped: 'already asked this slot' })
  assert.deepEqual(await runQuestion({ env: {}, kv, api, model, day: '2026-11-24', now: new Date('2026-11-24T10:00:00Z'), fetch: f }), { skipped: 'no question due yet' })
})

// Regression tests for the independent review's reproduced findings (2026-11-23).

test('review 1: a failing profile write never posts the opt-in post twice; an unreadable profile is never overwritten', async () => {
  const kv = memoryKV()
  const api = fakeApi()
  const real = api.call
  let fail = 2
  api.call = async (m, nsid, o) => { if (nsid === 'com.atproto.repo.putRecord' && fail-- > 0) throw new Error('putRecord 400'); return real(m, nsid, o) }
  await assert.rejects(ensurePinned({ kv, api }))
  await assert.rejects(ensurePinned({ kv, api }))
  await ensurePinned({ kv, api })
  assert.equal(api.posts.length, 1)
  const kv2 = memoryKV(), api2 = fakeApi()
  api2.call = async (m, nsid) => { if (nsid === 'com.atproto.repo.getRecord') { const e = new Error('getRecord 500'); e.status = 500; throw e } return {} }
  await assert.rejects(ensurePinned({ kv: kv2, api: api2 }))
  assert.equal(api2.posts.length, 0)
})

const note = (i, reason, author, parentUri = 'at://did:plc:me/app.bsky.feed.post/root') => ({ uri: `at://did:plc:u/app.bsky.feed.post/${i}`, cid: `c${i}`, reason, indexedAt: `2026-11-24T00:0${i}:00.000Z`, author, record: reason === 'reply' ? { reply: { root: { uri: 'at://did:plc:me/app.bsky.feed.post/root', cid: 'rc' }, parent: { uri: parentUri, cid: 'pc' } } } : { text: 'hi @autonomist' } })
const human = { did: 'did:plc:u', handle: 'u.example' }

test('review 2-3: one failing notification is passed, not retried; a failure after posting never posts again', async () => {
  const kv = memoryKV()
  await kv.put('bot:notif:seen', '2026-11-24T00:00:00.000Z')
  const api = fakeApi({ notifications: [note(1, 'reply', human), note(2, 'mention', human)] })
  let calls = 0
  const model = { structured: async () => { calls++; if (calls === 1) throw new Error('the model declined'); return { data: { action: 'reply', text: 'Who decides that where you live?', why: '' } } } }
  const r = await runReplies({ env: {}, kv, api, model, day: '2026-11-24' })
  assert.ok(r.handled[0].error)
  assert.equal(api.posts.length, 1)
  await kv.put('bot:notif:seen', '2026-11-24T00:00:00.000Z')
  await runReplies({ env: {}, kv, api, model, day: '2026-11-24' })
  assert.equal(calls, 2)
  assert.equal(api.posts.length, 1)
})

test('review 4: a post that mentions autonomist and is seen by the opt-in sweep gets one answer', async () => {
  const kv = memoryKV()
  await kv.put('bot:notif:seen', '2026-11-24T00:00:00.000Z')
  const postUri = 'at://did:plc:h/app.bsky.feed.post/1'
  const api = fakeApi({
    notifications: [{ uri: postUri, cid: 'h1', reason: 'mention', indexedAt: '2026-11-24T00:01:00.000Z', author: { did: 'did:plc:h', handle: 'h.example' }, record: { text: '@autonomist rent again' } }],
    likes: [{ actor: { did: 'did:plc:h', handle: 'h.example' } }],
    feeds: { 'did:plc:h': [{ post: { uri: postUri, cid: 'h1', author: { did: 'did:plc:h' }, indexedAt: new Date().toISOString(), record: { text: '@autonomist rent again' } } }] },
  })
  await kv.put('bot:pinned', JSON.stringify({ uri: 'at://did:plc:me/app.bsky.feed.post/p', cid: 'p' }))
  const model = { structured: async () => ({ data: { action: 'reply', text: 'Who else got that notice?', why: '' } }) }
  await runReplies({ env: {}, kv, api, model, day: '2026-11-24' })
  await runOptin({ env: {}, kv, api, model, day: '2026-11-24' })
  assert.equal(api.posts.filter((p) => p.reply?.parent?.uri === postUri).length, 1)
})

test('review 5: a failed announcement never makes a second entry, and is retried until it goes out', async () => {
  const kv = memoryKV()
  await kv.put('cand:abc', '', { metadata: { u: article.url, t: article.title, at: new Date().toISOString() } })
  const api = fakeApi()
  const realPost = api.post
  let fail = 1
  api.post = async (p) => { if (fail-- > 0) throw new Error('createRecord 500'); return realPost(p) }
  const answers = [{ picks: [{ index: 0, why: '' }] }, draft(), { picks: [{ index: 0, why: '' }] }, draft({ title: 'Second take' })]
  const model = { structured: async () => ({ data: answers.shift() }) }
  const html = `<p>${ARTICLE_TEXT} ${'More reporting on the sale and the tenants. '.repeat(40)}</p>`
  const f = async (url) => (String(url).endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response(html, { headers: { 'content-type': 'text/html' } }))
  await assert.rejects(runJournal({ env: {}, kv, api, model, day: '2026-11-24', fetch: f }))
  const r2 = await runJournal({ env: {}, kv, api, model, day: '2026-11-24', fetch: f })
  assert.ok(r2.announced)
  assert.equal(api.calls.filter((c) => c.nsid === 'com.atproto.repo.putRecord').length, 1)
  assert.equal(api.posts.length, 1)
})

test('review 6-7: figures must match whole numbers; blockquotes, other quote marks and one-word quotes are refused', () => {
  const t = normalize(article.text + ' Published in 2026.')
  assert.equal(numberIn('14', t), false)
  assert.equal(numberIn('20', t), false)
  assert.equal(numberIn('140', t), true)
  const bad = (what) => checkDraft(draft({ sections: { 'What it says': `${what} “We found out from the newspaper.”` } }), article).problems
  assert.ok(bad('Rents rose 14 percent.').includes('figure not found in any source: 14'))
  assert.ok(bad('\n> Tenants were thrilled.\n').some((p) => p.startsWith('no blockquotes')))
  assert.ok(bad('They said ‘never asked.’').some((p) => p.startsWith('no quote marks')))
  assert.ok(bad('A “private” deal.').some((p) => p.startsWith('a quotation must be at least two words')))
  assert.ok(bad('[report](/\\evil.example/x)').includes('no links'))
  assert.ok(checkQuestion({ framing: 'Rents rose 14 percent, says the report.', question: 'Who owns yours?' }, article).problems.includes('figure not found in any source: 14'))
})

test('review 8, 14: pages refuse /\\host links, and $ patterns in third-party text are inert', () => {
  const html = entryHtml({ title: 'T', date: '2026-11-24', sources: [], body: '[x](/\\evil.example/a) \u0001<1>\u0001' }, { uri: 'at://x', origin: 'https://autonomist.jason-edelman.org' })
  assert.ok(!html.includes('href="/\\evil.example/a"'))
  const shell = '<head>HEAD</head><title>{{journal:title}}</title><main><!--journal:content--></main>'
  const out = fillShell(shell, { title: 'Evil $` Outlet', description: '', content: 'body $& end' })
  assert.equal((out.match(/HEAD/g) || []).length, 1)
  assert.ok(out.includes('body $&amp;') || out.includes('body $& end'))
})

test('review 9: a redirect to a closed site is never read, and a robots.txt server error counts as closed', async () => {
  const seen = []
  const f = async (url, opts = {}) => {
    seen.push(String(url))
    if (String(url) === 'https://short.example/robots.txt') return new Response('', { status: 404 })
    if (String(url) === 'https://closed.example/robots.txt') return new Response('User-agent: *\nDisallow: /')
    if (String(url) === 'https://short.example/x') return new Response('', { status: 301, headers: { location: 'https://closed.example/story' } })
    if (String(url) === 'https://down.example/robots.txt') return new Response('', { status: 503 })
    return new Response('<p>body</p>', { headers: { 'content-type': 'text/html' } })
  }
  await assert.rejects(fetchReadable('https://short.example/x', { fetch: f }), /closed/)
  assert.ok(!seen.includes('https://closed.example/story'))
  await assert.rejects(fetchReadable('https://down.example/a', { fetch: f }), /503/)
  assert.ok(!seen.includes('https://down.example/a'))
})

test('review 10-11: replies between other people are not answered; replies past the first page are', async () => {
  const kv = memoryKV()
  await kv.put('bot:notif:seen', '2026-11-24T00:00:00.000Z')
  const pages = [
    { notifications: [note(3, 'reply', human, 'at://did:plc:other/app.bsky.feed.post/9')], cursor: 'p2' },
    { notifications: [note(2, 'reply', human)] },
  ]
  const api = fakeApi()
  const real = api.call
  api.call = async (m, nsid, o) => (nsid === 'app.bsky.notification.listNotifications' ? (o.params.cursor ? pages[1] : pages[0]) : real(m, nsid, o))
  const model = { structured: async () => ({ data: { action: 'reply', text: 'Who decides that?', why: '' } }) }
  await runReplies({ env: {}, kv, api, model, day: '2026-11-24' })
  assert.equal(api.posts.length, 1)
  assert.equal(api.posts[0].reply.parent.uri, 'at://did:plc:u/app.bsky.feed.post/2')
})

test('review 13, 15: candidate metadata stays under 1,000 bytes in any script; headlines keep their apostrophes', () => {
  const m = candidateMetadata({ url: 'https://ja.example/a', title: '住'.repeat(140), description: '宅'.repeat(220), handle: 'h.example', post: 'at://x', at: new Date().toISOString() })
  assert.ok(new TextEncoder().encode(JSON.stringify(m)).length <= 1000)
  const a = readArticle(`<meta property="og:title" content="Workers' co-op buys the mill"><meta property="og:site_name" content="The Mill's Paper">`, 'https://m.example/a')
  assert.equal(a.title, "Workers' co-op buys the mill")
  assert.equal(a.siteName, "The Mill's Paper")
})
