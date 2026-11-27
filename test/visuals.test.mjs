// The digest's visual channels and analysis (Jason, 2026-11-27): the power map, threads over time, story images, the
// pull quote, and how the page and the email draw them. No network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkPowerMap, computeTrend, cleanTheme, THEMES } from '../worker/bot/analysis.js'
import { sniffImage, fetchImage, storeImages, blobCid, MAX_IMAGE_BYTES } from '../worker/bot/images.js'
import { pickPull } from '../worker/bot/digest.js'
import { readArticle } from '../worker/journal-core.js'
import { entryHtml } from '../worker/journal-pages.js'
import { digestEmail } from '../worker/newsletter.js'
import { assemble } from '../worker/digest-html.js'
import { dryApi } from '../worker/bot/dry.js'

const filler = ' People in several cities are watching how this plays out for renters and neighbors.'.repeat(20)
const ARTICLES = [
  { url: 'https://a.example/rent', outlet: 'a.example', title: 'Council freezes rents', text: `The council voted to freeze rents in buildings older than forty years after tenants packed the chamber. Landlords said the freeze would stall repairs on about 9,000 units.${filler}` },
  { url: 'https://c.example/land', outlet: 'c.example', title: 'Funds buy farmland', text: `Investment funds bought more farmland this year, and the state has no cap on such sales. Land that could feed a town is now a portfolio line.${filler}` },
]
const row = (over = {}) => ({ thread: 'Rents and repairs', holds: 'The city council and landlords', at_stake: 'Rents in older buildings', bears_cost: 'Tenants in about 9,000 units', direction: 'contested', evidence: [{ tag: 'A1', quote: 'Landlords said the freeze would stall repairs' }], ...over })

test('power map: rows whose evidence is in the article they tag are kept; anything else is dropped, and one row is no map', () => {
  const land = row({ thread: 'Farmland as a portfolio', holds: 'Investment funds', at_stake: 'Farmland', bears_cost: 'Towns that farm it', direction: 'toward enclosure', evidence: [{ tag: 'A2', quote: '“Land that could feed a town is now a portfolio line”' }] })
  const ok = checkPowerMap([row(), land], { articles: ARTICLES })
  assert.deepEqual(ok.problems, [])
  assert.equal(ok.rows.length, 2)
  assert.deepEqual(ok.rows[1].evidence, [{ url: 'https://c.example/land', outlet: 'c.example', quote: 'Land that could feed a town is now a portfolio line' }])
  assert.equal(ok.rows[0].atStake, 'Rents in older buildings')
  const bad = [
    row({ evidence: [{ tag: 'A2', quote: 'Landlords said the freeze would stall repairs' }] }), // in A1, not A2
    row({ evidence: [{ tag: 'A9', quote: 'Landlords said the freeze would stall repairs' }] }),
    row({ bears_cost: 'Tenants in about 12,000 units' }),
    row({ direction: 'sideways' }),
    row({ holds: 'Landlords, says “someone”' }),
    row({ holds: 'see https://x.example' }),
  ]
  for (const b of bad) {
    const r = checkPowerMap([b, land], { articles: ARTICLES })
    assert.equal(r.rows.length, 0, JSON.stringify(b))
    assert.ok(r.problems.some((p) => p.startsWith('power map row 1')), JSON.stringify(r.problems))
  }
  assert.deepEqual(checkPowerMap(undefined, { articles: ARTICLES }).rows, [])
})

test('threads over time: code counts people per theme per day; a day with no themed digest is a gap, not a zero', () => {
  const t = computeTrend({
    day: '2026-11-27',
    stories: [{ theme: 'housing', sharers: 6 }, { theme: 'Housing', sharers: 2 }, { theme: 'nonsense', sharers: 3 }],
    digests: [{ date: '2026-11-26', stories: [{ theme: 'climate and energy', sharers: 4 }, { theme: 'housing', sharers: 1 }] }, { date: '2026-11-25', stories: [{ label: 'before themes', sharers: 9 }] }, { date: '2026-10-01', stories: [{ theme: 'housing', sharers: 50 }] }],
    days: 7,
  })
  assert.deepEqual(t.covered, ['2026-11-26', '2026-11-27'])
  assert.deepEqual(t.rows.map((r) => [r.theme, r.values]), [['housing', [0, 0, 0, 0, 0, 1, 8]], ['climate and energy', [0, 0, 0, 0, 0, 4, 0]], ['other', [0, 0, 0, 0, 0, 0, 3]]])
  assert.equal(cleanTheme('Labor and work'), 'labor and work')
  assert.equal(cleanTheme('crypto'), 'other')
  assert.ok(THEMES.includes('other'))
})

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1])
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const webFake = (routes) => async (url) => {
  const u = String(url)
  if (u.endsWith('/robots.txt')) return routes[u] || new Response('', { status: 404 })
  return routes[u] || new Response('', { status: 404 })
}

test('images: the publisher’s preview image only, where robots.txt allows; the type from the bytes, under the size cap', async () => {
  assert.equal(sniffImage(JPEG), 'image/jpeg')
  assert.equal(sniffImage(PNG), 'image/png')
  assert.equal(sniffImage(new TextEncoder().encode('<html><body>not an image</body></html>')), null)
  const f = webFake({
    'https://img.example/a.jpg': new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } }),
    'https://img.example/page.jpg': new Response('<html>a block page</html>', { headers: { 'content-type': 'image/jpeg' } }),
    'https://img.example/huge.jpg': new Response(new Uint8Array(MAX_IMAGE_BYTES + 10).fill(0xff), { headers: { 'content-type': 'image/jpeg' } }),
    'https://closed.example/robots.txt': new Response('User-agent: *\nDisallow: /'),
    'https://closed.example/a.jpg': new Response(JPEG),
  })
  assert.equal((await fetchImage('https://img.example/a.jpg', { fetch: f })).type, 'image/jpeg')
  assert.equal(await fetchImage('https://img.example/page.jpg', { fetch: f }), null, 'a page served as an image is refused')
  assert.equal(await fetchImage('https://img.example/huge.jpg', { fetch: f }), null)
  assert.equal(await fetchImage('https://closed.example/a.jpg', { fetch: f }), null, 'robots.txt closed')
  assert.equal(await fetchImage('http://img.example/a.jpg', { fetch: f }), null, 'https only')
  // the page's own preview image, as an absolute https address
  const page = readArticle('<html><head><meta property="og:image" content="/pics/lead.jpg"></head><body><p>x</p></body></html>', 'https://news.example/story')
  assert.equal(page.image, 'https://news.example/pics/lead.jpg')
  assert.equal(readArticle('<meta name="twitter:image" content="http://insecure.example/a.jpg">', 'https://n.example/').image, '')
})

test('images: one stored per story, trying a second article when the first has none it may fetch; never without uploadBlob', async () => {
  const f = webFake({ 'https://img.example/a.jpg': new Response(JPEG), 'https://img.example/b.png': new Response(PNG) })
  const uploads = []
  const api = { uploadBlob: async (bytes, type) => { uploads.push(type); return { $type: 'blob', ref: { $link: `bafkrei${'abcdefgh'[uploads.length]}${'q'.repeat(50)}` }, mimeType: type, size: bytes.length } } }
  const stories = [
    { label: 'One', articles: [{ url: 'https://a.example/1', title: 'First', outlet: 'a.example', image: 'https://img.example/missing.jpg' }, { url: 'https://a.example/2', title: 'Second', outlet: 'a.example', image: 'https://img.example/a.jpg' }] },
    { label: 'Two', articles: [{ url: 'https://b.example/1', title: 'B', outlet: 'b.example', image: 'https://img.example/b.png' }] },
    { label: 'Three', articles: [{ url: 'https://c.example/1', title: 'C', outlet: 'c.example', image: '' }] },
  ]
  assert.equal(await storeImages({ api, stories, fetch: f, limit: 6 }), 2)
  assert.equal(stories[0].image.article, 'https://a.example/2')
  assert.equal(stories[0].image.alt, 'Second')
  assert.ok(blobCid(stories[1].image.blob))
  assert.equal(stories[2].image, undefined)
  assert.equal(await storeImages({ api: {}, stories: [{ articles: [{ image: 'https://img.example/a.jpg' }] }], fetch: f }), 0)
  // a dry run keeps the image in the artifact under a stand-in CID the pages accept, and uploads nothing
  const captured = { writes: [], posts: [] }
  const blob = await dryApi({}, captured).uploadBlob(JPEG, 'image/jpeg')
  assert.ok(blobCid(blob), blob.ref.$link)
  assert.match(captured.images[blob.ref.$link], /^data:image\/jpeg;base64,/)
})

test('pull quote: the longest verified passage from an article, 8 to 30 words, never a framework passage', () => {
  const quotes = ['the council voted to freeze rents', 'Landlords said the freeze would stall repairs on about 9,000 units', 'Land that could feed a town is now a portfolio line']
  assert.deepEqual(pickPull(quotes, ARTICLES), { quote: 'Landlords said the freeze would stall repairs on about 9,000 units', url: 'https://a.example/rent', outlet: 'a.example' })
  assert.equal(pickPull(['too short to pull'], ARTICLES), null)
})

const CID = `bafkreiab${'c'.repeat(50)}`
const record = (over = {}) => ({
  kind: 'digest', title: 'Rents frozen, land sold', summary: 'A day of freezes.', question: 'Who owns the land near you?', date: '2026-11-27',
  body: '## What the network is reading\n\nTen accounts shared links.\n\n## The common threads\n\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\n## For people organizing\n\nOrganize.\n\n## What we don\'t know\n\n- Plenty.\n\n## A question to take to your neighbors\n\nWho owns the land near you?',
  network: {
    links: 10, accounts: 5, read: 2, closed: 0,
    stories: [{ label: 'Rent freezes', theme: 'housing', sharers: 3, image: { blob: { $type: 'blob', ref: { $link: CID }, mimeType: 'image/jpeg', size: 9 }, alt: 'Council freezes <rents>', outlet: 'a.example', article: 'https://a.example/rent' }, articles: [{ url: 'https://a.example/rent', title: 'Council freezes rents', outlet: 'a.example' }] }],
    trend: { end: '2026-11-27', days: 7, covered: ['2026-11-27'], rows: [{ theme: 'housing', values: [0, 0, 0, 0, 0, 0, 3] }] },
  },
  analysis: { powerMap: [
    { thread: 'Rents <script>alert(1)</script>', holds: 'The council', atStake: 'Rents', bearsCost: 'Tenants', direction: 'contested', evidence: [{ url: 'https://a.example/rent', outlet: 'a.example', quote: 'Landlords said the freeze would stall repairs' }] },
    { thread: 'Farmland', holds: 'Funds', atStake: 'Land', bearsCost: 'Towns', direction: 'toward enclosure', evidence: [{ url: 'https://c.example/land', outlet: 'c.example', quote: 'Land that could feed a town is now a portfolio line' }] },
  ] },
  pull: { quote: 'Landlords said the freeze would stall repairs on about 9,000 units', url: 'https://a.example/rent', outlet: 'a.example' },
  sources: ['https://a.example/rent', 'https://c.example/land'], checks: { quotes: 3, figures: 1, articlesQuoted: 2 }, model: 'm',
  ...over,
})

test('the page: lead image from the site’s own route, the trend before the threads, the pull quote, the power map before organizing, all escaped', () => {
  const html = entryHtml(record(), { uri: 'at://x', origin: 'https://autonomist.example' })
  assert.ok(html.includes(`<img src="/journal/img/${CID}" alt="Council freezes &lt;rents&gt;"`))
  assert.ok(html.includes(`class="thumb" src="/journal/img/${CID}"`))
  const at = (s) => html.indexOf(s)
  assert.ok(at('id="trend-h"') < at('id="the-common-threads"') && at('id="the-common-threads"') < at('class="pull"') && at('class="pull"') < at('id="power-map-h"') && at('id="power-map-h"') < at('id="for-people-organizing"'))
  // the pull quote after the threads' second paragraph
  assert.ok(at('Second paragraph.') < at('class="pull"') && at('class="pull"') < at('Third paragraph.'))
  assert.ok(html.includes('class="pm-dir pm-contested"') && html.includes('class="pm-dir pm-enclosure"'))
  assert.ok(!html.includes('<script>') && html.includes('Rents &lt;script&gt;'))
  assert.ok(html.includes('<span class="units" aria-hidden="true"><i></i><i></i><i></i></span>'))
  // an older digest renders as before, with none of them; a CID that isn't one is never served
  const old = entryHtml(record({ analysis: undefined, pull: undefined, network: { ...record().network, trend: undefined, stories: [{ ...record().network.stories[0], image: { blob: { ref: { $link: '../../etc' } } } }] } }), { uri: 'at://x', origin: '' })
  assert.ok(!old.includes('power-map-h') && !old.includes('trend-h') && !old.includes('class="pull"') && !old.includes('<img'))
  // a part whose place isn't found goes at the end
  assert.equal(assemble('<p>no sections</p>', { powerMap: '<section>map</section>' }), '<p>no sections</p><section>map</section>')
})

test('the email: the same parts inline-styled, the lead image from the site by its full address', () => {
  const { html } = digestEmail({ ...record(), slug: '2026-11-27-rents' }, { origin: 'https://autonomist.example', unsubscribe: '#u' })
  assert.ok(html.includes(`src="https://autonomist.example/journal/img/${CID}"`))
  assert.ok(html.includes('The power map') && html.includes('What the network keeps coming back to'))
  assert.ok(html.indexOf('The power map') < html.indexOf('For people organizing'))
  assert.ok(html.includes('Landlords said the freeze would stall repairs on about 9,000 units'))
  assert.ok(!html.includes('<script>'))
  // a dry run's email shows its images from the artifact
  const dry = digestEmail({ ...record(), slug: 's' }, { origin: 'https://autonomist.example', src: () => 'data:image/jpeg;base64,AAAA' })
  assert.ok(dry.html.includes('src="data:image/jpeg;base64,AAAA"'))
})

test('reading: one article under two addresses is read once (2026-11-27 listed a New Republic piece twice)', async () => {
  const { runDigest, CLUSTER_SCHEMA, NOTE_SCHEMA } = await import('../worker/bot/digest.js')
  const { memoryKV } = await import('./helpers.mjs')
  const kv = memoryKV()
  const now = Date.parse('2026-11-27T13:07:00Z')
  const text = `The talks collapsed after a long night of objections from several delegations.${' Delegates went home without a deal on the main question.'.repeat(30)}`
  const page = `<html><head><meta property="og:title" content="The talks were a disaster"><meta property="og:site_name" content="The New Republic"></head><body><p>${text}</p></body></html>`
  for (const [i, u] of ['https://tnr.example/talks', 'https://mirror.tnr-example.net/talks', 'https://other.example/a'].entries()) await kv.put(`cand:${i}`, '', { metadata: { u, t: i < 2 ? 'The talks were a disaster' : 'Another', at: new Date(now - 60e3).toISOString(), h: 'x', s: [`p${i}`, `q${i}`] } })
  for (let i = 3; i < 6; i++) await kv.put(`cand:${i}`, '', { metadata: { u: `https://pad${i}.example/`, t: `Pad ${i}`, at: new Date(now - 60e3).toISOString(), h: 'x', s: [`r${i}`] } })
  // the same piece at its home and at a mirror: different hosts, so both are picked; one outlet and headline, so one is read
  const f = async (url) => (String(url).endsWith('robots.txt') ? new Response('', { status: 404 }) : new Response(String(url).includes('tnr') ? page : page.replace('The talks were a disaster', `Other ${url}`).replace('The New Republic', String(url)), { headers: { 'content-type': 'text/html' } }))
  let notes = 0
  const model = { structured: async ({ schema }) => {
    if (schema === CLUSTER_SCHEMA) return { data: { stories: [{ label: 'Everything', items: [0, 1, 2, 3, 4, 5], relevance: 1, theme: 'other' }] } }
    if (schema === NOTE_SCHEMA) { notes++; return { data: { gist: '', quotes: [], themes: [] } } }
    throw new Error('stop here')
  } }
  await runDigest({ env: { BOT_DIGEST_PER_STORY: '6' }, kv, api: { session: async () => ({ did: 'did:plc:me' }), call: async () => ({}) }, model, day: '2026-11-27', fetch: f, now })
  // the two addresses are one article: notes are taken once for it (six without the check)
  assert.equal(notes, 5)
})

test('the journal index: a digest shows its lead story’s image; an entry without one, none', async () => {
  const { listItems, listHtml } = await import('../worker/journal-pages.js')
  const items = listItems([], [
    { uri: 'at://did/c/2026-11-28-d', value: { kind: 'digest', title: 'D', date: '2026-11-28', summary: 'S', network: { stories: [{ label: 'x' }, { label: 'y', image: { blob: { ref: { $link: CID } } } }] } } },
    { uri: 'at://did/c/2026-11-24-b', value: { title: 'B', date: '2026-11-24', outlet: 'O', summary: 'S' } },
  ])
  const html = listHtml(items)
  assert.ok(html.includes(`<li class="has-thumb"><img class="thumb" src="/journal/img/${CID}"`))
  assert.equal(html.match(/<img/g).length, 1)
})

test('pages are read in the character set they declare, and a headline loses the site name tacked on its end', async () => {
  const { pageText, withoutSiteName } = await import('../worker/journal-core.js')
  // "vídeo" in Latin-1: one byte for the í, which read as UTF-8 became "�" (El Mundo, 2026-11-27)
  const latin1 = new Uint8Array([...new TextEncoder().encode('<title>Un v'), 0xed, ...new TextEncoder().encode('deo</title>')])
  assert.equal(await pageText(new Response(latin1, { headers: { 'content-type': 'text/html; charset=ISO-8859-1' } })), '<title>Un vídeo</title>')
  const meta = new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1252"><p>v'), 0xed, ...new TextEncoder().encode('deo</p>')])
  assert.equal(await pageText(new Response(meta, { headers: { 'content-type': 'text/html' } })), '<meta charset="windows-1252"><p>vídeo</p>')
  assert.equal(await pageText(new Response('café ok', { headers: { 'content-type': 'text/html; charset=x-unknown' } })), 'café ok')
  assert.equal(withoutSiteName('Mason County data center named one of biggest potential polluters · West Virginia Watch', 'West Virginia Watch'), 'Mason County data center named one of biggest potential polluters')
  assert.equal(withoutSiteName('Why the Watch matters', 'West Virginia Watch'), 'Why the Watch matters')
  assert.equal(readArticle('<meta property="og:title" content="Rents rise | The Paper"><meta property="og:site_name" content="The Paper">', 'https://p.example/').title, 'Rents rise')
})
