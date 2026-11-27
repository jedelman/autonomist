// Quote-posts (Jason, 2026-11-25: "let's have autonomist prefer quote-posts"; his pick: publishers' own posts and
// opted-in people's). No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { strictKV, memoryKV } from './helpers.mjs'
import { isPublisher, sweep, quoteKey, candidates } from '../worker/bot/sources.js'
import { runQuestion, quotable } from '../worker/bot/questions.js'

test('a publisher is an account whose handle is the link\'s site, or one of its names; never a bsky.social handle', () => {
  assert.equal(isPublisher('theguardian.com', 'https://www.theguardian.com/world/x'), true)
  assert.equal(isPublisher('bsky.example.com', 'https://example.com/a'), true)
  assert.equal(isPublisher('example.com', 'https://news.example.com/a'), true)
  assert.equal(isPublisher('example.com', 'https://notexample.com/a'), false)
  assert.equal(isPublisher('news.org', 'https://evilnews.org/a'), false)
  assert.equal(isPublisher('someone.bsky.social', 'https://someone.bsky.social/x'), false)
  assert.equal(isPublisher('', 'https://example.com/'), false)
})

const NOW = Date.parse('2026-11-25T16:00:00Z')
const share = (did, handle, url, rkey, title = 'A story') => ({ post: { uri: `at://${did}/app.bsky.feed.post/${rkey}`, cid: `cid-${rkey}`, author: { did, handle }, indexedAt: new Date(NOW - 60e3).toISOString(), embed: { external: { uri: url, title } }, record: {} } })

test('sweep: one write per link a run, however many share it; quotable posts kept for publishers and the opted-in only', async () => {
  const kv = strictKV()
  const PUB = 'did:plc:publisher', OPT = 'did:plc:optedin', A = 'did:plc:stranger1', B = 'did:plc:stranger2'
  await kv.put('bot:follows', JSON.stringify({ at: NOW, follows: [{ did: OPT }, { did: A }, { did: PUB }, { did: B }] }))
  await kv.put('bot:optin', JSON.stringify({ at: NOW, complete: true, people: [{ did: OPT, handle: 'reader.example' }] }))
  kv.clock.t += 60_000
  const feeds = {
    [PUB]: [share(PUB, 'news.example', 'https://news.example/story', 'p1')],
    [OPT]: [share(OPT, 'reader.example', 'https://news.example/story', 'o1'), share(OPT, 'reader.example', 'https://blog.example/post', 'o2')],
    [A]: [share(A, 'stranger1.bsky.social', 'https://news.example/story', 'a1'), share(A, 'stranger1.bsky.social', 'https://only-strangers.example/x', 'a2')],
    [B]: [share(B, 'stranger2.bsky.social', 'https://news.example/story', 'b1')],
  }
  const api = { pub: async (nsid, q) => ({ feed: feeds[q.actor] || [] }) }
  const r = await sweep(api, kv, 4, NOW)
  assert.ok(!r.failed, JSON.stringify(r)) // strictKV throws on a second write to a key
  const c = (await candidates(kv)).find((x) => x.url === 'https://news.example/story')
  assert.equal(c.sharers, 4)
  // the publisher's own post wins over an opted-in person's; strangers are never kept
  assert.deepEqual(await kv.get(await quoteKey('https://news.example/story'), 'json').then((q) => [q.kind, q.uri]), ['publisher', `at://${PUB}/app.bsky.feed.post/p1`])
  assert.equal((await kv.get(await quoteKey('https://blog.example/post'), 'json')).kind, 'opted-in')
  assert.equal(await kv.get(await quoteKey('https://only-strangers.example/x')), null)
})

const STORY_CID = `bafkreiland${'z'.repeat(48)}`
const ARTICLE = { url: 'https://c.example/land', title: 'Farmland bought by investment funds', outlet: 'c.example', gist: 'g', quotes: [], text: 'Investment funds bought more farmland this year. The state has seen it before.' }
async function day(kv) {
  const story = (label, a) => ({ label, sharers: 3, articles: [a], ...(a === ARTICLE ? { image: { blob: { $type: 'blob', ref: { $link: STORY_CID }, mimeType: 'image/jpeg', size: 9 }, article: ARTICLE.url } } : {}) })
  await kv.put('digest:day:2026-11-25', JSON.stringify({ block: '', stories: [story('Rent freezes', { ...ARTICLE, url: 'https://a.example/rent' }), story('Farmland sales', ARTICLE), story('A tenant co-op', { ...ARTICLE, url: 'https://d.example/coop' })] }))
}
const answer = () => ({ framing: 'Investment funds bought more farmland this year, the reporting says.', question: 'Who owns the land around where you live?', reflection: '', themes: [] })

test('feed questions quote a publisher\'s or an opted-in person\'s post of the story, rechecking the opt-in; else a card', async () => {
  for (const [kind, optedNow, expectQuote] of [['publisher', false, true], ['opted-in', true, true], ['opted-in', false, false]]) {
    const kv = memoryKV()
    await day(kv)
    await kv.put(await quoteKey(ARTICLE.url), JSON.stringify({ uri: 'at://did:plc:x/app.bsky.feed.post/q1', cid: 'cidq', did: 'did:plc:x', handle: 'x.example', kind }))
    await kv.put('bot:optin', JSON.stringify({ at: NOW, complete: true, people: optedNow ? [{ did: 'did:plc:x', handle: 'x.example' }] : [] }))
    const posts = []
    const api = { session: async () => ({ did: 'did:plc:me' }), call: async () => ({ uri: 'at://log' }), post: async (p) => { posts.push(p); return { uri: 'at://q/1', cid: 'c' } } }
    const r = await runQuestion({ env: {}, kv, api, model: { structured: async () => ({ data: answer() }) }, day: '2026-11-25', now: new Date('2026-11-25T16:07:00Z') })
    assert.equal(r.story, 'Farmland sales', JSON.stringify(r))
    if (expectQuote) {
      assert.deepEqual(posts[0].quote, { uri: 'at://did:plc:x/app.bsky.feed.post/q1', cid: 'cidq', kind, url: ARTICLE.url }, kind)
      assert.equal(posts[0].card, undefined)
      assert.equal(r.quoted, kind)
    } else {
      assert.equal(posts[0].quote, undefined, 'someone who unliked is never quoted')
      assert.equal(posts[0].card.uri, ARTICLE.url)
      // the card carries the story's image, the one the digest stored for this very article
      assert.equal(posts[0].card.thumb.ref.$link, STORY_CID)
    }
    // the slot's claim and the post's address are separate keys
    assert.equal(await kv.get('question:2026-11-25:16'), 'pending')
    assert.equal(await kv.get('question:2026-11-25:16:post'), 'at://q/1')
  }
})

test('quotable: the first article with a usable post, most-shared first', async () => {
  const kv = memoryKV()
  await kv.put(await quoteKey('https://b.example/2'), JSON.stringify({ uri: 'at://p/2', cid: 'c2', kind: 'publisher' }))
  assert.deepEqual(await quotable(kv, [{ url: 'https://a.example/1' }, { url: 'https://b.example/2' }]), { uri: 'at://p/2', cid: 'c2', kind: 'publisher', url: 'https://b.example/2' })
  assert.equal(await quotable(kv, [{ url: 'https://a.example/1' }]), null)
})

test('the post carries one article, chosen first, and the framing is held to that article alone', async () => {
  const kv = memoryKV()
  const other = { url: 'https://e.example/wages', title: 'Garment wages rise short of demands', outlet: 'e.example', gist: 'g', quotes: [], text: 'The wage board raised the minimum wage 36 percent.' }
  const tyee = { url: 'https://f.example/leader', title: 'Labour picks a leader', outlet: 'f.example', gist: 'g', quotes: [], text: 'The party will pick its next leader in spring, after 12,000 members voted.' }
  await kv.put('digest:day:2026-11-25', JSON.stringify({ block: '', stories: [{ label: 'Lead', sharers: 9, articles: [{ ...ARTICLE, url: 'https://a.example/x' }] }, { label: 'Labor', sharers: 4, articles: [tyee, other] }, { label: 'Third', sharers: 2, articles: [{ ...ARTICLE, url: 'https://d.example/y' }] }] }))
  // only the second article has a quotable post: it becomes the article the post carries
  await kv.put(await quoteKey(other.url), JSON.stringify({ uri: 'at://did:plc:pub/app.bsky.feed.post/w', cid: 'cw', did: 'did:plc:pub', handle: 'e.example', kind: 'publisher' }))
  const posts = [], prompts = []
  const api = { session: async () => ({ did: 'did:plc:me' }), call: async () => ({ uri: 'at://log' }), post: async (p) => { posts.push(p); return { uri: 'at://q/2', cid: 'c' } } }
  const drafts = [
    // a figure from the other article is refused: the framing is held to the one the post carries
    { framing: 'f.example reports the party will pick its next leader after 12,000 members voted.', question: 'Who gets a say where you work?', reflection: '', themes: [] },
    { framing: 'e.example reports the wage board raised the minimum wage 36 percent.', question: 'Who gets a say where you work?', reflection: '', themes: [] },
  ]
  const r = await runQuestion({ env: {}, kv, api, model: { structured: async ({ user }) => { prompts.push(user); return { data: drafts.shift() } } }, day: '2026-11-25', now: new Date('2026-11-25T16:07:00Z') })
  assert.equal(r.story, 'Labor', JSON.stringify(r))
  assert.ok(prompts[0].includes('THE ARTICLE THIS POST CARRIES (as a quoted post that shared it): e.example: Garment wages rise short of demands'))
  assert.equal(prompts.length, 2)
  assert.equal(posts[0].quote.url, other.url)
  assert.ok(posts[0].text.startsWith('e.example reports'))
})

