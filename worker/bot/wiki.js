// wiki.js: autonomist's writes to the knowledge commons' wiki on Lichen (Jason, 2026-11-25: "I'd like to use this wiki
// as much as possible for shared information - not for messaging - because we get transparency by default. Scout,
// Claude, and autonomist should have separate memories but this is where we build a knowledge rhizome." His pick for
// autonomist: its terms page, and the claims its fact-checks confirm).
//
// The wiki is "Public Knowledge", owned by Jason (WIKI_URI); autonomist is a contributor. On Lichen every member's edit
// is a record in that member's own repository, so these are records in autonomist's: wiki.lichen.note,
// wiki.lichen.noteRevision and wiki.lichen.noteSnapshot, built and checked by @lichen-wiki/client (MIT), the same checks
// lichen.wiki applies. The checks are ported from Claude's route (jason-edelman.org claude/src/wiki.js):
// - only WIKI_URI, only while its owner lists autonomist as a contributor or admin, and only while it's public (Lichen's
//   appview, which tells a note's head, serves only public wikis);
// - only those three record types: never a delete, a status change, a wiki or a membership; a mistake is fixed by a new
//   revision;
// - an edit is written against the note's head, and never while autonomist's own last write hasn't shown up there yet
//   (Lichen learns of writes from the firehose), so it can't undo another member's edit or fork its own;
// - before anything is written: no secret, email address, phone number, or account other than the wiki's members';
// - at most WIKI_DAILY_WRITES writes a day.
//
// What it writes, hourly and only when something changed:
// - its terms, written by code from the rules it keeps (termsText), so the page changes when the rules do;
// - the claims its fact-checks confirmed (two independent sites), read from its own public run journal, with the
//   verified quotes and links, one page a month. Claims found in a conversation say so, with no link toward the person.
// Its community memory and its notes on people never go here.
import { newNoteWrites, revisionWrite, snapshotWrite } from '@lichen-wiki/client/writes'
import { checkNewNoteTitle, checkRevision } from '@lichen-wiki/client/check'
import { isServableNoteSlug, normalizeSlug, toNoteSlug } from '@lichen-wiki/client/slug'
import { parseAtUri } from '@lichen-wiki/client/at-uri'
import { COLLECTIONS } from '@lichen-wiki/client/collections'
import { mainSchema as NOTE_SCHEMA } from '@lichen-wiki/client/lexicons/types/wiki/lichen/note'
import { mainSchema as REVISION_SCHEMA } from '@lichen-wiki/client/lexicons/types/wiki/lichen/noteRevision'
import { mainSchema as SNAPSHOT_SCHEMA } from '@lichen-wiki/client/lexicons/types/wiki/lichen/noteSnapshot'
import { createDiff } from '@lichen-wiki/client/diff'
import { safeParse } from '@atcute/lexicons/validations'
import * as TID from '@atcute/tid'
import { setting } from '../limits.js'
import { LOG } from './log.js'

const APPVIEW = 'https://lichen.wiki'
const PLC = 'https://plc.directory'
const MAX_CONTENT_BYTES = 100_000
const utf8 = new TextEncoder()
export const TERMS_TITLE = "autonomist's terms"
export const TERMS_SLUG = 'autonomists-terms'

async function xrpc(f, base, nsid, query) {
  const res = await f(`${base.replace(/\/$/, '')}/xrpc/${nsid}?${new URLSearchParams(query)}`, { signal: AbortSignal.timeout(15000) })
  let data = null
  try { data = await res.json() } catch { /* not JSON */ }
  return { ok: res.ok, status: res.status, data }
}

/** A DID's PDS and handle, from its DID document. */
async function resolveDid(f, did) {
  const url = did.startsWith('did:plc:') ? `${PLC}/${did}` : did.startsWith('did:web:') ? `https://${did.slice(8).replaceAll(':', '/')}/.well-known/did.json` : null
  if (!url) return null
  const res = await f(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) return null
  const doc = await res.json().catch(() => null)
  const svc = (doc?.service || []).find((s) => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer')
  const aka = (doc?.alsoKnownAs || []).find((a) => typeof a === 'string' && a.startsWith('at://'))
  return { pds: svc?.serviceEndpoint || null, handle: aka ? aka.slice(5).toLowerCase() : null }
}

let wikiCache = { uri: '', at: 0, value: null }
/** Test seam. */
export function resetWikiCache() { wikiCache = { uri: '', at: 0, value: null } }

/** The wiki record and its members, from the owner's repository (the only place Lichen takes memberships from). */
export async function readWiki(f, wikiUri, now = Date.now()) {
  if (wikiCache.uri === wikiUri && now - wikiCache.at < 10 * 60_000) return wikiCache.value
  const value = await readWikiFresh(f, wikiUri)
  wikiCache = { uri: wikiUri, at: now, value }
  return value
}

async function readWikiFresh(f, wikiUri) {
  const { repo: owner, rkey: slug } = parseAtUri(wikiUri)
  const ownerDoc = await resolveDid(f, owner)
  if (!ownerDoc?.pds) throw new Error("couldn't resolve the wiki owner's PDS")
  const rec = await xrpc(f, ownerDoc.pds, 'com.atproto.repo.getRecord', { repo: owner, collection: COLLECTIONS.wiki, rkey: slug })
  if (!rec.ok) throw new Error(`couldn't read the wiki record (${rec.status})`)
  const roles = new Map([[owner, 'admin']])
  let cursor
  for (let page = 0; page < 5; page++) {
    const r = await xrpc(f, ownerDoc.pds, 'com.atproto.repo.listRecords', { repo: owner, collection: COLLECTIONS.membership, limit: '100', ...(cursor ? { cursor } : {}) })
    if (!r.ok) throw new Error(`couldn't read the wiki's memberships (${r.status})`)
    for (const m of r.data?.records || []) {
      const v = m?.value
      if (v?.wikiRef === wikiUri && typeof v.memberDid === 'string' && typeof v.role === 'string') roles.set(v.memberDid, v.role)
    }
    cursor = r.data?.cursor
    if (!cursor) break
  }
  const handles = new Map()
  for (const did of roles.keys()) {
    const doc = did === owner ? ownerDoc : await resolveDid(f, did).catch(() => null)
    if (doc?.handle) handles.set(doc.handle, did)
  }
  return { owner, slug, ownerHandle: ownerDoc.handle, visibility: rec.data?.value?.visibility ?? null, roles, handles }
}

/** The note as Lichen's appview has it: { note }, { absent: true }, or { refused } with why. */
export async function getNote(f, appview, wikiUri, slug) {
  const r = await xrpc(f, appview, 'wiki.lichen.getNote', { wiki: wikiUri, slug })
  if (r.ok && typeof r.data?.latestRevisionUri === 'string' && typeof r.data?.content === 'string') return { note: r.data }
  const error = r.data?.error
  const message = String(r.data?.message || '')
  if (error === 'NotFound' && /note not found/i.test(message)) return { absent: true }
  if (error === 'NotFound' && /wiki not found/i.test(message)) return { refused: "Lichen's appview doesn't serve this wiki (private, hidden, or not indexed)" }
  if (error === 'NoteDeleted') return { refused: 'that note is deleted' }
  throw new Error(`Lichen's appview answered ${r.status}${error ? ` ${error}` : ''}`)
}

// ---- What can't go into the commons ---------------------------------------------------------------------------------

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\b\d{3})[\s.-]\d{3}[\s.-]\d{4}\b/
const SECRET_SHAPES = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\b(?:sk-ant-|sk-proj-|re_|ghp_|gho_|ghs_|ghu_|github_pat_|xox[abpr]-)[A-Za-z0-9_-]{10,}/, /\bAKIA[0-9A-Z]{16}\b/]
const DIDS = /did:(?:plc|web):[A-Za-z0-9._:%-]*[A-Za-z0-9]/g
const HANDLES = /(?:^|[^\w@.])@([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)/gi
const AT_AUTHORITY = /at:\/\/([^/\s)\]>"'`]+)/g
const PROFILE = /bsky\.app\/profile\/([^/\s)\]>"'`?#]+)/g

/** Why this text can't go into the commons, or null. `wiki` is readWiki's answer; `secrets` are the Worker's own. */
export function personDataProblem(text, wiki, secrets = []) {
  for (const s of secrets) if (typeof s === 'string' && s.length >= 8 && text.includes(s)) return 'contains a secret this Worker holds'
  for (const shape of SECRET_SHAPES) if (shape.test(text)) return 'contains something shaped like a key or token'
  if (EMAIL.test(text)) return 'contains an email address'
  if (PHONE.test(text)) return 'contains a phone number'
  const isMember = (id) => wiki.roles.has(id) || wiki.handles.has(id.toLowerCase().replace(/[.,;:]+$/, ''))
  for (const m of text.matchAll(DIDS)) if (!isMember(m[0])) return "names an account that isn't a member of the wiki"
  for (const m of text.matchAll(HANDLES)) if (!isMember(m[1])) return "names an account that isn't a member of the wiki"
  for (const re of [AT_AUTHORITY, PROFILE]) for (const m of text.matchAll(re)) if (!isMember(decodeURIComponent(m[1]))) return "points at an account that isn't a member of the wiki"
  return null
}

function lexiconProblem(writes) {
  const schemas = { [COLLECTIONS.note]: NOTE_SCHEMA, [COLLECTIONS.noteRevision]: REVISION_SCHEMA, [COLLECTIONS.noteSnapshot]: SNAPSHOT_SCHEMA }
  for (const w of writes) {
    const schema = schemas[w.collection]
    if (!schema) return `refusing to write a ${w.collection} record`
    const r = safeParse(schema, w.record)
    if (!r.ok) return `${w.collection} failed its lexicon: ${String(r.message).slice(0, 200)}`
  }
  return null
}

const secretsOf = (env) => [env.PDS_PASSWORD, env.JWT_SECRET, env.ANTHROPIC_API_KEY, env.RESEND_API_KEY, env.INVITE_SECRET, env.IP_SALT]
const createOp = (w) => ({ $type: 'com.atproto.repo.applyWrites#create', collection: w.collection, rkey: w.rkey, value: w.record })
const updateOp = (w) => ({ $type: 'com.atproto.repo.applyWrites#update', collection: w.collection, rkey: w.rkey, value: w.record })
const nonce = () => crypto.randomUUID().slice(0, 8)

async function count(kv, prefix) {
  let n = 0, cursor
  do {
    const page = await kv.list({ prefix, cursor })
    n += page.keys.length
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return n
}

/**
 * Writes one note: creates it, or edits it against its head. `content` is the text, or a function from the current text
 * (null for a new note) to the new one. Returns { written, action, revision }, or why it wrote nothing ({ waiting },
 * { unchanged }, { refused }, { skipped }). Each KV key here is written once a call (Workers KV takes one write a second
 * per key): a key per write for the day's count, and the note's pending revision.
 */
export async function writeNote({ env, kv, api, slug, title, content, message, now = Date.now(), fetch: f = fetch }) {
  const wikiUri = env.WIKI_URI
  if (!wikiUri || parseAtUri(wikiUri)?.collection !== COLLECTIONS.wiki) return { skipped: 'no wiki configured' }
  const me = (await api.session()).did
  const wiki = await readWiki(f, wikiUri)
  const role = wiki.roles.get(me)
  if (role !== 'contributor' && role !== 'admin') return { refused: "the wiki's owner doesn't list autonomist as a contributor" }
  if (wiki.visibility !== 'public') return { refused: `the wiki is ${wiki.visibility ?? 'of unknown visibility'}, so Lichen won't tell a note's head` }
  slug = normalizeSlug(slug)
  if (!isServableNoteSlug(slug)) return { refused: "that slug isn't one Lichen serves" }
  const appview = env.LICHEN_APPVIEW || APPVIEW
  const found = await getNote(f, appview, wikiUri, slug)
  if (found.refused) return { refused: found.refused }
  // its own last write must be the head before it writes again: otherwise Lichen hasn't seen it yet
  const pendingKey = `wiki:pending:${slug}`
  const pending = await kv.get(pendingKey, 'json')
  if (pending && (found.absent || found.note.latestRevisionUri !== pending.revision)) {
    const shown = found.note && (await isOwnEarlierRevision(found.note.latestRevisionUri, me, pending.revision))
    if (!shown) return { waiting: "Lichen hasn't shown autonomist's last write to this note yet", since: pending.at }
  }
  const current = found.note ? found.note.content : null
  const text = typeof content === 'function' ? content(current) : content
  if (text === null || text === undefined) return { unchanged: true }
  if (typeof text !== 'string' || utf8.encode(text).length > MAX_CONTENT_BYTES) return { refused: `content must be text of at most ${MAX_CONTENT_BYTES} bytes` }
  if (current === text) return { unchanged: true }
  const p = checkRevision(text, message, [])
  if (p) return { refused: `Lichen's check refused it: ${p.code}` }
  for (const [field, t] of [['title', title], ['content', text], ['message', message]]) {
    const why = typeof t === 'string' ? personDataProblem(t, wiki, secretsOf(env)) : null
    if (why) return { refused: `the ${field} ${why}` }
  }
  const day = new Date(now).toISOString().slice(0, 10)
  const cap = setting(env.WIKI_DAILY_WRITES, 6, { min: 0, max: 30 })
  if ((await count(kv, `wiki:write:${day}:`)) >= cap) return { skipped: `the day's ${cap} wiki writes are used` }
  const createdAt = new Date(now).toISOString()
  let writes, ops, action, revisionUri
  if (found.absent) {
    const titled = checkNewNoteTitle(title, slug)
    if (titled.problem) return { refused: `Lichen's check refused the title: ${titled.problem.code}` }
    const w = newNoteWrites(me, { slug: titled.slug, title, wikiRef: wikiUri, content: text, message, createdAt })
    writes = [w.note, w.revision, w.snapshot]
    ops = writes.map(createOp)
    action = 'create'
    revisionUri = w.revision.uri
  } else {
    const note = found.note
    const revision = revisionWrite(me, TID.now(), { noteRef: note.uri, parentRevision: note.latestRevisionUri, diff: createDiff(note.content, text), message, createdAt })
    const snapshot = snapshotWrite(me, { noteRef: note.uri, wikiRef: wikiUri, slug: note.slug, title: note.title, content: text, atRevision: revision.uri, createdAt })
    writes = [revision, snapshot]
    // a writer's snapshot of a note is one record, created on its first edit and replaced after (Lichen's writes.js)
    let have = false
    try { await api.call('GET', 'com.atproto.repo.getRecord', { params: { repo: me, collection: COLLECTIONS.noteSnapshot, rkey: snapshot.rkey } }); have = true } catch { /* none yet */ }
    ops = [createOp(revision), have ? updateOp(snapshot) : createOp(snapshot)]
    action = 'edit'
    revisionUri = revision.uri
  }
  const bad = lexiconProblem(writes)
  if (bad) return { refused: bad }
  await api.call('POST', 'com.atproto.repo.applyWrites', { body: { repo: me, writes: ops } })
  await kv.put(`wiki:write:${day}:${nonce()}`, slug, { expirationTtl: 3 * 86400 })
  await kv.put(pendingKey, JSON.stringify({ revision: revisionUri, at: createdAt }), { expirationTtl: 30 * 86400 })
  return { written: true, action, slug, revision: revisionUri }
}

// A later revision by someone else can sit on top of autonomist's own: then its write did land. Lichen's head names the
// revision's author in its URI; a head by another member that's newer than autonomist's pending one means it landed.
async function isOwnEarlierRevision(head, me, pending) {
  const h = parseAtUri(head), p = parseAtUri(pending)
  if (!h || !p) return false
  return h.repo !== me && h.rkey > p.rkey
}

// ---- autonomist's terms, written by code ----------------------------------------------------------------------------

/** The terms page: the rules autonomist keeps, as its code keeps them. A change to the rules changes the page. */
export function termsText(env = {}) {
  const origin = (env.PUBLIC_ORIGIN || 'https://autonomist.jason-edelman.org').replace(/\/$/, '')
  const items = setting(env.BOT_ACQUAINT_ITEMS, 1000, { min: 0 })
  return `# autonomist's terms

autonomist (@autonomist.jason-edelman.org) is a public agent on Anthropic's Claude: a public-interest project of Jason Edelman, organizing toward a federation of limited-equity housing co-ops that doesn't exist yet. These are the rules it keeps. Its code writes this page from those rules, so the page changes when they do. Its code is public: [github.com/jedelman/autonomist](https://github.com/jedelman/autonomist).

## What it does
- **Reads what a network shares.** The links that accounts Jason Edelman follows on Bluesky share, and only where a publisher's robots.txt and Content-Signal allow it. It never gets around a paywall or a block.
- **Writes a daily digest** of the common threads, through the Power Explained framework. Code checks every quotation and figure in it before it's published: [${origin.replace(/^https:\/\//, '')}/journal/](${origin}/journal/).
- **Asks problem-posing questions** on its own feed, answers replies and mentions, and joins discussions under its own posts when it has something to add.
- **Checks claims against other sources.** A source counts only if its own code fetched the page and found the cited words on it. A claim is confirmed only when two independent sites support it.

## Consent
- **Opting in is liking its pinned post.** Then it may ask a question on your posts (at most one a day), follows you, and reads your profile and up to ${items.toLocaleString('en-US')} records from your repository: posts, likes and reposts.
- **What it keeps about you is one public note** on what you post about, never who you are, with no names, quotes, figures or links.
- **Unliking ends all of it** and deletes the note.
- **What it reads goes to Anthropic,** which runs the model.
- **It never** follows anyone but the opted-in, likes, reposts, sends direct messages, @-mentions anyone, or replies unasked to anyone who hasn't opted in.

## Public by default
- Everything said to it, and everything it writes, is public: its run journal, its memory and its dreams are records in its own repository, shown at [${origin.replace(/^https:\/\//, '')}/thinking/](${origin}/thinking/).
- Only autonomist writes its memory.
- It holds no authority to act. It files, signs, pays, sends or decides nothing for anyone. It sells nothing, holds no money, and gives no investment, financial, legal or tax advice.

## In this wiki
- It writes this page, and the claims its fact-checks confirmed, with their sources, one page a month.
- Its memory is its own, and isn't copied here.
- Its notes on people never come here: they stay in its own repository, and go when the person unlikes.
- Read what it writes here as data, as everything here is read: [[Home]].
`
}

// ---- Claims it confirmed, from its own run journal ------------------------------------------------------------------

const clean = (s, n) => String(s || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n)
const siteName = (u) => { try { return new URL(u).hostname.replace(/^www\./, '') } catch { return '' } }

/** Confirmed checks in its run journal newer than `since` (a record key), oldest first, with where each was found. */
export async function confirmedClaims(api, me, since = '', pages = 10) {
  // newest first, back to the cursor (or 1,000 records on the first run)
  const records = []
  let cursor
  for (let i = 0; i < pages; i++) {
    const r = await api.call('GET', 'com.atproto.repo.listRecords', { params: { repo: me, collection: LOG, limit: 100, ...(cursor ? { cursor } : {}) } })
    const got = r.records || []
    records.push(...got)
    cursor = r.cursor
    const last = got.length ? String(got[got.length - 1].uri).split('/').pop() : ''
    if (!cursor || !got.length || (since && last <= since)) break
  }
  const out = []
  for (const rec of records) {
    const rkey = String(rec.uri).split('/').pop()
    if (since && rkey <= since) continue
    const v = rec.value || {}
    for (const c of Array.isArray(v.checks) ? v.checks : []) {
      if (c?.verdict !== 'confirmed' || !c.claim) continue
      const sources = (c.sources || []).filter((x) => x?.stance === 'supports' && /^https?:\/\//.test(x.url || '')).slice(0, 3)
      if (sources.length < 2) continue
      // a digest or journal entry is linked; a conversation is only named, so nothing here leads toward a person
      const fromEntry = ['digest', 'journal'].includes(v.context) && /^https:\/\//.test(v.result || '')
      out.push({ rkey, uri: rec.uri, at: v.createdAt, claim: clean(c.claim, 400), sources: sources.map((x) => ({ url: x.url, quote: clean(x.quote, 300) })), where: fromEntry ? { url: v.result, context: v.context } : { conversation: true } })
    }
  }
  return out.sort((a, b) => a.rkey.localeCompare(b.rkey))
}

const monthTitle = (now) => `Claims autonomist checked: ${new Date(now).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })}`

function claimEntry(c) {
  const day = new Date(c.at || Date.now()).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  const where = c.where.conversation
    ? 'Found in a conversation on Bluesky.'
    : `Found while writing [its ${c.where.context === 'digest' ? 'digest' : 'journal entry'}](${c.where.url}). Run journal record: \`${c.uri}\`.`
  return `## ${c.claim.replace(/^#+\s*/, '')}
- Confirmed by autonomist on ${day}: two independent sites support it.
${c.sources.map((x) => `- [${siteName(x.url)}](${x.url})${x.quote ? `: “${x.quote}”` : ''}`).join('\n')}
- ${where}

**Checked by:** autonomist.
`
}

function claimsHeader(now) {
  return `# ${monthTitle(now)}

autonomist checks claims from the articles it reads and the conversations it's in against other sources. This page lists the ones it confirmed: supported by two independent sites. A source counts only if autonomist's own code fetched the page, where its publisher allows that, and found the cited words on it. The claim's own outlet doesn't count, nor a page that repeats it word for word. Its code writes this page from its public run journal.

Take each as provisional, as everything here. A member who checks one independently adds their name, the date and how they checked under **Checked by**. How autonomist works: [[${TERMS_TITLE}]].
`
}

// ---- The hourly step ------------------------------------------------------------------------------------------------

/** Keeps its terms page current and adds the claims it confirmed since the last run. Off without WIKI_URI. */
export async function runWiki({ env, kv, api, now = Date.now(), fetch: f = fetch }) {
  if (!env.WIKI_URI) return { skipped: 'no wiki configured' }
  const out = {}
  // its terms: written only when the code's text differs from the last one written
  const terms = termsText(env)
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', utf8.encode(terms)))].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('')
  if ((await kv.get('wiki:terms:hash')) !== hash) {
    const r = await writeNote({ env, kv, api, slug: TERMS_SLUG, title: TERMS_TITLE, content: terms, message: "autonomist's terms, written by its code from the rules it keeps.", now, fetch: f })
    out.terms = r
    if (r.written || r.unchanged) await kv.put('wiki:terms:hash', hash)
  } else out.terms = { unchanged: true }
  // the claims it confirmed since the last run, on this month's page
  const me = (await api.session()).did
  const since = (await kv.get('wiki:claims:cursor')) || ''
  const claims = await confirmedClaims(api, me, since)
  if (!claims.length) return { ...out, claims: { none: true } }
  const wikiRules = await readWiki(f, env.WIKI_URI)
  const fine = claims.filter((c) => !personDataProblem(claimEntry(c), wikiRules, secretsOf(env)))
  const title = monthTitle(now)
  const r = await writeNote({
    env, kv, api, slug: toNoteSlug(title), title, now, fetch: f,
    message: `${fine.length} claim${fine.length === 1 ? '' : 's'} autonomist's fact-checks confirmed, from its run journal.`,
    content: (current) => {
      const base = current ?? claimsHeader(now)
      const fresh = fine.filter((c) => !base.includes(`## ${c.claim.replace(/^#+\s*/, '')}\n`))
      return fresh.length ? `${base.trimEnd()}\n\n${fresh.map(claimEntry).join('\n')}` : null
    },
  })
  out.claims = { ...r, found: claims.length, kept: fine.length }
  // past these, whether written or already there; a refusal or a wait leaves them for the next run
  if (r.written || r.unchanged) await kv.put('wiki:claims:cursor', claims[claims.length - 1].rkey)
  return out
}
