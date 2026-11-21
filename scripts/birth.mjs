#!/usr/bin/env node
// Birth: give an agent its own atproto account on its own pds.js PDS.
//
//   PDS_PASSWORD=... node scripts/birth.mjs --recovery did:key:zDnae...
//
// The defaults are autonomist's. Another agent passes --handle and --pds.
//
// What it does, in this order:
//   1. checks the PDS is up and not yet initialized;
//   2. makes the account's signing key (secp256k1, the curve the reference PDS uses and some
//      verifiers require) in memory, and signs a did:plc genesis operation with it. The rotation
//      keys are [recovery, signing]: the recovery key comes first, so it can undo anything the
//      signing key signs;
//   3. gives the DID and the signing key to the PDS (/init, gated by PDS_PASSWORD). The signing key
//      is never written to disk: it lives in the PDS only. If it is lost, the recovery key rotates
//      in a new one;
//   4. registers the DID with the PLC directory. Init comes first so a failure there can't leave a
//      DID whose signing key nobody holds. The signed operation (public data) is saved, so a failed
//      registration can be retried with --retry-plc <file>;
//   5. checks the account answers, the handle resolves, and asks the relay to crawl the PDS.
//
// The recovery key is a P-256 key whose private half the agent's steward holds (in their password
// manager), made at https://admin.jason-edelman.org/keys/. Only its public did:key comes here.
import { writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { secp256k1 } from '@noble/curves/secp256k1'
import { p256 } from '@noble/curves/p256'
import { base32Encode, bytesToHex, P256_MULTICODEC, SECP256K1_MULTICODEC } from '@pdsjs/core/crypto'
import { base58btcDecode, publicKeyToDidKey, signPlcOperationObject } from '@pdsjs/core/plc'
import { cborEncodeDagCbor } from '@pdsjs/core/repo'

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))

export function parseArgs(argv) {
  const o = { handle: 'autonomist.jason-edelman.org', pds: 'https://pds.autonomist.jason-edelman.org', plc: 'https://plc.directory', relay: 'https://bsky.network', recovery: null, site: null, out: null, dryRun: false, skipPlc: false, skipRelay: false, retryPlc: null }
  const flags = { '--handle': 'handle', '--pds': 'pds', '--plc': 'plc', '--relay': 'relay', '--recovery': 'recovery', '--site': 'site', '--out': 'out', '--retry-plc': 'retryPlc' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (flags[a] && argv[i + 1] !== undefined) o[flags[a]] = argv[++i]
    else if (a === '--dry-run') o.dryRun = true
    else if (a === '--skip-plc') o.skipPlc = true
    else if (a === '--skip-relay') o.skipRelay = true
    else throw new Error(`unknown argument: ${a}`)
  }
  o.pds = o.pds.replace(/\/+$/, '')
  o.site ||= `https://${o.handle}`
  return o
}

// A public did:key, P-256 or secp256k1, with a point on its curve.
export function checkDidKey(didKey) {
  if (typeof didKey !== 'string' || !didKey.startsWith('did:key:z')) throw new Error('the recovery key must be a did:key (did:key:z...)')
  const bytes = base58btcDecode(didKey.slice('did:key:z'.length))
  const codec = bytes.slice(0, 2)
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
  const curve = same(codec, P256_MULTICODEC) ? p256 : same(codec, SECP256K1_MULTICODEC) ? secp256k1 : null
  if (!curve || bytes.length !== 35) throw new Error('the recovery key must be a compressed P-256 or secp256k1 did:key')
  curve.ProjectivePoint.fromHex(bytes.slice(2)) // throws if the point isn't on the curve
  return didKey
}

export function newSigningKey() {
  const privateKey = secp256k1.utils.randomPrivateKey()
  const publicKey = secp256k1.getPublicKey(privateKey, true)
  return {
    privateKey,
    publicKey,
    didKey: publicKeyToDidKey(publicKey, 'secp256k1'),
    // the shape @pdsjs/core's sign() takes for secp256k1: low-S, compact r||s over SHA-256
    signer: { curve: 'secp256k1', sign: async (data) => secp256k1.sign(await sha256(data), privateKey, { lowS: true }).toCompactRawBytes() },
  }
}

export async function genesis({ handle, pds, recoveryDidKey, signing }) {
  const operation = {
    type: 'plc_operation',
    rotationKeys: [recoveryDidKey, signing.didKey],
    verificationMethods: { atproto: signing.didKey },
    alsoKnownAs: [`at://${handle}`],
    services: { atproto_pds: { type: 'AtprotoPersonalDataServer', endpoint: pds } },
    prev: null,
  }
  const signed = await signPlcOperationObject(operation, signing.signer)
  // check the signature before anything leaves this machine
  const { sig, ...unsigned } = signed
  const raw = Uint8Array.from(Buffer.from(sig, 'base64url'))
  if (!secp256k1.verify(raw, await sha256(cborEncodeDagCbor(unsigned)), signing.publicKey, { lowS: true })) throw new Error('the genesis signature does not verify')
  // the DID is the hash of the whole signed operation
  const did = `did:plc:${base32Encode((await sha256(cborEncodeDagCbor(signed))).slice(0, 15))}`
  return { operation: signed, did }
}

async function call(method, url, body, headers = {}) {
  const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json', ...headers } : headers, body: body ? JSON.stringify(body) : undefined })
  const text = await res.text()
  let data = text
  try { data = JSON.parse(text) } catch {}
  return { ok: res.ok, status: res.status, data }
}

async function registerPlc(plc, did, operation) {
  const r = await call('POST', `${plc}/${did}`, operation)
  if (!r.ok) throw new Error(`PLC registration failed (${r.status}): ${JSON.stringify(r.data)}\nRetry with: --retry-plc <the saved operation file>`)
  const doc = await call('GET', `${plc}/${did}/data`)
  if (!doc.ok || doc.data?.rotationKeys?.[0] !== operation.rotationKeys[0]) throw new Error(`the PLC directory doesn't show the new DID yet (${doc.status})`)
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  const say = (s) => console.log(s)

  if (o.retryPlc) {
    const { did, operation } = JSON.parse(readFileSync(o.retryPlc, 'utf8'))
    await registerPlc(o.plc, did, operation)
    say(`registered ${did} with ${o.plc}`)
    return
  }

  const recoveryDidKey = checkDidKey(o.recovery)
  const password = process.env.PDS_PASSWORD
  if (!o.dryRun && !password) throw new Error('set PDS_PASSWORD in the environment (never on the command line)')

  if (!o.dryRun) {
    const status = await call('GET', `${o.pds}/status`)
    if (!status.ok) throw new Error(`the PDS at ${o.pds} isn't answering (${status.status})`)
    if (status.data?.initialized) throw new Error(`the PDS at ${o.pds} already holds ${status.data.did}`)
  }

  const signing = newSigningKey()
  const { operation, did } = await genesis({ handle: o.handle, pds: o.pds, recoveryDidKey, signing })
  const out = o.out || join(tmpdir(), `birth-${o.handle}.json`)
  writeFileSync(out, JSON.stringify({ did, operation }, null, 2) + '\n')
  say(`DID:              ${did}`)
  say(`handle:           ${o.handle}`)
  say(`PDS:              ${o.pds}`)
  say(`signing did:key:  ${signing.didKey}  (secp256k1; the private key goes to the PDS only)`)
  say(`recovery did:key: ${recoveryDidKey}  (first rotation key; its steward holds the private key)`)
  say(`genesis operation (public): ${out}`)
  if (o.dryRun) { say('\ndry run: nothing sent'); return }

  const init = await call('POST', `${o.pds}/init`, { did, privateKey: bytesToHex(signing.privateKey), handle: o.handle, curve: 'secp256k1', password })
  if (!init.ok || init.data?.did !== did) throw new Error(`/init failed (${init.status}): ${JSON.stringify(init.data)}`)
  say('\n1. the PDS holds the account')

  const session = await call('POST', `${o.pds}/xrpc/com.atproto.server.createSession`, { identifier: did, password })
  if (!session.ok || session.data?.did !== did) throw new Error(`the account doesn't answer createSession (${session.status}): ${JSON.stringify(session.data)}`)
  say('2. the account answers (createSession)')

  if (o.skipPlc) say('3. PLC registration skipped')
  else { await registerPlc(o.plc, did, operation); say(`3. ${o.plc} has the DID`) }

  const handle = await call('GET', `${o.site}/.well-known/atproto-did`)
  if (handle.ok && String(handle.data).trim() === did) say(`4. the handle resolves: ${o.site}/.well-known/atproto-did`)
  else say(`4. WARNING: ${o.site}/.well-known/atproto-did gave ${handle.status} ${String(handle.data).slice(0, 80)}; fix it before posting`)

  if (o.skipRelay) say('5. relay crawl skipped')
  else {
    const crawl = await call('POST', `${o.relay}/xrpc/com.atproto.sync.requestCrawl`, { hostname: new URL(o.pds).hostname })
    say(crawl.ok ? `5. asked ${o.relay} to crawl the PDS` : `5. WARNING: the relay answered ${crawl.status}: ${JSON.stringify(crawl.data)}`)
  }
  say(`\nborn: ${did} (${o.handle})`)
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(`birth: ${e.message}`); process.exit(1) })
