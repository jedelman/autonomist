import { test } from 'node:test'
import assert from 'node:assert/strict'
import LEC from '../model/lec-core.cjs'

test('underwrite reproduces the worked building', () => {
  const u = LEC.underwrite({ units: 8, price: 2400000, capRate: 0.0627, repairs: 40000 })
  assert.equal(Math.round(u.noi), 150480)
  assert.equal(u.stacks.commons.dscr.toFixed(2), '1.24')
  assert.equal(Math.round(u.stacks.commons.cashAfterDebt), 29612)
  assert.equal(u.stacks.bank.dscr.toFixed(2), '1.02')
  assert.equal(u.stacks.cdfi.dscr.toFixed(2), '0.90')
  assert.ok(u.coordinationDividend > 0)
})

test('pressure: a buyer at the ask needs more income when DSCR at the ask is under target', () => {
  const p = LEC.pressure({ price: 1900000, noi: 104964, costShare: 0.4 })
  assert.equal(p.dscrAtAsk.toFixed(2), '0.91')
  assert.ok(p.riseNeeded > 0.36 && p.riseNeeded < 0.38)
  assert.ok(p.rentRiseNeeded < p.riseNeeded)
  assert.ok(p.priceThatWorks < 1900000)
})

test('one co-op stays solvent on defaults and members build accounts', () => {
  const run = LEC.runCoop({ years: 15 })
  assert.ok(run.rows.every((r) => r.alive))
  assert.ok(run.ownAcct[6] > run.buyIn0 * 2)
})

test('federation runs are reproducible for a seed', () => {
  const a = LEC.federation({ runs: 30, seed: 7, shockScale: 2 })
  const b = LEC.federation({ runs: 30, seed: 7, shockScale: 2 })
  assert.deepEqual([a.homesLostShare, a.pAnyFail], [b.homesLostShare, b.pAnyFail])
})
