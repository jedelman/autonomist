// tools.js: what autonomist's agent can do. Every number comes from code: the model chooses
// inputs, the engine model (model/lec-core.cjs) computes, and saved results are re-computed from
// their inputs here, never taken from model text.
import LEC from '../model/lec-core.cjs'
import { lookupParcel } from './parcel.js'

const r0 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x))
const r2 = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 100) / 100)
const pct = (x) => (x == null || !Number.isFinite(x) ? x : Math.round(x * 1000) / 10)
const clamp = (x, lo, hi, d) => (Number.isFinite(Number(x)) ? Math.min(hi, Math.max(lo, Number(x))) : d)

// ---- computations (shared by tool calls and saved results) ----
export const COMPUTE = {
  underwrite_building(i) {
    const b = { units: clamp(i.units, 1, 2000, 1), price: clamp(i.price, 10000, 1e9, 1e6), repairs: clamp(i.repairs, 0, 1e9, 0) }
    if (i.noi != null) b.noi = clamp(i.noi, 0, 1e9, 0); else b.capRate = clamp(i.cap_rate, 0.005, 0.25, 0.06)
    const u = LEC.underwrite(b)
    return {
      inputs_used: { ...b, minDSCR: u.minDSCR },
      noi: r0(u.noi), cap_rate_pct: r2(u.capRate * 100), total_cost: r0(u.need), cost_per_home: r0(u.perHome),
      stacks: Object.fromEntries(Object.entries(u.stacks).map(([k, s]) => [k, { terms: s.label, dscr: r2(s.dscr), cash_after_debt_yearly: r0(s.cashAfterDebt), cash_after_debt_per_home_monthly: r0(s.cashPerHomeMonth), equity_to_raise: r0(s.equity), equity_per_home: r0(s.equityPerHome), most_it_could_pay_at_min_dscr: r0(s.maxCost) }])),
      coordination_dividend: r0(u.coordinationDividend),
      reading: 'DSCR is income over loan payments; lenders want about 1.15-1.25. "Most it could pay" is total cost (price plus repairs) that keeps DSCR at the minimum. All terms are scenarios.',
    }
  },
  listing_pressure(i) {
    const p = { price: clamp(i.price, 10000, 1e9, 1e6), ltv: clamp(i.ltv, 0.3, 0.95, 0.75), rate: clamp(i.rate, 0.01, 0.15, 0.07), years: clamp(i.years, 5, 40, 30), dscr: clamp(i.dscr, 1, 2, 1.25) }
    if (i.noi != null) p.noi = clamp(i.noi, 0, 1e9, 0); else p.capRate = clamp(i.cap_rate, 0.005, 0.25, 0.06)
    if (i.cost_share != null) p.costShare = clamp(i.cost_share, 0.1, 0.7, 0.4)
    const x = LEC.pressure(p)
    return {
      inputs_used: p, noi: r0(x.noi), loan_payment_yearly: r0(x.debtService), dscr_at_asking_price: r2(x.dscrAtAsk),
      income_needed: r0(x.noiNeeded), income_rise_needed_pct: pct(x.riseNeeded), rent_rise_needed_pct: x.rentRiseNeeded == null ? null : pct(x.rentRiseNeeded),
      price_that_works_on_todays_income: r0(x.priceThatWorks),
      reading: 'What a buyer paying the asking price on these loan terms would need the building to earn. Not a scheduled rent increase: a buyer with more cash, or content with less, needs less.',
    }
  },
  compare_member(i) {
    const years = clamp(i.years, 1, 15, 7)
    const run = LEC.runCoop({ years: 15, market: { rentGrowth: clamp(i.rent_growth, -0.05, 0.1, 0.03) } })
    const H = { portfolio: clamp(i.portfolio_return, 0, 0.15, 0.06), mortgageRate: clamp(i.mortgage_rate, 0.02, 0.12, 0.065), condoPrice: clamp(i.condo_price, 50000, 5e6, 350000) }
    const x = LEC.compare(run, H)[years - 1]
    return {
      inputs_used: { years, rentGrowth: run.c.m.rentGrowth, ...H }, member_buy_in: r0(run.buyIn0), member_account_at_exit: r0(run.ownAcct[years - 1]),
      net_worth: { renter: r0(x.renter), condo_owner: r0(x.condo), coop_member: r0(x.member) },
      monthly_cost_in_final_year: { rent: r0(x.rent / 12), condo: r0(x.condoCost / 12), coop_charge: r0(x.coop / 12) },
      reading: 'Same starting wealth and the same yearly budget for each path; what a path does not spend on housing is invested. The co-op is the worked 8-unit building with default governance. No income taxes modeled.',
    }
  },
  federation_stress(i) {
    const arch = ['isolated', 'pool', 'merged'].includes(i.architecture) ? i.architecture : 'pool'
    const stress = { base: { shockScale: 1, regionalDrop: 0.1 }, moderate: { shockScale: 2, regionalDrop: 0.1 }, severe: { shockScale: 1, regionalDrop: 0.25 } }[i.stress] || { shockScale: 2, regionalDrop: 0.1 }
    const F = { architecture: arch, ...stress, runs: clamp(i.runs, 20, 150, 100), regions: clamp(i.regions, 1, 8, 1) }
    if (i.pooled != null) F.pooledFixed = clamp(i.pooled, 0, 1, 0.5)
    if (i.senior_share != null) F.menu = { senior: [clamp(i.senior_share, 0.5, 0.85, 0.7)] }
    const f = LEC.federation(F)
    return {
      inputs_used: { architecture: arch, stress: i.stress || 'moderate', runs: F.runs, regions: F.regions, pooled: F.pooledFixed ?? 'each co-op chooses', senior_share: F.menu ? F.menu.senior[0] : 'mixed 60/70/80%' },
      homes_lost_pct: pct(f.homesLostShare), chance_any_coop_fails_pct: pct(f.pAnyFail), chance_quarter_or_more_fail_pct: pct(f.pSystemic), worst_run_homes_lost_pct: pct(f.worstHomesLost), member_account_over_buy_in: r2(f.memberAcct),
      reading: '24 co-ops over 15 years under random shocks. "isolated": no pool; "pool": financially separate co-ops sharing a pool; "merged": one balance sheet where one default takes all. Mechanism, not forecast.',
    }
  },
}

const SAVEABLE = Object.keys(COMPUTE)

// ---- tool definitions for the model ----
const num = (description) => ({ type: 'number', description })
export const TOOLS = [
  {
    name: 'underwrite_building',
    description: 'Run a building\'s numbers across four capital stacks (a commons stack of senior notes, solidarity money and member equity; a community lender with a seller note; a patient 2% lender; a bank as a typical private buyer uses). Returns DSCR, cash left after loan payments, equity to raise, the most each stack could pay, and the gap between the commons stack and the bank (the coordination dividend). Use for "could we buy this building?" questions. Give noi if known, otherwise cap_rate from a listing.',
    input_schema: { type: 'object', additionalProperties: false, required: ['units', 'price'], properties: { units: num('Number of homes'), price: num('Purchase price in dollars'), noi: num('Net operating income a year, if known'), cap_rate: num('Cap rate as a decimal, e.g. 0.0627, if NOI is not known'), repairs: num('Repairs to fund at purchase, in dollars (an assumption unless the person knows)') } },
  },
  {
    name: 'listing_pressure',
    description: 'What an asking price implies for a building\'s income and rents: the income a buyer at that price would need on ordinary loan terms, the rise over today\'s income, and the price that works on today\'s income. A tenant-organizing tool. Defaults: 75% loan at 7% over 30 years, lender wants DSCR 1.25.',
    input_schema: { type: 'object', additionalProperties: false, required: ['price'], properties: { price: num('Asking price'), noi: num('Net operating income a year from the listing'), cap_rate: num('Cap rate as a decimal, if NOI is not given'), ltv: num('Loan as a share of price (default 0.75)'), rate: num('Loan interest rate (default 0.07)'), years: num('Loan term in years (default 30)'), dscr: num('Lender\'s required DSCR (default 1.25)'), cost_share: num('Operating costs as a share of gross rent, to express the rise as rent (e.g. 0.4)') } },
  },
  {
    name: 'compare_member',
    description: 'Compare a household\'s net worth after some years as a limited-equity co-op member, a renter, and a condo owner, from the same starting wealth and budget. Uses the worked 8-unit building with default governance. Use for "is joining a co-op a good deal for someone with options?" questions.',
    input_schema: { type: 'object', additionalProperties: false, properties: { years: num('Horizon in years, 1-15 (default 7)'), rent_growth: num('Yearly market rent growth, decimal (default 0.03)'), portfolio_return: num('Yearly return on invested savings (default 0.06)'), mortgage_rate: num('Condo mortgage rate (default 0.065)'), condo_price: num('Price of a comparable condo (default 350000)') } },
  },
  {
    name: 'federation_stress',
    description: 'Simulate a federation of 24 limited-equity co-ops over 15 years under random shocks (rates, regional rent drops, repair bills, vacancies) and report homes lost, the chance any co-op fails, the chance a quarter or more fail, and the worst run. Compare architectures (isolated, a firewalled shared pool, merged onto one balance sheet), how much each co-op pools, how many independent markets, and leverage at purchase.',
    input_schema: { type: 'object', additionalProperties: false, properties: { architecture: { type: 'string', enum: ['isolated', 'pool', 'merged'] }, stress: { type: 'string', enum: ['base', 'moderate', 'severe'] }, pooled: num('Share of each co-op\'s savings sent to the pool, 0-1 (omit to let each co-op choose)'), regions: num('Independent rental markets the federation spans, 1-8 (default 1)'), senior_share: num('Senior debt as a share of cost at purchase, 0.5-0.85 (omit for a mix)'), runs: num('Simulation runs, 20-150 (default 100)') } },
  },
  {
    name: 'norfolk_parcel',
    description: 'A building\'s public record in Norfolk, Virginia, from the City\'s open data: assessment, property class, year built, size, last sale (not for homes), owner (only an organization on an apartment or commercial parcel), building permits since 2015 and code-enforcement cases. Takes a street address only. Never use it to find or follow a person.',
    input_schema: { type: 'object', additionalProperties: false, required: ['address'], properties: { address: { type: 'string', description: 'Street address in Norfolk, VA, e.g. "740 W Princess Anne Rd"' } } },
  },
  {
    name: 'read_published',
    description: 'List or read what autonomist has published: case studies, technical papers (the model and its results), and public tools. Use to cite or summarize them.',
    input_schema: { type: 'object', additionalProperties: false, required: ['section'], properties: { section: { type: 'string', enum: ['case-studies', 'model', 'tools'] }, slug: { type: 'string', description: 'A page\'s slug from the list, to read it' } } },
  },
  {
    name: 'save_result',
    description: 'Publish one computation as a public page with its own link. The page is rendered by code from the inputs; only the title comes from you. Save only when the person asks for a link or agrees to one. Tools that can be saved: underwrite_building, listing_pressure, compare_member, federation_stress.',
    input_schema: { type: 'object', additionalProperties: false, required: ['title', 'tool', 'inputs'], properties: { title: { type: 'string', description: 'A short plain title, no names of people, no contact details' }, tool: { type: 'string', enum: SAVEABLE }, inputs: { type: 'object', description: 'The same inputs you gave that tool' } } },
  },
  {
    name: 'propose_case_study',
    description: 'Send a case-study draft to a human steward, who checks every source before anything is published. Never published automatically. Use when a conversation has produced findings worth a public, sourced write-up and the person agrees.',
    input_schema: { type: 'object', additionalProperties: false, required: ['title', 'summary', 'sources'], properties: { title: { type: 'string' }, summary: { type: 'string', description: 'What was found and why it matters, in plain language, under 2,000 characters' }, sources: { type: 'array', items: { type: 'string' }, description: 'Source URLs the findings rest on' } } },
  },
]

const ID_ALPHABET = 'abcdefghjkmnpqrstvwxyz23456789'
export function newId(n = 12) {
  const bytes = crypto.getRandomValues(new Uint8Array(n * 2))
  let out = ''
  for (const b of bytes) { if (b < 240 && out.length < n) out += ID_ALPHABET[b % ID_ALPHABET.length] }
  return out
}

/** A title fit for a public page: one line, no links, emails or phone numbers. */
export function cleanTitle(t) {
  const s = String(t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120)
  if (!s || /https?:|www\.|@|\d{3}[\s.-]?\d{3}[\s.-]?\d{4}/i.test(s)) return null
  return s
}

/**
 * Run one tool call. ctx: { kv, fetchJson, content (published index loader), sources: Map, results: [] }.
 * Returns a JSON-able object; throws for errors the model should see.
 */
export async function runTool(name, input, ctx) {
  input = input && typeof input === 'object' ? input : {}
  if (COMPUTE[name]) return COMPUTE[name](input)
  if (name === 'norfolk_parcel') {
    const r = await lookupParcel(String(input.address || '').slice(0, 120), ctx.fetchJson)
    for (const s of r.sources || []) ctx.sources.set(s.url, s.title)
    const { sources, ...rest } = r
    return { ...rest, sources: (sources || []).map((s) => s.title) }
  }
  if (name === 'read_published') {
    const index = await ctx.content()
    const items = index[input.section] || []
    if (!input.slug) return { section: input.section, items: items.map(({ slug, title, summary, url }) => ({ slug, title, summary, url })) }
    const item = items.find((x) => x.slug === input.slug)
    if (!item) return { error: 'No page with that slug; list the section first.' }
    ctx.sources.set(item.url, item.title)
    return { title: item.title, url: item.url, text: item.text }
  }
  if (name === 'save_result') {
    if (!ctx.kv) throw new Error('Saving is not available on this deployment.')
    const title = cleanTitle(input.title)
    if (!title) throw new Error('Give a short plain title with no links, emails or phone numbers.')
    if (!SAVEABLE.includes(input.tool)) throw new Error('That tool cannot be saved.')
    const outputs = COMPUTE[input.tool](input.inputs || {})
    const id = newId()
    const record = { id, title, tool: input.tool, inputs: outputs.inputs_used, outputs, created: new Date().toISOString().slice(0, 10) }
    await ctx.kv.put(`result:${id}`, JSON.stringify(record))
    const url = `/results/${id}`
    ctx.results.push({ id, url, title })
    ctx.sources.set(url, title)
    return { saved: true, url, note: 'Public page, rendered from these inputs by code.' }
  }
  if (name === 'propose_case_study') {
    if (!ctx.kv) throw new Error('Proposals are not available on this deployment.')
    const title = cleanTitle(input.title)
    if (!title) throw new Error('Give a short plain title with no links, emails or phone numbers.')
    const summary = String(input.summary || '').slice(0, 2000)
    const sources = (Array.isArray(input.sources) ? input.sources : []).map(String).filter((u) => /^https:\/\/\S+$/.test(u)).slice(0, 20)
    const id = newId()
    await ctx.kv.put(`proposal:${id}`, JSON.stringify({ id, title, summary, sources, created: new Date().toISOString() }), { expirationTtl: 180 * 86400 })
    return { proposed: true, note: 'A steward will check every source before anything is published. Nothing is public yet.' }
  }
  throw new Error(`Unknown tool ${name}`)
}
