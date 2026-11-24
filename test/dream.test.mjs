// Dreaming, the fact-check fixes (republished sources, rechecks), and the memory fold's figures. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryKV } from './helpers.mjs'
import { runDream, dreamProblems, DREAM } from '../worker/bot/dream.js'
import { foldMemory, memoryProblems, LOG, MEMORY } from '../worker/bot/log.js'
import { factCheck, CHECKER_VERSION } from '../worker/bot/factcheck.js'
import { recheckEntries, COLLECTION } from '../worker/bot/journal.js'
import { dreamsHtml } from '../worker/thinking-pages.js'
import { entryHtml } from '../worker/journal-pages.js'

const ME = 'did:plc:aaaaaaaaaaaaaaaaaaaaaaaa'

function repo(records = {}) {
  const store = Object.fromEntries(Object.entries(records).map(([c, rs]) => [c, [...rs]]))
  const api = {
    calls: [], logs: [], puts: [],
    session: async () => ({ did: ME }),
    call: async (m, nsid, o) => {
      api.calls.push({ nsid, o })
      if (nsid === 'com.atproto.repo.listRecords') return { records: [...(store[o.params.collection] || [])].sort((a, b) => String(b.value.createdAt).localeCompare(String(a.value.createdAt))) }
      if (nsid === 'com.atproto.repo.createRecord') {
        const uri = `at://${ME}/${o.body.collection}/${(store[o.body.collection] || []).length + 1}`
        ;(store[o.body.collection] ||= []).push({ uri, value: o.body.record })
        if (o.body.collection === LOG) api.logs.push(o.body.record)
        return { uri }
      }
      if (nsid === 'com.atproto.repo.putRecord') { api.puts.push(o.body); return { uri: `at://${ME}/${o.body.collection}/${o.body.rkey}` } }
      return {}
    },
    store,
  }
  return api
}

const log = (n, kind, context, reflection, at) => ({ uri: `at://${ME}/${LOG}/${n}`, value: { kind, context, reflection, themes: ['rent increases'], createdAt: at } })
const goodDream = { title: 'What keeps coming back', body: 'People keep asking how a co-op pays back a member who moves. '.repeat(10), questions: ['Who on your block has moved out this year, and why?'], themes: ['member exits'] }

test('dream: once a day, from its hour, written from everything since the last dream, and folded into the memory', async () => {
  const kv = memoryKV()
  const api = repo({ [LOG]: [log(1, 'replied', 'reply', 'People asked about exits.', '2026-11-24T02:00:00Z'), log(2, 'listened', 'discussion', 'They talked rent.', '2026-11-24T03:00:00Z')] })
  const prompts = []
  const model = { structured: async ({ user, schema }) => { prompts.push(user); return { data: schema.properties.memory ? { memory: '## Themes people raise\n- exits' } : goodDream } } }
  const env = { BOT_DREAM_HOUR_UTC: '7' }
  assert.equal((await runDream({ env, kv, api, model, day: '2026-11-24', now: new Date('2026-11-24T06:10:00Z') })).skipped, 'not yet today')
  const r = await runDream({ env, kv, api, model, day: '2026-11-24', now: new Date('2026-11-24T07:10:00Z') })
  assert.deepEqual(r.read, { logs: 2, entries: 0, since: '2026-11-22T07:10:00.000Z' })
  assert.ok(prompts[0].includes('replied (reply): 1') && prompts[0].includes('People asked about exits.') && prompts[0].includes('(this is your first)'))
  const rec = api.store[DREAM][0].value
  assert.equal(rec.title, 'What keeps coming back')
  assert.equal(rec.through, '2026-11-24T03:00:00Z')
  assert.equal(api.logs.at(-1).kind, 'dreamed')
  assert.equal((await runDream({ env, kv, api, model, day: '2026-11-24', now: new Date('2026-11-24T08:10:00Z') })).skipped, 'dreamed today')
  // the memory fold takes the dream in, once
  await foldMemory({ kv, api, model })
  assert.ok(prompts.at(-1).includes('YOUR LATEST DREAM') && prompts.at(-1).includes('What keeps coming back'))
  assert.equal(await kv.get('bot:dream:unfolded'), null)
  // the next day: only what came after the last dream
  api.store[LOG].push(log(9, 'asked', 'feed', 'A question about repairs.', '2026-11-25T01:00:00Z'))
  await runDream({ env, kv, api, model, day: '2026-11-25', now: new Date('2026-11-25T07:10:00Z') })
  assert.ok(prompts.at(-1).includes('A question about repairs.') && !prompts.at(-1).includes('People asked about exits.') && prompts.at(-1).includes('YOUR LAST DREAM\nWhat keeps coming back'))
})

test('dream: nothing new means no dream; a dream that fails twice is withheld and can be tried again', async () => {
  const kv = memoryKV()
  const quiet = repo()
  assert.equal((await runDream({ env: {}, kv, api: quiet, model: { structured: async () => assert.fail('no call') }, day: 'd', now: new Date('2026-11-24T08:00:00Z') })).skipped, 'nothing since the last dream')
  assert.ok(dreamProblems({ title: 'T', body: 'Rent rose 40 percent on the block, said @ana.example. '.repeat(10) }).some((p) => /figures|handle/.test(p)))
  const kv2 = memoryKV()
  const api = repo({ [LOG]: [log(1, 'replied', 'reply', 'x', '2026-11-24T02:00:00Z')] })
  const bad = { title: 'T', body: 'In 2026 the rent rose. '.repeat(20), questions: [], themes: [] }
  const r = await runDream({ env: {}, kv: kv2, api, model: { structured: async () => ({ data: bad }) }, day: 'd', now: new Date('2026-11-24T08:00:00Z') })
  assert.ok(r.withheld)
  assert.equal(await kv2.get('dream:done:d'), null)
  assert.equal((api.store[DREAM] || []).length, 0)
})

test('memory fold: figures stay out of its input, and a refused draft gets one retry, told why', async () => {
  const kv = memoryKV()
  const api = repo({ [LOG]: [{ uri: 'x', value: { kind: 'journaled', context: 'journal', checks: [{ claim: 'A coalition of 22 states sued over 20,000 families.', verdict: 'supported' }], createdAt: '2026-11-24T13:09:00Z' } }] })
  const prompts = []
  const drafts = [{ memory: 'Twenty-two... no: 22 states sued.' }, { memory: '## Corrections offered\n- a coalition of states sued: confirmed by a check' }]
  const model = { structured: async ({ user }) => { prompts.push(user); return { data: drafts.shift() } } }
  const r = await foldMemory({ kv, api, model })
  assert.equal(r.folded, 1)
  assert.ok(prompts[0].includes('A coalition of some states sued over some families.') && !/\d/.test(prompts[0].split('NEW REFLECTIONS')[1]))
  assert.ok(prompts[1].includes('YOUR LAST DRAFT WAS REFUSED: it has figures (22)'))
  assert.deepEqual(memoryProblems('fine text'), [])
})

test('fact-check: a page that repeats the claim\'s own source word for word is not independent', async () => {
  const words = 'A coalition of 22 states is suing to block a federal rule change that would strip housing assistance'
  const f = async (url) => {
    const u = String(url)
    if (u.endsWith('/robots.txt')) return new Response('', { status: 404 })
    return new Response(`<p>${words} from mixed-status families.</p>`, { headers: { 'content-type': 'text/html' } })
  }
  const model = {
    search: async () => ({ content: [{ type: 'text', citations: [{ url: 'https://stateline.example/a', cited_text: words }, { url: 'https://gov.example/b', cited_text: words }] }], searches: 1 }),
    structured: async ({ user }) => ({ data: { stances: [{ index: 0, stance: 'supports' }] } }),
  }
  const c = await factCheck({ env: {}, kv: memoryKV(), model, day: 'd', claim: 'A coalition of 22 states is suing over the rule.', sourceText: `Headline\n${words} from mixed-status families, the article said.`, fetch: f })
  assert.equal(c.republished, 2)
  assert.equal(c.sources.length, 0)
  assert.equal(c.version, CHECKER_VERSION)
})

test('recheck: an entry checked by the older checker is redone once, keeping the first verdicts on the record', async () => {
  const kv = memoryKV()
  const entry = { uri: `at://${ME}/${COLLECTION}/2026-11-24-x`, value: { title: 'T', source: 'https://news.example/a', sources: ['https://news.example/a'], createdAt: '2026-11-24T13:09:00Z', checks: { quotes: 1, figures: 1, claims: [{ claim: 'The council voted to sell.', verdict: 'disputed', sources: [] }] } } }
  const api = repo({ [COLLECTION]: [entry] })
  const html = `<html><head><meta property="og:title" content="T"></head><body><article><p>${'The council voted to sell the complex to a developer. '.repeat(60)}</p></article></body></html>`
  const f = async (url) => (String(url).endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response(html, { headers: { 'content-type': 'text/html' } }))
  const model = { search: () => {} }
  const factCheckFn = async (o) => ({ claim: o.claim, verdict: 'supported', sources: [{ url: 'https://gov.example/m', title: 'm', quote: 'the council voted to sell', stance: 'supports' }] })
  const r = await recheckEntries({ env: {}, kv, api, model, day: 'd', fetch: f, factCheckFn, now: Date.parse('2026-11-24T14:00:00Z') })
  assert.deepEqual(r, { rechecked: '2026-11-24-x', verdicts: ['supported'] })
  const put = api.puts[0].record
  assert.equal(put.checks.version, CHECKER_VERSION)
  assert.deepEqual(put.checks.superseded, [{ claim: 'The council voted to sell.', verdict: 'disputed' }])
  assert.ok(put.sources.includes('https://gov.example/m'))
  assert.equal(api.logs.at(-1).kind, 'rechecked')
  const page = entryHtml(put, { uri: entry.uri, origin: 'https://autonomist.jason-edelman.org' })
  assert.ok(page.includes('Rechecked on 2026-11-24') && page.includes('The council voted to sell. (disputed)'))
  // done: a current entry isn't rechecked again
  api.store[COLLECTION][0] = { uri: entry.uri, value: put }
  assert.deepEqual(await recheckEntries({ env: {}, kv, api, model, day: 'd', fetch: f, factCheckFn, now: Date.parse('2026-11-24T15:00:00Z') }), { rechecked: 0 })
})

test('dreams page: the latest in full, escaped, with earlier ones by title', () => {
  const html = dreamsHtml([
    { uri: 'at://d/1', value: { title: 'Old <b>one</b>', body: 'x', createdAt: '2026-11-23T07:00:00Z' } },
    { uri: 'at://d/2', value: { title: 'New', body: '## A heading\n\nA <script> paragraph.', questions: ['Who owns it?'], read: { logs: 5, entries: 1 }, createdAt: '2026-11-24T07:00:00Z' } },
  ])
  assert.ok(html.startsWith('<h3>New</h3>') && html.includes('<h4>A heading</h4>') && html.includes('A &lt;script&gt; paragraph.'))
  assert.ok(html.includes('Old &lt;b&gt;one&lt;/b&gt;') && html.includes('Who owns it?'))
})
