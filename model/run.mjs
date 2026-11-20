// run.mjs: runs the engine model and writes results.md and results.json beside it.
//   node model/run.mjs            (from the repo root)
// Every number in results.md comes from this script and lec-core.cjs; rerun it after any change.
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(import.meta.url)
const L = require('./lec-core.cjs')
const here = dirname(fileURLToPath(import.meta.url))
const RUNS = 400, SEED = 2026
const out = { generated: new Date().toISOString().slice(0, 10), runs: RUNS }
const md = []
const $ = x => '$' + Math.round(x).toLocaleString('en-US')
const pct = (x, d = 1) => (x * 100).toFixed(d) + '%'

md.push('# Results: the engine model', '')
md.push(`Generated ${out.generated} by \`model/run.mjs\` from \`model/lec-core.cjs\`. Every input is a SCENARIO`)
md.push('unless the code cites a source. The worked building is an 8-unit listing at a 6.27% cap rate. This is a')
md.push('mechanism model, not a forecast: it shows which design choices move risk and wealth, and by roughly how much.')
md.push('The tables regenerate on every run; the prose between them was written against these numbers, so reread it')
md.push('after changing an input.', '')

// 1. one co-op
const base = L.runCoop({ years: 15 })
md.push('## 1. One co-op, default governance', '')
md.push('Stack: 70% senior at 5% over 30 years (repriced at year 10), 20% junior at 2% interest-only, 10% member')
md.push(`equity (${$(base.buyIn0)} a home). Members get the paydown (no appreciation), the share is indexed at 3%, 5% of`)
md.push('market rent is saved (half to the federation pool), one home in seven turns over a year, and refinancing')
md.push('to pay leavers is capped at 75% of value (senior debt only). Rents and costs grow 3% a year.', '')
md.push('| year | value | debt | market rent /mo | charge /mo | average account | reserve |', '|---|---|---|---|---|---|---|')
for (const r of base.rows.filter(r => [1, 3, 5, 7, 10, 15].includes(r.t))) md.push(`| ${r.t} | ${$(r.value)} | ${$(r.debt)} | ${$(r.marketRent / 12)} | ${$(r.charge / 12)} | ${$(r.acct)} | ${$(r.reserve)} |`)
md.push('', `A member who joins at the start holds ${$(base.ownAcct[6])} after 7 years and ${$(base.ownAcct[14])} after 15.`, '')
out.coop = base.rows

// 2. the rate reset
md.push('## 2. Interest-rate risk at the senior reset (year 10)', '')
md.push('| rate at reset | charge /mo, year 10 | charge /mo, year 11 | market rent /mo, year 11 |', '|---|---|---|---|')
out.reset = []
for (const rr of [0.05, 0.065, 0.08]) {
  const path = Array.from({ length: 15 }, (_, i) => ({ rate: i >= 9 ? rr : 0.05, rentIndex: Math.pow(1.03, i + 1) }))
  const run = L.runCoop({ years: 15, path })
  const a = run.rows[9], b = run.rows[10]
  md.push(`| ${pct(rr)} | ${$(a.charge / 12)} | ${$(b.charge / 12)} | ${$(b.marketRent / 12)} |`)
  out.reset.push({ rate: rr, y10: a.charge, y11: b.charge, rent11: b.marketRent })
}
md.push('', 'Long fixed terms remove this risk; a 10-year reset is the conservative case.', '')

// 3. a member with options
md.push('## 3. A member with options: co-op vs renting vs a comparable condo', '')
md.push('Same starting wealth (a 20% down payment plus 3% closing on a $350,000 condo, the sibling building\'s 2023')
md.push('sale) and the same yearly budget; what a path does not spend on housing is invested. Condo: 6.5% 30-year')
md.push('mortgage, Norfolk\'s $1.23 per $100 tax (City FAQ, effective 2024-07-01), $450/mo fee, 1% maintenance,')
md.push('7% to sell. Co-op: the run above. No income taxes modeled. Net worth at the horizon:', '')
md.push('| rent growth | value growth (a year) | portfolio return | horizon | renter | condo owner | co-op member |', '|---|---|---|---|---|---|---|')
out.household = []
for (const g of [0.01, 0.03, 0.05]) for (const port of [0.06, 0.08]) {
  const run = L.runCoop({ years: 15, market: { rentGrowth: g } })
  const cmp = L.compare(run, { portfolio: port })
  for (const T of [7, 15]) {
    const x = cmp[T - 1], vg = Math.pow(run.rows[T - 1].value / run.c.b.price, 1 / T) - 1
    md.push(`| ${pct(g, 0)} | ${pct(vg)} | ${pct(port, 0)} | ${T} years | ${$(x.renter)} | ${$(x.condo)} | ${$(x.member)} |`)
    out.household.push({ rentGrowth: g, valueGrowth: vg, portfolio: port, T, ...x })
  }
}
md.push('', 'Read across a row: the co-op beats renting everywhere here. It beats the condo when values grow slowly or')
md.push('moderately, and loses to it when values boom, because the condo owner holds the appreciation with leverage.', '')

// 4. the federation
const fed = F => {
  const res = []
  for (let k = 0; k < RUNS; k++) res.push(L.federationRun({ ...L.FED, ...F, menu: { ...L.FED.menu, ...(F.menu || {}) } }, SEED * 100003 + k))
  const lost = res.map(x => x.homesLost / x.homes), n = res.length
  const m = lost.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(lost.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1))
  const pol = k => res.reduce((a, x) => a + (isNaN(x.policy[k]) ? 0 : x.policy[k]), 0) / n
  return { lost: m, se: sd / Math.sqrt(n), any: res.filter(x => x.anyFail).length / n, sys: res.filter(x => x.systemic).length / n, worst: Math.max(...lost), acct: res.reduce((a, x) => a + x.memberAcct, 0) / n, savings: pol('savings'), pooled: pol('pooled'), appreciation: pol('appreciationToMembers') }
}
const row = (label, s, extra = '') => `| ${label} | ${pct(s.lost)} (±${pct(s.se)}) | ${pct(s.any, 0)} | ${pct(s.sys, 1)} | ${pct(s.worst, 0)} |${extra}`
const head = (cols = '') => ['| case | homes lost (mean ± s.e.) | any co-op fails | a quarter or more fail | worst run |' + cols, '|---|---|---|---|---|' + cols.replace(/[^|]+\|/g, '---|')]
const STRESS = { base: { shockScale: 1, regionalDrop: 0.10 }, moderate: { shockScale: 2, regionalDrop: 0.10 }, severe: { shockScale: 1, regionalDrop: 0.25 } }
out.federation = {}

md.push('## 4. The federation', '')
md.push(`${L.FED.n} co-ops of 6–24 homes, bought at cap rates of 5–7% only if they underwrite (DSCR ≥ 1.15), held for`)
md.push(`${L.FED.years} years, ${RUNS} runs a case. Each co-op draws its own governance from a menu (senior share 60/70/80%,`)
md.push('savings 3/5/8% of rent, pooled share 0–100%, appreciation credited 0/10/25%, paydown credited 50/100%).')
md.push('Shocks: interest rates wander (mean-reverting around 5%); a regional rent drop hits in 7% of years and')
md.push('recovers over three; each co-op faces repair bills of 1–8% of value (6% of years) and vacancy spells (5% of')
md.push('years). A shortfall is met by the co-op\'s reserve, then a one-off assessment on members (up to 10% of a')
md.push('year\'s charges), then refinancing within 75% of value, then the pool, or the co-op fails and its lender')
md.push('takes the building.', '')
md.push('- **isolated:** no pool.')
md.push('- **firewalled pool:** each co-op is its own entity; it lends to the pool what it chooses to pool and may draw')
md.push('  up to a quarter of the pool, or four times what it has put in, in a year; draws are repaid over five years.')
md.push('- **merged:** one balance sheet and one blanket loan; everything pooled, no limits, and one default takes all.', '')

md.push('### 4.1 Architecture under stress', '', ...head())
out.federation.architecture = {}
for (const [sname, st] of Object.entries(STRESS)) for (const arch of ['isolated', 'pool', 'merged']) {
  const s = fed({ ...st, architecture: arch }); out.federation.architecture[sname + ':' + arch] = s
  md.push(row(`${sname}, ${arch === 'pool' ? 'firewalled pool' : arch}`, s))
}
md.push('', 'Merged fails least often, but when it fails, it fails whole. The firewalled pool fails more often, in')
md.push('pieces.', '')

md.push('### 4.2 One city or several (severe stress)', '', ...head())
out.federation.regions = {}
for (const regions of [1, 4]) for (const arch of ['isolated', 'pool', 'merged']) {
  const s = fed({ ...STRESS.severe, regions, architecture: arch }); out.federation.regions[regions + ':' + arch] = s
  md.push(row(`${regions === 1 ? 'one market' : 'four markets'}, ${arch === 'pool' ? 'firewalled pool' : arch}`, s))
}
md.push('', 'A firewall stops contagion, not a shock that hits everyone at once. Spread across independent markets, the')
md.push('firewalled pool beats merging in the tail; merging gains nothing from spread, because one default still takes all.', '')

md.push('### 4.3 The fluid dial: how much each co-op pools (firewalled)', '', ...head())
out.federation.dial = {}
for (const sname of ['moderate', 'severe']) for (const a of [0, 0.25, 0.5, 0.75, 1]) {
  const s = fed({ ...STRESS[sname], pooledFixed: a }); out.federation.dial[sname + ':' + a] = s
  md.push(row(`${sname}, pooled ${pct(a, 0)}`, s))
}
md.push('', 'The first quarter pooled does the most. The model does not price what autonomy buys (local control of')
md.push('reserves, room to experiment), so it will always favor pooling more; that judgment stays with each co-op.', '')

md.push('### 4.4 What else moves risk (firewalled, moderate stress unless noted)', '', ...head())
out.federation.levers = {}
for (const sen of [0.6, 0.7, 0.8]) { const s = fed({ ...STRESS.moderate, menu: { senior: [sen] } }); out.federation.levers['senior:' + sen] = s; md.push(row(`senior debt ${pct(sen, 0)} at purchase`, s)) }
for (const seed of [0, 0.01, 0.03]) { const s = fed({ ...STRESS.moderate, poolSeed: seed }); out.federation.levers['seed:' + seed] = s; md.push(row(`pool seeded with ${pct(seed, 0)} of purchase cost`, s)) }
for (const cc of [1.0, 1.1]) { const s = fed({ ...STRESS.severe, chargeCap: cc }); out.federation.levers['cap:' + cc] = s; md.push(row(`severe; members stay up to ${pct(cc, 0)} of market rent`, s)) }
md.push('', 'Leverage at purchase matters most: the patient junior money is the resilience lever, not only a cheap')
md.push('one. Members who will pay a little above market through a downturn (their accounts give them a reason)')
md.push('cut losses by more than half.', '')

md.push('### 4.5 Networked learning', '')
md.push('Every three years each co-op compares itself with a random peer and, half the time, copies a better peer\'s')
md.push('savings, pooled share and member credits (5% of the time it tries a random one). "Survivors" sees only co-ops')
md.push('still alive. "Public" also sees the federation\'s ledger of failures by policy and discounts a policy by its')
md.push('failure rate times what members stand to lose.', '')
md.push(...head(' average account ÷ buy-in | savings | pooled | appreciation credited |'))
out.federation.learning = {}
for (const sname of ['moderate', 'severe']) {
  for (const learning of ['none', 'survivors', 'public']) {
    const s = fed({ ...STRESS[sname], learning }); out.federation.learning[sname + ':' + learning] = s
    md.push(row(`${sname}, ${learning}`, s, ` ${s.acct.toFixed(2)}× | ${pct(s.savings)} | ${pct(s.pooled, 0)} | ${pct(s.appreciation, 0)} |`))
  }
  const s = fed({ ...STRESS[sname], architecture: 'merged', learning: 'survivors' }); out.federation.learning[sname + ':merged-survivors'] = s
  md.push(row(`${sname}, merged, survivors`, s, ` ${s.acct.toFixed(2)}× | ${pct(s.savings)} | ${pct(s.pooled, 0)} | ${pct(s.appreciation, 0)} |`))
}
md.push('', 'Learning from success drifts toward member wealth: less saving, more appreciation credited. Under severe')
md.push('stress that drift raises losses. The public failure ledger helps a little under moderate stress and not')
md.push('clearly under severe; the differences sit within about one standard error. Failures here come mostly from')
md.push('luck and from terms set at purchase, which co-ops cannot copy later, and 24 co-ops give the ledger thin')
md.push('evidence. A real ledger would carry causes, not just counts.', '')

md.push('## 5. What the model leaves out', '')
md.push('- Taxes, transaction costs of refinancing, and legal costs of the offering.')
md.push('- Member behavior beyond a fixed turnover and the charge cap: no runs on accounts, no governance failure.')
md.push('- Correlation between repair shocks (an old housing stock ages together).')
md.push('- The value of autonomy, so the dial in 4.3 can only show the protection side.')
md.push('- The investors\' side: whether 5% senior notes sell, and what happens to them when a co-op fails.')

writeFileSync(join(here, 'results.md'), md.join('\n') + '\n')
writeFileSync(join(here, 'results.json'), JSON.stringify(out, null, 1) + '\n')
console.log('wrote model/results.md and model/results.json')
