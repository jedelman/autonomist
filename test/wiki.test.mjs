// autonomist's writes to the knowledge commons' wiki (worker/bot/wiki.js). No network: PLC, the owner's PDS and
// Lichen's appview are fakes, and so is autonomist's own PDS.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { strictKV } from './helpers.mjs'
import { runWiki, termsText, personDataProblem, confirmedClaims, resetWikiCache, TERMS_SLUG } from '../worker/bot/wiki.js'

const OWNER = 'did:plc:zz4wcje4a2nbbtc7pdoth3f2'
const ME = 'did:plc:kmswr7d5c55rc4ot2dbn6sfq'
const WIKI = `at://${OWNER}/wiki.lichen.wiki/public-knowledge`
const env = (extra = {}) => ({ WIKI_URI: WIKI, PUBLIC_ORIGIN: 'https://autonomist.jason-edelman.org', PDS_PASSWORD: 'pds-password-secret', ...extra })

/** The outside world: PLC, the owner's PDS (wiki + memberships) and Lichen's appview, whose notes the test sets. */
function world({ visibility = 'public', role = 'contributor' } = {}) {
  const notes = new Map()
  const calls = []
  const f = async (url) => {
    const u = new URL(String(url))
    calls.push(`${u.host}${u.pathname}`)
    const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (u.host === 'plc.directory') {
      const did = u.pathname.slice(1)
      const handle = { [OWNER]: 'jason-edelman.org', [ME]: 'autonomist.jason-edelman.org' }[did]
      return json({ id: did, alsoKnownAs: [`at://${handle}`], service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://owner.pds.example' }] })
    }
    if (u.host === 'owner.pds.example' && u.pathname.endsWith('getRecord')) return json({ value: { visibility } })
    if (u.host === 'owner.pds.example' && u.pathname.endsWith('listRecords')) return json({ records: role ? [{ value: { wikiRef: WIKI, memberDid: ME, role } }] : [] })
    if (u.host === 'lichen.wiki') {
      const n = notes.get(u.searchParams.get('slug'))
      return n ? json(n) : json({ error: 'NotFound', message: 'Note not found' }, 404)
    }
    return json({ error: 'unexpected' }, 500)
  }
  return { f, notes, calls }
}

/** autonomist's own PDS: a run journal to read, and every applyWrites kept. */
function pds(logs = []) {
  const applied = []
  const api = {
    session: async () => ({ did: ME }),
    call: async (method, nsid, opts = {}) => {
      if (nsid === 'com.atproto.repo.listRecords') return { records: logs }
      if (nsid === 'com.atproto.repo.getRecord') { const e = new Error('RecordNotFound'); e.status = 400; throw e }
      if (nsid === 'com.atproto.repo.applyWrites') { applied.push(opts.body); return {} }
      throw new Error(`unexpected ${nsid}`)
    },
  }
  return { api, applied }
}

const log = (rkey, context, checks, result) => ({ uri: `at://${ME}/org.jason-edelman.autonomist.log/${rkey}`, value: { kind: 'journaled', context, ...(result ? { result } : {}), checks, createdAt: '2026-11-25T13:20:00.000Z' } })
const confirmed = (claim, quote = 'froze rents for twelve months') => ({ claim, verdict: 'confirmed', sources: [{ url: 'https://a.example/x', quote, stance: 'supports' }, { url: 'https://b.example/y', quote: 'a twelve-month freeze', stance: 'supports' }] })
const LOGS = [
  log('3n35zzzz00002', 'mention', [confirmed('The city council froze rents for a year.')]),
  log('3n35zzzz00001', 'digest', [confirmed('Farmland prices rose last year.'), { claim: 'One source only.', verdict: 'supported', sources: [{ url: 'https://c.example/', stance: 'supports' }] }], 'https://autonomist.jason-edelman.org/journal/2026-11-25-day/'),
]

test('terms: written by code from its rules, and nothing in them the commons refuses', () => {
  const t = termsText({ BOT_ACQUAINT_ITEMS: '1000' })
  for (const must of ['liking its pinned post', 'at most one a day', '1,000 records', 'Unliking ends all of it', 'goes to Anthropic', 'never** follows anyone but the opted-in', 'Only autonomist writes its memory', 'Its notes on people never come here']) assert.ok(t.includes(must), must)
  const members = { roles: new Map([[OWNER, 'admin'], [ME, 'contributor']]), handles: new Map([['jason-edelman.org', OWNER], ['autonomist.jason-edelman.org', ME]]) }
  assert.equal(personDataProblem(t, members), null)
  assert.match(personDataProblem('ask @someone.bsky.social', members), /isn't a member/)
  assert.match(personDataProblem('write to a@b.org', members), /email/)
  assert.match(personDataProblem('the key pds-password-secret', members, ['pds-password-secret']), /secret/)
})

test('claims: only confirmed ones with two supporting sources; a conversation is named, never linked', async () => {
  const { api } = pds(LOGS)
  const c = await confirmedClaims(api, ME)
  assert.deepEqual(c.map((x) => x.claim), ['Farmland prices rose last year.', 'The city council froze rents for a year.'])
  assert.equal(c[0].where.url, 'https://autonomist.jason-edelman.org/journal/2026-11-25-day/')
  assert.deepEqual(c[1].where, { conversation: true })
  assert.deepEqual(await confirmedClaims(api, ME, '3n35zzzz00001').then((x) => x.map((y) => y.claim)), ['The city council froze rents for a year.'])
})

test('first run: its terms page and this month’s claims page created, lexicon-checked, each KV key written once', async () => {
  resetWikiCache()
  const w = world()
  const { api, applied } = pds(LOGS)
  const kv = strictKV()
  const r = await runWiki({ env: env(), kv, api, now: Date.parse('2026-11-25T20:07:00Z'), fetch: w.f })
  assert.equal(r.terms.action, 'create', JSON.stringify(r))
  assert.equal(r.claims.action, 'create', JSON.stringify(r))
  assert.equal(applied.length, 2)
  for (const a of applied) {
    assert.equal(a.repo, ME)
    assert.deepEqual(a.writes.map((x) => x.collection), ['wiki.lichen.note', 'wiki.lichen.noteRevision', 'wiki.lichen.noteSnapshot'])
    assert.ok(a.writes.every((x) => x.$type === 'com.atproto.repo.applyWrites#create'))
  }
  assert.equal(applied[0].writes[0].value.slug, TERMS_SLUG)
  const claimsPage = applied[1].writes[2].value
  assert.equal(claimsPage.slug, 'claims-autonomist-checked-november-2026')
  assert.ok(claimsPage.content.includes('## Farmland prices rose last year.') && claimsPage.content.includes('Found while writing [its digest]'))
  assert.ok(claimsPage.content.includes('## The city council froze rents for a year.\n') && claimsPage.content.includes('Found in a conversation on Bluesky.'))
  assert.ok(!claimsPage.content.includes('One source only.'))
  assert.equal(await kv.get('wiki:claims:cursor'), '3n35zzzz00002')
  assert.ok(await kv.get('wiki:terms:hash'))
})

test('next run: nothing while Lichen hasn’t shown its last write; then new claims go on as an edit against the head', async () => {
  resetWikiCache()
  const w = world()
  const logs = [...LOGS]
  const { api, applied } = pds(logs)
  const kv = strictKV()
  const now = Date.parse('2026-11-25T20:07:00Z')
  await runWiki({ env: env(), kv, api, now, fetch: w.f })
  const created = applied.splice(0)
  // an hour later, a new confirmed claim, but Lichen still doesn't show the claims page: it waits, and keeps its place
  kv.clock.t += 3_600_000
  logs.unshift(log('3n35zzzz00003', 'digest', [confirmed('A tenant co-op bought its building.', 'bought the building')], 'https://autonomist.jason-edelman.org/journal/2026-11-26-day/'))
  const waiting = await runWiki({ env: env(), kv, api, now: now + 3_600_000, fetch: w.f })
  assert.ok(waiting.claims.waiting, JSON.stringify(waiting))
  assert.equal(applied.length, 0)
  assert.equal(await kv.get('wiki:claims:cursor'), '3n35zzzz00002')
  // Lichen shows it now: the new claim goes on as one revision on top of it
  const page = created[1].writes
  w.notes.set('claims-autonomist-checked-november-2026', { uri: page[0].value ? `at://${ME}/wiki.lichen.note/${page[0].rkey}` : '', slug: 'claims-autonomist-checked-november-2026', title: page[0].value.title, content: page[2].value.content, latestRevisionUri: `at://${ME}/wiki.lichen.noteRevision/${page[1].rkey}` })
  kv.clock.t += 3_600_000
  const edited = await runWiki({ env: env(), kv, api, now: now + 7_200_000, fetch: w.f })
  assert.equal(edited.claims.action, 'edit', JSON.stringify(edited))
  assert.deepEqual(applied[0].writes.map((x) => x.collection), ['wiki.lichen.noteRevision', 'wiki.lichen.noteSnapshot'])
  assert.equal(applied[0].writes[0].value.parentRevision, `at://${ME}/wiki.lichen.noteRevision/${page[1].rkey}`)
  assert.ok(applied[0].writes[1].value.content.includes('## A tenant co-op bought its building.'))
  // the claims already on the page aren't added twice
  assert.equal(applied[0].writes[1].value.content.split('## Farmland prices rose last year.').length, 2)
  assert.equal(await kv.get('wiki:claims:cursor'), '3n35zzzz00003')
})

test('refusals: a private wiki, a wiki that doesn’t list it, and a claim carrying an email write nothing of theirs', async () => {
  for (const [opts, why] of [[{ visibility: 'private' }, /private/], [{ role: null }, /doesn't list autonomist/]]) {
    resetWikiCache()
    const { api, applied } = pds(LOGS)
    const r = await runWiki({ env: env(), kv: strictKV(), api, now: Date.now(), fetch: world(opts).f })
    assert.match(r.terms.refused, why)
    assert.equal(applied.length, 0)
  }
  resetWikiCache()
  const { api, applied } = pds([log('3n35zzzz00009', 'digest', [confirmed('Rents rose.', 'write to tips@paper.example')], 'https://autonomist.jason-edelman.org/journal/x/')])
  const r = await runWiki({ env: env(), kv: strictKV(), api, now: Date.now(), fetch: world().f })
  assert.equal(r.claims.kept, 0)
  assert.equal(applied.length, 1) // the terms page only
  assert.deepEqual(await runWiki({ env: env({ WIKI_URI: '' }), kv: strictKV(), api, fetch: world().f }), { skipped: 'no wiki configured' })
})
