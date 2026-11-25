#!/usr/bin/env node
// Dry runs from the command line (worker/bot/dry.js). Asks the live Worker for one, and fetches what it produced as
// files. It talks to KV through wrangler, so it needs a Cloudflare token with access to the account (in a cloud
// session the proxy supplies it: CLOUDFLARE_API_TOKEN=proxy-injected).
//
//   node scripts/dry-run.mjs request [digest,questions | dream | notes | all]
//   node scripts/dry-run.mjs list
//   node scripts/dry-run.mjs fetch [<id> | latest] [--wait]     writes dry-runs/<id>/ (git-ignored)
//
// fetch --wait polls until a dry run newer than the request appears (up to twenty minutes).
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8')
const NS = toml.match(/binding = "KV"\s*\nid = "([0-9a-f]{32})"/)?.[1]
if (!NS) { console.error('No KV namespace in wrangler.toml.'); process.exit(1) }
const SITE = 'https://autonomist.jason-edelman.org'

function kv(args) {
  const r = spawnSync('npx', ['wrangler', 'kv', 'key', ...args, '--namespace-id', NS, '--remote'], { encoding: 'utf8', env: { ...process.env, CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || 'proxy-injected' }, maxBuffer: 64 * 1024 * 1024 })
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').split('\n').filter((l) => /error|✘/i.test(l)).join(' ').slice(0, 300) || 'wrangler failed')
  return r.stdout
}
const getJson = (key) => { try { return JSON.parse(kv(['get', key])) } catch { return null } }
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms))

const [cmd = 'list', arg, flag] = process.argv.slice(2)

if (cmd === 'request') {
  const what = arg || 'digest,questions'
  kv(['put', 'dryrun:request', JSON.stringify({ what, at: new Date().toISOString(), by: 'scripts/dry-run.mjs' })])
  console.log(`Requested a dry run of ${what}. The next five-minute run picks it up; then: node scripts/dry-run.mjs fetch latest --wait`)
} else if (cmd === 'list') {
  for (const x of getJson('dryrun:index') || []) console.log(`${x.id}  ${x.what.join(',')}  ${Math.round(x.ms / 1000)}s  $${x.spend}  ${x.posts} posts, ${x.writes} records${x.ok ? '' : '  (a step failed)'}`)
} else if (cmd === 'fetch') {
  const wait = flag === '--wait' || arg === '--wait'
  let id = arg && arg !== 'latest' && arg !== '--wait' ? arg : null
  // with --wait, the dry run to fetch is the first one newer than what's listed now, once nothing is pending
  const before = wait ? (getJson('dryrun:index') || [])[0]?.id : null
  const deadline = Date.now() + 20 * 60_000
  while (!id) {
    const top = (getJson('dryrun:index') || [])[0]
    const pending = getJson('dryrun:request') || getJson('dryrun:running')
    if (top && (!wait || (!pending && top.id !== before))) id = top.id
    else if (!wait || Date.now() > deadline) { console.error(wait ? 'No new dry run yet.' : 'No dry runs yet.'); process.exit(1) }
    else { process.stdout.write('.'); await sleep(30_000) }
  }
  const a = getJson(`dryrun:result:${id}`)
  if (!a) { console.error(`No dry run ${id} (they keep two weeks).`); process.exit(1) }
  const dir = join('dry-runs', id)
  mkdirSync(join(dir, 'pages'), { recursive: true })
  writeFileSync(join(dir, 'artifact.json'), JSON.stringify(a, null, 2))
  // pages as published, with the live site's stylesheet so they read the same opened from disk
  for (const [rkey, html] of Object.entries(a.pages || {})) writeFileSync(join(dir, 'pages', `${rkey}.html`), html.replaceAll('href="/css/', `href="${SITE}/css/`))
  // the email subscribers would have got, as it would go to Resend (its unsubscribe link is Resend's placeholder)
  if (a.email) { writeFileSync(join(dir, 'email.html'), a.email.html); writeFileSync(join(dir, 'email.txt'), `Subject: ${a.email.subject}\n\n${a.email.text}\n`) }
  const lines = [
    `# Dry run ${a.id}`,
    '',
    `${a.what.join(', ')} · ${a.at} · ${Math.round(a.ms / 1000)}s · $${a.spend} · nothing was published or posted`,
    '',
    '## Steps',
    ...a.steps.map((s) => `- ${s.ok ? '' : '**failed** '}${s.name} (${Math.round(s.ms / 1000)}s): ${s.ok ? JSON.stringify(s.result) : s.error}`),
    '',
    '## Posts it would have made',
    ...(a.posts.length ? a.posts.map((p) => `- ${p.text.replace(/\n+/g, ' / ')}${p.card ? ` [card: ${p.card.uri}]` : ''}`) : ['(none)']),
    '',
    '## The email subscribers would have got',
    a.email ? `“${a.email.subject}”: email.html and email.txt` : '(none)',
    '',
    '## Records it would have written',
    ...(a.writes.length ? a.writes.map((w) => `- ${w.nsid} ${w.collection || ''}${w.rkey ? `/${w.rkey}` : ''}${w.record?.title ? `: ${w.record.title}` : w.record?.reflection ? `: ${w.record.reflection}` : ''}`) : ['(none)']),
    '',
    ...(a.notes ? ['## What it read', ...a.notes.flatMap((s) => [`### ${s.label} (shared by ${s.sharers})`, ...s.articles.map((x) => `- ${x.outlet}: ${x.title} (${x.url})\n  ${x.gist}${x.quotes?.length ? `\n  ${x.quotes.map((q) => `“${q}”`).join(' ')}` : ''}`)])] : []),
  ]
  writeFileSync(join(dir, 'summary.md'), `${lines.join('\n')}\n`)
  console.log(`Wrote ${dir}/ (summary.md, artifact.json${Object.keys(a.pages || {}).length ? ', pages/' : ''}${a.email ? ', email.html, email.txt' : ''})`)
} else {
  console.error('Usage: node scripts/dry-run.mjs request [what] | list | fetch [id|latest] [--wait]')
  process.exit(1)
}
