import { test } from 'node:test'
import assert from 'node:assert/strict'
import { p256 } from '@noble/curves/p256'
import { secp256k1 } from '@noble/curves/secp256k1'
import { base32Encode } from '@pdsjs/core/crypto'
import { publicKeyToDidKey } from '@pdsjs/core/plc'
import { cborEncodeDagCbor } from '@pdsjs/core/repo'
import { parseArgs, checkDidKey, newSigningKey, genesis } from '../scripts/birth.mjs'

const recovery = publicKeyToDidKey(p256.getPublicKey(p256.utils.randomPrivateKey(), true), 'p256')
const sha256 = async (b) => new Uint8Array(await crypto.subtle.digest('SHA-256', b))

test('defaults are autonomist; another agent passes its own', () => {
  const a = parseArgs([])
  assert.equal(a.handle, 'autonomist.jason-edelman.org')
  assert.equal(a.pds, 'https://pds.autonomist.jason-edelman.org')
  assert.equal(a.site, 'https://autonomist.jason-edelman.org')
  const b = parseArgs(['--handle', 'siren.example.org', '--pds', 'https://pds.siren.example.org/'])
  assert.equal(b.pds, 'https://pds.siren.example.org')
  assert.equal(b.site, 'https://siren.example.org')
  assert.throws(() => parseArgs(['--password', 'x']), /unknown argument/)
})

test('the recovery key must be a real public did:key', () => {
  assert.equal(checkDidKey(recovery), recovery)
  const k = publicKeyToDidKey(secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey(), true), 'secp256k1')
  assert.equal(checkDidKey(k), k)
  assert.throws(() => checkDidKey(null))
  assert.throws(() => checkDidKey('did:plc:abc'))
  assert.throws(() => checkDidKey('did:key:zDnaeBAD'))
  // right prefix and length, but not a point on the curve
  const bad = new Uint8Array(33).fill(0xff); bad[0] = 0x02
  assert.throws(() => checkDidKey(publicKeyToDidKey(bad, 'p256')))
})

test('genesis: recovery key first, a signature that verifies, and the DID is the hash of it', async () => {
  const signing = newSigningKey()
  assert.match(signing.didKey, /^did:key:zQ3s/)
  const { operation, did } = await genesis({ handle: 'autonomist.jason-edelman.org', pds: 'https://pds.autonomist.jason-edelman.org', recoveryDidKey: recovery, signing })
  assert.deepEqual(operation.rotationKeys, [recovery, signing.didKey])
  assert.deepEqual(operation.verificationMethods, { atproto: signing.didKey })
  assert.deepEqual(operation.alsoKnownAs, ['at://autonomist.jason-edelman.org'])
  assert.equal(operation.services.atproto_pds.endpoint, 'https://pds.autonomist.jason-edelman.org')
  assert.equal(operation.prev, null)
  const { sig, ...unsigned } = operation
  assert.match(sig, /^[A-Za-z0-9_-]{86}$/)
  assert.ok(secp256k1.verify(Buffer.from(sig, 'base64url'), await sha256(cborEncodeDagCbor(unsigned)), signing.publicKey, { lowS: true }))
  assert.match(did, /^did:plc:[a-z2-7]{24}$/)
  assert.equal(did, `did:plc:${base32Encode((await sha256(cborEncodeDagCbor(operation))).slice(0, 15))}`)
  // the signing key is never part of what's saved or sent to PLC
  assert.ok(!JSON.stringify(operation).includes(Buffer.from(signing.privateKey).toString('hex')))
})
