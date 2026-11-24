// Getting to know the people who opt in (worker/bot/acquaint.js), the versioned pinned post, and /known/. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryKV } from './helpers.mjs'
import { readAccount, cleanAcquaintance, runAcquaint, acquaintanceNote, resolvePds, ACQUAINTANCE } from '../worker/bot/acquaint.js'
import { ensurePinned, refreshOptins, runOptin, syncFollows, relevance, PINNED_TEXT, PINNED_VERSION } from '../worker/bot/optin.js'
import { knownHtml, HANDLE } from '../worker/known-pages.js'
import { noteLink, logHtml } from '../worker/thinking-pages.js'
import { graphemes } from '../worker/bot/text.js'

const ME = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'
const ANA = 'did:plc:bbbbbbbbbbbbbbbbbbbbbbbb'
const BO = 'did:plc:cccccccccccccccccccccccc'

const pdsFetch = async (url) => {
  const u = String(url)
  if (u === `https://plc.directory/${ANA}`) return Response.json({ service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.ana.example' }] })
  if (u.startsWith('https://pds.ana.example/xrpc/com.atproto.repo.listRecords')) return Response.json({ records: [{ value: { subject: { uri: 'at://did:plc:x/app.bsky.feed.post/1' } } }, { value: { subject: { uri: 'at://did:plc:x/app.bsky.feed.post/2' } } }] })
  return new Response('', { status: 404 })
}

function fakeApi({ likes = {}, records = [] } = {}) {
  const store = new Map(records.map((r) => [r.uri.split('/').pop(), r]))
  const api = {
    calls: [], posts: [], logs: [],
    session: async () => ({ did: ME }),
    pub: async (nsid, p) => {
      if (nsid === 'app.bsky.actor.getProfile') return { did: p.actor, handle: 'ana.example', displayName: 'Ana Reyes', description: 'Tenant organizer in Norfolk.' }
      if (nsid === 'app.bsky.feed.getAuthorFeed') return { feed: [
        { post: { author: { did: p.actor }, record: { text: 'Our building got a 20% rent hike notice today. Meeting Thursday.' } } },
        { post: { author: { did: 'did:plc:other' }, record: { text: 'Land trusts keep homes affordable for good.' } }, reason: { $type: 'app.bsky.feed.defs#reasonRepost' } },
      ] }
      if (nsid === 'app.bsky.feed.getPosts') return { posts: [].concat(p.uris).map((u) => ({ uri: u, record: { text: `liked post ${u.slice(-1)} about bus routes` } })) }
      if (nsid === 'app.bsky.feed.getLikes') return likes[p.uri] || { likes: [] }
      throw new Error(`unexpected ${nsid}`)
    },
    call: async (method, nsid, opts) => {
      api.calls.push({ nsid, opts })
      if (nsid === 'com.atproto.repo.listRecords' && opts.params.collection === ACQUAINTANCE) return { records: [...store.values()] }
      if (nsid === 'com.atproto.repo.putRecord' && opts.body.collection === ACQUAINTANCE) { const uri = `at://${ME}/${ACQUAINTANCE}/${opts.body.rkey}`; store.set(opts.body.rkey, { uri, value: opts.body.record }); return { uri } }
      if (nsid === 'com.atproto.repo.deleteRecord') { store.delete(opts.body.rkey); return {} }
      if (nsid === 'com.atproto.repo.createRecord') { api.logs.push(opts.body.record); return { uri: `at://${ME}/log/${api.logs.length}` } }
      if (nsid === 'com.atproto.repo.getRecord') return { cid: 'pc', value: { $type: 'app.bsky.actor.profile', pinnedPost: { uri: `at://${ME}/app.bsky.feed.post/old`, cid: 'oc' }, labels: { values: [{ val: 'bot' }] } } }
      return {}
    },
    post: async (p) => { api.posts.push(p); return { uri: `at://${ME}/app.bsky.feed.post/new${api.posts.length}`, cid: `n${api.posts.length}` } },
    store,
  }
  return api
}

test('acquaint: reads the profile, own posts, reposts, and likes from the person\'s own repository', async () => {
  assert.equal(await resolvePds(ANA, pdsFetch), 'https://pds.ana.example')
  await assert.rejects(resolvePds('did:example:x', pdsFetch), /unsupported/)
  const acc = await readAccount({ did: ANA, api: fakeApi(), fetch: pdsFetch })
  assert.equal(acc.bio, 'Tenant organizer in Norfolk.')
  assert.deepEqual(acc.posts, ['Our building got a 20% rent hike notice today. Meeting Thursday.'])
  assert.deepEqual(acc.reposts, ['Land trusts keep homes affordable for good.'])
  assert.equal(acc.likes.length, 2)
  // a repository it can't reach leaves likes empty, not the read failed
  const noLikes = await readAccount({ did: ANA, api: fakeApi(), fetch: async () => new Response('', { status: 500 }) })
  assert.deepEqual(noLikes.likes, [])
})

test('acquaint: notes are about what someone posts about, never who they are', () => {
  const ok = cleanAcquaintance('You post about rent increases in your building and organizing your neighbors, and you share work on land trusts.', ['rent increases', 'Tenant Organizing', 'x'])
  assert.equal(ok.withheld, false)
  assert.deepEqual(ok.topics, ['rent increases', 'tenant organizing'])
  for (const bad of [
    'Ana, you post about rent.', // their name
    'You post about rent, as ana.example.', // a handle
    'You post about a 20 percent rent hike.', // a figure
    'You call it “a hike”.', // a quotation
    'You post about rent at https://x.example.', // a link
    'You post as a queer tenant organizer.', // identity
    'You seem to be a socialist.', // an ideology label
    'You post about your therapy and rent.', // health
  ]) assert.equal(cleanAcquaintance(bad, [], { name: 'Ana Reyes', handle: 'ana.example' }).withheld, true, bad)
  assert.equal(cleanAcquaintance("You post about your building's repairs.", []).withheld, false)
  assert.deepEqual(cleanAcquaintance('You post about rent.', ['muslim housing', 'transit']).topics, ['transit'])
})

test('acquaint: only those who liked the current post are read; notes are written, kept fresh, and deleted on unlike', async () => {
  const kv = memoryKV()
  const now = Date.parse('2026-11-24T01:00:00Z')
  await kv.put('bot:optin', JSON.stringify({ at: now, complete: true, people: [
    { did: ANA, handle: 'ana.example', read: true },
    { did: BO, handle: 'bo.example', read: false }, // liked the old post: questions only
    { did: 'did:plc:dddddddddddddddddddddddd', handle: 'b.example', read: true, bot: true },
  ] }))
  const gone = 'did:plc:eeeeeeeeeeeeeeeeeeeeeeee'
  const api = fakeApi({ records: [{ uri: `at://${ME}/${ACQUAINTANCE}/${gone}`, value: { subject: gone, note: 'x', updatedAt: '2026-11-23T00:00:00Z' } }] })
  await kv.put(`acq:${gone}`, '{"note":"x"}')
  const prompts = []
  const model = { structured: async ({ user }) => { prompts.push(user); return { data: { note: 'You post about a rent increase in your building and a tenants meeting, and you share posts on land trusts and bus routes.', topics: ['rent increases', 'land trusts'] } } } }
  const r = await runAcquaint({ env: {}, kv, api, model, fetch: pdsFetch, now })
  assert.deepEqual([r.wrote, r.forgot], [1, 1])
  assert.ok(!api.store.has(gone) && (await kv.get(`acq:${gone}`)) === null)
  const rec = api.store.get(ANA).value
  assert.equal(rec.subject, ANA)
  assert.deepEqual(rec.read, { posts: 1, reposts: 1, likes: 2 })
  assert.ok(prompts[0].includes('POSTS BY OTHERS THEY LIKED') && !prompts.some((p) => p.includes('bo.example')))
  assert.deepEqual(api.logs.map((l) => l.kind).sort(), ['acquainted', 'forgot'])
  assert.ok(!JSON.stringify(api.logs).includes(gone)) // the deletion log doesn't name who unliked
  // the note is read back as context
  assert.ok((await acquaintanceNote(kv, ANA, 'ana.example')).includes('land trusts'))
  // an hour later: fresh notes aren't rewritten
  assert.equal((await runAcquaint({ env: {}, kv, api, model, fetch: pdsFetch, now: now + 3600e3 })).wrote, 0)
  // an incomplete or stale list of likes never deletes a note
  await kv.put('bot:optin', JSON.stringify({ at: now, complete: false, people: [] }))
  assert.equal((await runAcquaint({ env: {}, kv, api, model, fetch: pdsFetch, now })).forgot, 0)
  await kv.put('bot:optin', JSON.stringify({ at: now - 5 * 3600e3, complete: true, people: [] }))
  assert.equal((await runAcquaint({ env: {}, kv, api, model, fetch: pdsFetch, now })).forgot, 0)
  assert.ok(api.store.has(ANA))
})

test('acquaint: a note that fails twice keeps only its topics', async () => {
  const kv = memoryKV()
  await kv.put('bot:optin', JSON.stringify({ at: Date.now(), complete: true, people: [{ did: ANA, handle: 'ana.example', read: true }] }))
  const api = fakeApi()
  const model = { structured: async () => ({ data: { note: 'Ana is a tenant organizer.', topics: ['tenant organizing'] } }) }
  await runAcquaint({ env: {}, kv, api, model, fetch: pdsFetch })
  const rec = api.store.get(ANA).value
  assert.equal(rec.note, '')
  assert.deepEqual(rec.topics, ['tenant organizing'])
  assert.ok(rec.withheld)
})

test('pinned post: a new version is pinned in place of the old, which is kept; old likers are questions-only', async () => {
  assert.ok(graphemes(PINNED_TEXT) <= 300 && /read your profile, posts, reposts and likes/.test(PINNED_TEXT))
  const kv = memoryKV()
  await kv.put('bot:pinned', JSON.stringify({ uri: `at://${ME}/app.bsky.feed.post/old`, cid: 'oc' }))
  const api = fakeApi({ likes: {
    [`at://${ME}/app.bsky.feed.post/new1`]: { likes: [{ actor: { did: ANA, handle: 'ana.example' } }] },
    [`at://${ME}/app.bsky.feed.post/old`]: { likes: [{ actor: { did: ANA, handle: 'ana.example' } }, { actor: { did: BO, handle: 'bo.example' } }] },
  } })
  const r = await ensurePinned({ kv, api })
  assert.equal(r.replaced, `at://${ME}/app.bsky.feed.post/old`)
  assert.equal(api.posts[0].text, PINNED_TEXT)
  const put = api.calls.find((c) => c.nsid === 'com.atproto.repo.putRecord')
  assert.equal(put.opts.body.record.pinnedPost.uri, `at://${ME}/app.bsky.feed.post/new1`)
  assert.deepEqual(put.opts.body.record.labels, { values: [{ val: 'bot' }] })
  assert.equal(put.opts.body.swapRecord, 'pc')
  assert.ok(!api.calls.some((c) => c.nsid === 'com.atproto.repo.deleteRecord')) // the old post stays up
  assert.equal((await kv.get('bot:pinned', 'json')).version, PINNED_VERSION)
  assert.deepEqual((await kv.get('bot:pinned:previous', 'json')).map((p) => p.uri), [`at://${ME}/app.bsky.feed.post/old`])
  assert.deepEqual(await ensurePinned({ kv, api }), { pinned: 'known' })
  assert.equal(api.posts.length, 1)
  const o = await refreshOptins({ kv, api, me: ME })
  assert.deepEqual(o, { optedIn: 2, read: 1 })
  const list = await kv.get('bot:optin', 'json')
  assert.equal(list.complete, true)
  assert.deepEqual(list.people.map((p) => [p.handle, p.read]).sort(), [['ana.example', true], ['bo.example', false]])
})

test('opt-in: a question to someone with a note reads the note first', async () => {
  const kv = memoryKV()
  await kv.put('bot:optin', JSON.stringify({ at: Date.now(), complete: true, people: [{ did: ANA, handle: 'ana.example', read: true }] }))
  await kv.put(`acq:${ANA}`, JSON.stringify({ note: 'You post about your building.', topics: ['repairs'] }))
  const api = fakeApi()
  api.pub = async () => ({ feed: [{ post: { uri: 'at://ana/p/1', cid: 'c', author: { did: ANA }, indexedAt: new Date().toISOString(), record: { text: 'The landlord ignored the leak again.' } } }] })
  let prompt = ''
  const model = { structured: async ({ user }) => { prompt = user; return { data: { action: 'skip', text: '', why: 'n', reflection: '', themes: [] } } } }
  await runOptin({ env: {}, kv, api, model, day: '2026-11-24', refresh: false })
  assert.ok(prompt.includes('<acquaintance>') && prompt.includes('You post about your building.'))
})

test('/known/: escaped, honest when there is no note, linked from the run journal', () => {
  assert.ok(HANDLE.test('ana.example') && !HANDLE.test('ana') && !HANDLE.test('../x'))
  const html = knownHtml({ note: 'You post <b>about</b> rent.', topics: ['rent'], read: { posts: 3, reposts: 1, likes: 2 }, updatedAt: '2026-11-24T01:00:00Z' }, { name: '@ana.example', uri: `at://${ME}/${ACQUAINTANCE}/${ANA}` })
  assert.ok(html.includes('You post &lt;b&gt;about&lt;/b&gt; rent.') && html.includes('3 of its posts') && html.includes('deletes it'))
  assert.ok(knownHtml(null, { name: '@bo.example' }).includes('keeps no note on @bo.example'))
  assert.equal(noteLink(`at://${ME}/${ACQUAINTANCE}/${ANA}`), `/known/${ANA}/`)
  assert.equal(noteLink(`at://${ME}/${ACQUAINTANCE}/../x`), null)
  const log = logHtml([{ value: { kind: 'acquainted', context: 'opt-in', result: `at://${ME}/${ACQUAINTANCE}/${ANA}`, createdAt: '2026-11-24T01:00:00Z' } }])
  assert.ok(log.includes('Got to know an account that opted in') && log.includes(`href="/known/${ANA}/"`) && !log.includes('No reflection'))
})

test('language: an opt-in question answers a Japanese post in Japanese, tagged ja', async () => {
  const kv = memoryKV()
  await kv.put('bot:optin', JSON.stringify({ at: Date.now(), complete: true, people: [{ did: ANA, handle: 'chiitan.example', read: false }] }))
  const api = fakeApi()
  api.pub = async () => ({ feed: [{ post: { uri: 'at://ana/p/2', cid: 'c', author: { did: ANA }, indexedAt: new Date().toISOString(), record: { text: '大家さんがまた家賃を上げた', langs: ['ja'] } } }] })
  let prompt = ''
  const model = { structured: async ({ user }) => { prompt = user; return { data: { action: 'reply', text: 'その建物には、ほかに何世帯が住んでいますか？', why: '', lang: 'ja', reflection: '', themes: [] } } } }
  await runOptin({ env: {}, kv, api, model, day: '2026-11-24', refresh: false })
  assert.ok(prompt.includes('(language tags: ja)'))
  assert.equal(api.posts[0].lang, 'ja')
})

test('follows: the opted-in are followed and the unliked unfollowed, only from a complete, fresh list; no bots', async () => {
  const kv = memoryKV()
  const now = Date.now()
  const follows = new Map([[BO, '3old'], ['did:plc:ffffffffffffffffffffffff', '3gone']])
  const api = {
    calls: [],
    call: async (m, nsid, o) => {
      api.calls.push({ nsid, o })
      if (nsid === 'com.atproto.repo.listRecords') return { records: [...follows].map(([did, rkey]) => ({ uri: `at://${ME}/app.bsky.graph.follow/${rkey}`, value: { subject: did } })) }
      if (nsid === 'com.atproto.repo.createRecord') { follows.set(o.body.record.subject, 'new'); return {} }
      if (nsid === 'com.atproto.repo.deleteRecord') { for (const [d, r] of follows) if (r === o.body.rkey) follows.delete(d); return {} }
      return {}
    },
  }
  await kv.put('bot:optin', JSON.stringify({ at: now, complete: true, people: [{ did: ANA, read: true }, { did: BO, read: false }, { did: 'did:plc:dddddddddddddddddddddddd', bot: true }] }))
  assert.deepEqual(await syncFollows({ kv, api, me: ME, now }), { following: 2, followed: 1, unfollowed: 1 })
  assert.deepEqual([...follows.keys()].sort(), [ANA, BO].sort())
  const created = api.calls.find((c) => c.nsid === 'com.atproto.repo.createRecord').o.body
  assert.equal(created.collection, 'app.bsky.graph.follow')
  // an incomplete or stale list changes nothing
  await kv.put('bot:optin', JSON.stringify({ at: now, complete: false, people: [] }))
  assert.ok((await syncFollows({ kv, api, me: ME, now })).skipped)
  await kv.put('bot:optin', JSON.stringify({ at: now - 3 * 3600e3, complete: true, people: [] }))
  assert.ok((await syncFollows({ kv, api, me: ME, now })).skipped)
  assert.equal(follows.size, 2)
})

test('opt-in feed: posts come from the home feed, ranked by relevance; new posts count toward the note', async () => {
  const kv = memoryKV()
  const now = new Date('2026-11-24T03:00:00Z')
  await kv.put('bot:optin', JSON.stringify({ at: now.getTime(), complete: true, people: [{ did: ANA, handle: 'ana.example', read: true }, { did: BO, handle: 'bo.example', read: false }] }))
  await kv.put(`acq:${BO}`, JSON.stringify({ note: 'You post about public transit.', topics: ['public transit'] }))
  const at = (min) => new Date(now.getTime() - min * 60e3).toISOString()
  const item = (did, n, text, min, extra = {}) => ({ post: { uri: `at://${did}/app.bsky.feed.post/${n}`, cid: `c${n}`, author: { did }, indexedAt: at(min), record: { text, ...(extra.reply ? { reply: extra.reply } : {}) } }, ...(extra.reason ? { reason: extra.reason } : {}) })
  const feed = [
    item(ANA, 1, 'Made soup tonight.', 5),
    item(BO, 2, 'The bus route to the clinic got cut again. Who decides public transit here?', 10),
    item(ANA, 3, 'Replying to a friend', 12, { reply: { root: { uri: 'x' }, parent: { uri: 'x' } } }),
    item('did:plc:stranger', 4, 'Rent is up for everyone on my block.', 15),
    item(ANA, 5, 'A repost of rent news', 20, { reason: { $type: 'app.bsky.feed.defs#reasonRepost' } }),
    item(BO, 6, 'Old post about tenants', 300),
  ]
  const api = fakeApi()
  api.call = async (m, nsid, o) => (nsid === 'app.bsky.feed.getTimeline' ? { feed } : nsid === 'com.atproto.repo.createRecord' ? { uri: 'at://log' } : {})
  const weighed = []
  const model = { structured: async ({ user }) => { weighed.push(user); return { data: { action: weighed.length === 1 ? 'reply' : 'skip', text: 'Who rides that route with you?', why: '', lang: 'en', reflection: '', themes: [] } } } }
  const r = await runOptin({ env: { BOT_OPTIN_PER_RUN: '1' }, kv, api, model, day: '2026-11-24', now })
  assert.equal(r.source, 'home feed')
  assert.equal(r.candidates, 2) // one per person: Ana's soup, Bo's bus post; not the reply, the stranger, the repost or the old post
  assert.ok(weighed[0].includes('bus route')) // the post that touches its subjects and Bo's note goes first
  assert.equal(api.posts[0].reply.parent.uri, `at://${BO}/app.bsky.feed.post/2`)
  assert.equal(await kv.get('bot:timeline:seen'), at(5))
  // their own new posts since the last look count toward rewriting their note; reposts don't
  assert.equal(await kv.get(`acqnew:${ANA}`), '2')
  assert.equal(relevance('rent and the landlord', []), 2)
  assert.equal(relevance('the bus to the clinic', ['public transit']), 0)
  assert.equal(relevance('public transit cuts', ['public transit']), 6)
})

test('acquaint: a note is rewritten after a day once its person has posted a lot, else weekly', async () => {
  const kv = memoryKV()
  const now = Date.parse('2026-11-26T03:00:00Z')
  await kv.put('bot:optin', JSON.stringify({ at: now, complete: true, people: [{ did: ANA, handle: 'ana.example', read: true }] }))
  const api = fakeApi({ records: [{ uri: `at://${ME}/${ACQUAINTANCE}/${ANA}`, value: { subject: ANA, note: 'old', createdAt: '2026-11-24T02:00:00Z', updatedAt: '2026-11-24T02:00:00Z' } }] })
  const model = { structured: async () => ({ data: { note: 'You post about rent and your neighbors.', topics: ['rent'] } }) }
  assert.equal((await runAcquaint({ env: {}, kv, api, model, fetch: pdsFetch, now })).wrote, 0)
  await kv.put(`acqnew:${ANA}`, '25')
  assert.equal((await runAcquaint({ env: {}, kv, api, model, fetch: pdsFetch, now })).wrote, 1)
  assert.equal(await kv.get(`acqnew:${ANA}`), null)
  assert.equal(api.store.get(ANA).value.createdAt, '2026-11-24T02:00:00Z')
})
