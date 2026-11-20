#!/usr/bin/env node
// Steward tools: invite codes, the access-request list, case-study proposals and saved results.
// Runs wrangler against the deployment's KV namespace (binding KV).
//
//   node scripts/invites.mjs create --label "who it's for" [--uses 3]
//   node scripts/invites.mjs list
//   node scripts/invites.mjs revoke AUTONOMIST-ABCDE-FGHJK     (or the hash that list prints)
//   node scripts/invites.mjs requests > ~/autonomist-requests.csv
//   node scripts/invites.mjs request-remove someone@example.org
//   node scripts/invites.mjs proposals
//   node scripts/invites.mjs proposal-delete <id>
//   node scripts/invites.mjs result-delete <id>
//
// Options: --local (wrangler dev's local KV instead of the deployed one), --config <file>,
// --dry-run (print the wrangler commands only).
//
// Codes are stored only as hashes, so a lost code can't be looked up: revoke it and make a new
// one. The requests CSV holds people's email addresses: keep it out of the repository.
import { execFileSync } from 'node:child_process'
import { newCode, inviteKey, sha256hex, csvField } from '../worker/invites.js'

const args = process.argv.slice(2)
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v }
const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true }
const config = flag('--config')
const local = has('--local')
const dry = has('--dry-run')
const [cmd, ...rest] = args

function wrangler(...a) {
  const full = ['wrangler', 'kv', ...a, '--binding', 'KV', local ? '--local' : '--remote', ...(config ? ['--config', config] : [])]
  if (dry) { console.error('npx ' + full.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')); return '' }
  return execFileSync('npx', full, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}
const listKeys = (prefix) => { const out = wrangler('key', 'list', '--prefix', prefix); return out ? JSON.parse(out) : [] }
const getJson = (key) => { const out = wrangler('key', 'get', key); try { return out ? JSON.parse(out) : null } catch { return null } }

async function main() {
  if (cmd === 'create') {
    const label = flag('--label') || ''
    const uses = Number(flag('--uses') || 3)
    const code = newCode()
    wrangler('key', 'put', await inviteKey(code), JSON.stringify({ label, max_uses: uses, created: new Date().toISOString().slice(0, 10) }))
    console.log(code)
    console.error(`Invite for ${label || '(no label)'}, good in ${uses} browsers. Shown once; it is stored only as a hash.`)
  } else if (cmd === 'list') {
    for (const k of listKeys('invite:')) {
      const rec = getJson(k.name) || {}
      console.log(`${k.name.slice(7, 23)}…  ${rec.label || ''}  uses ${rec.max_uses ?? '?'}  ${rec.created || ''}${rec.revoked ? '  REVOKED' : ''}`)
    }
  } else if (cmd === 'revoke') {
    const target = rest[0] || ''
    let key = await inviteKey(target)
    if (!key) {
      const match = listKeys('invite:').map((k) => k.name).filter((n) => n.slice(7).startsWith(target.replace(/…$/, '')))
      if (match.length !== 1) throw new Error(match.length ? 'That prefix matches more than one invite.' : 'No invite matches.')
      key = match[0]
    }
    wrangler('key', 'delete', key)
    console.error('Revoked.')
  } else if (cmd === 'requests') {
    console.log(['email', 'name', 'org', 'note', 'at'].join(','))
    for (const k of listKeys('waitlist:')) {
      const e = getJson(k.name)
      if (e) console.log([e.email, e.name, e.org, e.note, e.at].map(csvField).join(','))
    }
  } else if (cmd === 'request-remove') {
    wrangler('key', 'delete', `waitlist:${await sha256hex(String(rest[0] || '').trim().toLowerCase())}`)
    console.error('Removed.')
  } else if (cmd === 'proposals') {
    for (const k of listKeys('proposal:')) {
      const p = getJson(k.name)
      if (p) console.log(`\n# ${p.title}  (${p.id}, ${p.created})\n${p.summary}\nSources:\n${(p.sources || []).map((s) => '- ' + s).join('\n')}`)
    }
  } else if (cmd === 'proposal-delete') {
    wrangler('key', 'delete', `proposal:${rest[0]}`)
  } else if (cmd === 'result-delete') {
    wrangler('key', 'delete', `result:${rest[0]}`)
  } else {
    console.error('Commands: create, list, revoke, requests, request-remove, proposals, proposal-delete, result-delete. See the top of this file.')
    process.exit(1)
  }
}
main().catch((e) => { console.error(e.message || e); process.exit(1) })
