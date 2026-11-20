// lec-core.cjs: the engine's model. A limited-equity co-op over time, a member against renting and
// owning a condo, and a federation of financially isolated co-ops sharing a pool.
//
// Jason, 2026-11-20: the split between members and the commons is "a governance question for each
// coop"; a federation should "firewall financial risk but also ... provision different risk models
// for networked learning"; "It's a balance between autonomous risk and the protection that comes
// with collectivization - that should be fluid." And: the model, "updated live and made public -
// should be the nervous system for the federation." See ../tool/lec-engine.md.
//
// Annual steps. Every default is a SCENARIO unless its comment cites a source. Written to run both
// in Node (require) and in a browser (window.LEC), so the public page can run the same code.
'use strict'
;(function (root) {

const payment = (P, r, n) => (P <= 0 || n <= 0) ? 0 : (r === 0 ? P / n : P * r / (1 - Math.pow(1 + r, -n)))

function rng(seed) { // mulberry32
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
function normal(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()) }

// ---- defaults (the worked building: an 8-unit listing, 6.27% cap; all SCENARIO) ----
const BUILDING = { units: 8, price: 2400000, repairs: 40000, noi0: 150480, opexRatio: 0.40, reserve0: 0.03 }
const STACK = { senior: 0.70, seniorRate: 0.05, seniorYears: 30, resetYears: 10, junior: 0.20, juniorRate: 0.02, member: 0.10 }
// Governance: each co-op's own choices (Jason: the split is per co-op)
const GOV = {
  paydownToMembers: 1,      // share of principal paid credited to members' accounts
  appreciationToMembers: 0, // share of value gains credited to members (0 = classic limited equity)
  index: 0.03,              // yearly indexation of the member share
  savings: 0.05,            // protective savings, share of market gross rent
  pooled: 0.5,              // share of savings sent to the federation pool (0 = autonomous)
  chargeCap: 1.0,           // charges never exceed this multiple of market rent
  maxLTV: 0.75,             // refinancing ceiling for paying leaving members (senior and refinanced debt
                            // over value; the junior solidarity loan is subordinate and not counted)
  turnover: 1 / 7,          // share of homes changing hands a year
}
const MARKET = { rentGrowth: 0.03, opexGrowth: 0.03, capDrift: 0, vacancy: 0.02 }

// ---- one co-op ----
// path(t) supplies the market each year: { rate, rentIndex } (rentIndex multiplies gross rent)
function makeCoop(b, s, g, m) {
  const need = b.price + b.repairs + b.price * b.reserve0
  const gross0 = b.noi0 / (1 - b.opexRatio)
  const c = {
    b, s, g, m, need, gross0, opex0: gross0 - b.noi0, cap0: b.noi0 / b.price,
    tranches: [
      { name: 'senior', bal: need * s.senior, rate: s.seniorRate, left: s.seniorYears, io: false, reset: s.resetYears },
      { name: 'junior', bal: need * s.junior, rate: s.juniorRate, left: 30, io: true },
    ],
    buyIn0: need * s.member / b.units,
    reserve: b.price * b.reserve0,
    acct: need * s.member / b.units, // average member account
    deferred: 0, poolDebt: [], alive: true, value: b.price, t: 0,
    contributed: 0, aidUsed: 0, distressYears: 0,
  }
  return c
}
const debtTotal = c => c.tranches.reduce((a, x) => a + x.bal, 0)
const seniorDebt = c => c.tranches.filter(x => x.name !== 'junior').reduce((a, x) => a + x.bal, 0)

// One year's regular costs and charges, before shocks are drawn on reserves.
// Returns the cash position; the caller settles shortfalls (reserve, pool, default).
function coopYear(c, mk, shock) {
  const { b, s, g, m } = c
  c.t += 1; const t = c.t
  const grossMkt = c.gross0 * mk.rentIndex
  const opex = c.opex0 * Math.pow(1 + m.opexGrowth, t)
  const cap = c.cap0 + m.capDrift * t
  const prevValue = c.value
  c.value = Math.max(0, (grossMkt - opex) / cap)
  // debt service; the senior reprices at its reset year
  let interest = 0, principal = 0
  for (const tr of c.tranches) {
    if (tr.reset && t === tr.reset + 1) tr.rate = mk.rate
    const i = tr.bal * tr.rate
    const p = tr.io ? 0 : Math.min(tr.bal, payment(tr.bal, tr.rate, tr.left) - i)
    tr.bal -= p; if (!tr.io) tr.left = Math.max(1, tr.left - 1)
    interest += i; principal += p
  }
  // repayments to the pool (5-year loans)
  let poolRepay = 0
  for (const L of c.poolDebt) { if (L.left > 0) { const pm = payment(L.bal, L.rate, L.left); L.bal = L.bal * (1 + L.rate) - pm; L.left -= 1; poolRepay += pm } }
  c.poolDebt = c.poolDebt.filter(L => L.left > 0 && L.bal > 1)
  const save = g.savings * grossMkt
  const regular = opex + interest + principal + poolRepay + save
  const vac = m.vacancy + (shock.vacancy || 0)
  const occupied = b.units * (1 - vac)
  const marketRent = grossMkt / b.units
  const charge = Math.min(regular / occupied, g.chargeCap * marketRent) // per home a year
  const collected = charge * occupied
  c.lastCollected = collected
  const toPool = save * g.pooled
  c.reserve += save - toPool
  c.contributed += toPool
  // members' accounts: indexation, credited paydown and appreciation
  const credit = (principal * g.paydownToMembers + Math.max(0, c.value - prevValue) * g.appreciationToMembers) / b.units
  const buyIn = c.buyIn0 * Math.pow(1 + g.index, t)
  c.acct = c.acct * (1 + g.index) + credit
  // turnover: leavers are paid their accounts; newcomers pay the indexed buy-in; the gap is
  // refinanced up to maxLTV, and whatever does not fit waits (deferred exits)
  const gap = g.turnover * b.units * Math.max(0, c.acct - buyIn) + c.deferred
  const room = Math.max(0, g.maxLTV * c.value - seniorDebt(c))
  const draw = Math.min(gap, room)
  if (draw > 0) c.tranches.push({ name: 'refi' + t, bal: draw, rate: mk.rate, left: s.seniorYears, io: false })
  c.deferred = gap - draw
  c.acct = (1 - g.turnover) * c.acct + g.turnover * buyIn
  const shortfall = (regular - collected) + (shock.cost || 0)
  const row = { t, value: c.value, debt: debtTotal(c), marketRent, charge, ds: interest + principal, dscr: (grossMkt * (1 - vac) - opex) / (interest + principal), credit, acct: c.acct, buyIn, deferred: c.deferred, reserve: c.reserve, shortfall, toPool, rate: mk.rate }
  return { row, shortfall, toPool }
}

// Settle a shortfall in order: the co-op's own reserve; a one-off assessment on members (up to
// assessShare of a year's charges); a refinancing draw within maxLTV; the federation pool, if
// any; otherwise the co-op fails and its lender takes the building.
function settle(c, shortfall, pool, F, rate) {
  c.reserve -= shortfall
  if (c.reserve >= 0) return
  const A = F ? F.assessShare : 0.1
  const assess = Math.min(-c.reserve, A * (c.lastCollected || 0))
  c.reserve += assess; c.assessed = (c.assessed || 0) + assess
  if (c.reserve >= 0) return
  const room = Math.max(0, c.g.maxLTV * c.value - seniorDebt(c))
  const draw = Math.min(-c.reserve, room)
  if (draw > 0) { c.tranches.push({ name: 'repair' + c.t, bal: draw, rate: rate || c.s.seniorRate, left: c.s.seniorYears, io: false }); c.reserve += draw }
  if (c.reserve >= 0) return
  const need = -c.reserve
  let aid = 0
  if (pool && F) {
    const cap = Math.min(F.aidShare * pool.bal, F.aidMultiple * c.contributed)
    aid = Math.max(0, Math.min(need, cap))
    if (aid > 0) { pool.bal -= aid; c.poolDebt.push({ bal: aid, rate: F.poolRate, left: 5 }); c.aidUsed += aid; c.reserve += aid; c.distressYears += 1 }
  }
  if (c.reserve < -1) { c.alive = false; c.failYear = c.t; if (pool) pool.lost += c.poolDebt.reduce((a, L) => a + L.bal, 0) }
}

// Deterministic single co-op along a market path (array of { rate, rentIndex }).
function runCoop(opts = {}) {
  const b = { ...BUILDING, ...(opts.building || {}) }, s = { ...STACK, ...(opts.stack || {}) }
  const g = { ...GOV, ...(opts.gov || {}) }, m = { ...MARKET, ...(opts.market || {}) }
  const T = opts.years || 15
  const path = opts.path || Array.from({ length: T }, (_, i) => ({ rate: s.seniorRate, rentIndex: Math.pow(1 + m.rentGrowth, i + 1) }))
  const c = makeCoop(b, s, g, m)
  const rows = []
  for (let t = 0; t < T; t++) {
    const { row, shortfall } = coopYear(c, path[t], {})
    settle(c, shortfall, null, null, path[t].rate)
    row.reserve = c.reserve; row.alive = c.alive
    rows.push(row)
  }
  // the account of one member who joins at year 0 and leaves at year t
  let own = c.buyIn0
  const ownAcct = rows.map(r => (own = own * (1 + g.index) + r.credit))
  return { c, rows, ownAcct, buyIn0: c.buyIn0, need: c.need }
}

// ---- a member with options: co-op vs renting vs a comparable condo ----
// Same starting wealth (the condo's down payment and closing costs) and the same yearly budget
// (the dearest of the three); whatever a path does not spend on housing is invested.
const HOUSEHOLD = {
  condoPrice: 350000,   // the sibling building's 2023 arm's-length sale (Norfolk assessment data)
  down: 0.20, closing: 0.03, mortgageRate: 0.065, mortgageYears: 30,
  taxRate: 0.0123,      // Norfolk, $1.23 per $100 effective 2024-07-01 (City FAQ); FY27 not checked
  condoFee: 450 * 12, maintenance: 0.01, insurance: 600, sellCost: 0.07, portfolio: 0.06,
}
function compare(run, H0 = {}, years) {
  const H = { ...HOUSEHOLD, ...H0 }
  const T = years || run.rows.length
  const W0 = H.condoPrice * (H.down + H.closing)
  const loan = H.condoPrice * (1 - H.down), pmt = payment(loan, H.mortgageRate, H.mortgageYears)
  let bal = loan, invR = W0, invC = 0, invK = W0 - run.buyIn0 // the condo buyer spent W0 at closing
  const v0 = run.c.b.price
  let condoV = H.condoPrice
  const out = []
  for (let t = 0; t < T; t++) {
    const r = run.rows[t]
    const idx = r.value / v0
    const prevV = condoV; condoV = H.condoPrice * idx
    const rent = r.marketRent
    const fee = H.condoFee * Math.pow(1.03, t + 1)
    const condoCost = pmt + H.taxRate * condoV + fee + H.maintenance * prevV + H.insurance
    bal = bal * (1 + H.mortgageRate) - pmt
    const coop = r.charge
    const budget = Math.max(rent, condoCost, coop)
    invR = invR * (1 + H.portfolio) + (budget - rent)
    invC = invC * (1 + H.portfolio) + (budget - condoCost)
    invK = invK * (1 + H.portfolio) + (budget - coop)
    out.push({ t: t + 1, rent, condoCost, coop, renter: invR, condo: condoV * (1 - H.sellCost) - bal + invC, member: run.ownAcct[t] + invK })
  }
  return out
}

// ---- the federation ----
const FED = {
  n: 24, years: 15, runs: 400, seed: 1,
  architecture: 'pool',   // 'isolated' (no pool), 'pool' (firewalled co-ops + shared pool),
                          // 'merged' (everything pooled, no caps, and one blanket loan: one default takes all)
  poolSeed: 0.01,         // the pool's starting capital, as a share of the federation's total purchase cost
  assessShare: 0.10,      // the most a co-op will assess its members in a year, share of a year's charges
  aidShare: 0.25,         // most a co-op can draw in a year, as a share of the pool
  aidMultiple: 4,         // ... and as a multiple of what it has contributed
  poolRate: 0.03,
  rate0: 0.05, rateSigma: 0.008, rateRevert: 0.2, rateFloor: 0.025,
  regionalP: 0.07, regionalDrop: 0.10, // a year in which market rents fall, recovering over 3 years
  repairP: 0.06, repairMin: 0.01, repairMax: 0.08, // share of value, idiosyncratic
  vacancyP: 0.05, vacancyHit: 0.15,
  shockScale: 1,
  learning: 'none',       // 'none', 'survivors' (copy live peers only), 'public' (the ledger shows failures)
  learnEvery: 3, mutate: 0.05,
  minDSCR: 1.15,          // underwriting gate at purchase
  chargeCap: 1.0,         // members pay at most this multiple of market rent before they leave
  regions: 1,             // independent rental markets the federation spans (1 = one city)
  menu: { senior: [0.6, 0.7, 0.8], savings: [0.03, 0.05, 0.08], pooled: [0, 0.25, 0.5, 0.75, 1], appreciationToMembers: [0, 0.1, 0.25], paydownToMembers: [0.5, 1] },
  pooledFixed: null,      // a number forces every co-op's pooled share (the fluid dial, federation-wide)
}
const pick = (r, arr) => arr[Math.floor(r() * arr.length)]
const POLICY_KEYS = ['savings', 'pooled', 'appreciationToMembers', 'paydownToMembers']

function federationRun(F, seed) {
  const r = rng(seed)
  const coops = []
  let rejected = 0
  for (let i = 0; i < F.n; i++) {
    // the federation buys only what underwrites: DSCR at purchase of at least minDSCR
    let units, cap, noi, senior, dscr0
    do {
      units = 6 + Math.floor(r() * 19)
      cap = 0.05 + r() * 0.02
      noi = units * (14000 + r() * 6000)
      senior = pick(r, F.menu.senior)
      const need = (noi / cap) * (1 + 0.02 + BUILDING.reserve0)
      dscr0 = noi / (payment(need * senior, F.rate0, STACK.seniorYears) + need * (0.9 - senior) * STACK.juniorRate)
      if (dscr0 < F.minDSCR) rejected += 1
    } while (dscr0 < F.minDSCR && rejected < 10000)
    const gov = { ...GOV, savings: pick(r, F.menu.savings), pooled: F.pooledFixed ?? pick(r, F.menu.pooled), appreciationToMembers: pick(r, F.menu.appreciationToMembers), paydownToMembers: pick(r, F.menu.paydownToMembers) }
    gov.chargeCap = F.chargeCap
    if (F.architecture === 'isolated') gov.pooled = 0
    if (F.architecture === 'merged') gov.pooled = 1
    const c = makeCoop({ ...BUILDING, units, price: noi / cap, repairs: 0.02 * noi / cap, noi0: noi }, { ...STACK, senior, junior: 0.9 - senior, seniorRate: F.rate0 }, gov, { ...MARKET })
    c.score = 0; c.startAcct = c.acct; c.region = Math.floor(r() * F.regions)
    coops.push(c)
  }
  const pooledArch = F.architecture !== 'isolated'
  const pool = pooledArch ? { bal: F.poolSeed * coops.reduce((a, c) => a + c.need, 0), lost: 0 } : null
  const FF = F.architecture === 'merged' ? { ...F, aidShare: 1, aidMultiple: Infinity } : F
  const ledger = {} // public record: per policy value, co-op-years and failures
  const note = (c, failed) => { for (const k of POLICY_KEYS) { const key = k + ':' + c.g[k]; const e = ledger[key] || (ledger[key] = { years: 0, fails: 0 }); e.years += 1; if (failed) e.fails += 1 } }
  let rate = F.rate0
  const regional = Array(F.regions).fill(1), recover = Array(F.regions).fill(0)
  for (let t = 0; t < F.years; t++) {
    rate = Math.max(F.rateFloor, rate + F.rateRevert * (F.rate0 - rate) + F.rateSigma * normal(r))
    for (let q = 0; q < F.regions; q++) {
      if (r() < F.regionalP * F.shockScale) { regional[q] *= 1 - F.regionalDrop; recover[q] = 3 }
      else if (recover[q] > 0) { regional[q] = Math.min(1, regional[q] / (1 - F.regionalDrop / 3)); recover[q] -= 1 }
    }
    if (pool) pool.bal *= 1 + F.poolRate
    for (const c of coops) {
      if (!c.alive) continue
      const shock = {}
      if (r() < F.repairP * F.shockScale) shock.cost = c.value * (F.repairMin + r() * (F.repairMax - F.repairMin))
      if (r() < F.vacancyP * F.shockScale) shock.vacancy = F.vacancyHit
      const mk = { rate, rentIndex: Math.pow(1 + c.m.rentGrowth, c.t + 1) * regional[c.region] }
      const prevAcct = c.acct
      const { row, shortfall, toPool } = coopYear(c, mk, shock)
      if (pool) pool.bal += toPool
      settle(c, shortfall, pool, FF, rate)
      // members' gain this year, per unit of buy-in: account growth plus charges below market
      c.score = 0.7 * c.score + 0.3 * (((c.acct - prevAcct) + Math.max(0, row.marketRent - row.charge)) / row.buyIn)
      note(c, !c.alive)
    }
    if (F.architecture === 'merged' && coops.some(c => !c.alive)) for (const c of coops) if (c.alive) { c.alive = false; c.failYear = c.t }
    if (F.learning !== 'none' && (t + 1) % F.learnEvery === 0) {
      const live = coops.filter(c => c.alive)
      const failRate = c => POLICY_KEYS.reduce((a, k) => { const e = ledger[k + ':' + c.g[k]]; return a + (e ? (e.fails + 0.5) / (e.years + 10) : 0.05) }, 0) / POLICY_KEYS.length
      for (const c of live) {
        const peer = live[Math.floor(r() * live.length)]
        if (peer === c) continue
        let mine = c.score, theirs = peer.score
        if (F.learning === 'public') { mine -= failRate(c) * (c.acct / c.buyIn0); theirs -= failRate(peer) * (peer.acct / peer.buyIn0) }
        const fixed = k => k === 'pooled' && (F.architecture !== 'pool' || F.pooledFixed != null)
        if (theirs > mine && r() < 0.5) for (const k of POLICY_KEYS) if (!fixed(k)) c.g[k] = peer.g[k]
        if (r() < F.mutate) { const k = pick(r, POLICY_KEYS); if (!fixed(k)) c.g[k] = pick(r, F.menu[k]) }
      }
    }
  }
  const failed = coops.filter(c => !c.alive)
  const live = coops.filter(c => c.alive)
  const homesLost = failed.reduce((a, c) => a + c.b.units, 0), homes = coops.reduce((a, c) => a + c.b.units, 0)
  const policy = {}
  for (const k of POLICY_KEYS) policy[k] = live.length ? live.reduce((a, c) => a + c.g[k], 0) / live.length : NaN
  return {
    failures: failed.length, homesLost, homes, rejected,
    failedPolicies: failed.map(c => ({ senior: c.s.senior, cap: c.cap0, ...Object.fromEntries(POLICY_KEYS.map(k => [k, c.g[k]])), year: c.failYear })),
    anyFail: failed.length > 0, systemic: failed.length >= F.n / 4,
    deferred: live.reduce((a, c) => a + c.deferred, 0) / Math.max(1, live.length),
    memberAcct: live.length ? live.reduce((a, c) => a + c.acct / c.buyIn0, 0) / live.length : 0,
    aidYears: coops.reduce((a, c) => a + c.distressYears, 0),
    pool: pool ? pool.bal : 0, poolLost: pool ? pool.lost : 0, policy,
  }
}

function federation(F0 = {}) {
  const F = { ...FED, ...F0, menu: { ...FED.menu, ...(F0.menu || {}) } }
  const res = []
  for (let k = 0; k < F.runs; k++) res.push(federationRun(F, F.seed * 100003 + k))
  const mean = f => res.reduce((a, x) => a + f(x), 0) / res.length
  const pol = {}
  for (const k of POLICY_KEYS) pol[k] = mean(x => isNaN(x.policy[k]) ? 0 : x.policy[k])
  return {
    F, runs: res.length,
    failures: mean(x => x.failures), homesLostShare: mean(x => x.homesLost / x.homes),
    pAnyFail: mean(x => x.anyFail ? 1 : 0), pSystemic: mean(x => x.systemic ? 1 : 0),
    worstHomesLost: Math.max(...res.map(x => x.homesLost / x.homes)),
    memberAcct: mean(x => x.memberAcct), aidYears: mean(x => x.aidYears), deferred: mean(x => x.deferred),
    policy: pol,
  }
}

const api = { payment, rng, BUILDING, STACK, GOV, MARKET, HOUSEHOLD, FED, makeCoop, coopYear, runCoop, compare, federation, federationRun }
if (typeof module !== 'undefined' && module.exports) module.exports = api
else root.LEC = api
})(typeof window !== 'undefined' ? window : globalThis)
