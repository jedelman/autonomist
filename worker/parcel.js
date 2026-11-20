// parcel.js: a building's public record in Norfolk, Virginia, from the City's open data portal.
// Datasets and fields checked live on 2026-11-20:
//   qva7-tzrf  FY27 real estate assessments (effective 2026-07-01): parcel_id, gpin, owner,
//              property_street_number, property_street_name, property_class_description,
//              improvement_year_built, commercial_building_area, acreage, current_*_value,
//              transfer_date, consideration
//   fahm-yuh4  building permits (applications from 2015-12): permit_number, type, work_type,
//              status, application_date, project_cost, gpin
//   mxtv-99gh  code enforcement (complaints from 2018-08, inspections from 2023-11):
//              complaint_type, complaint_subtype, complaint_created_date, inspection_status,
//              violation_ordinance, violation_status, gpin
//
// It reads buildings, not people. It takes an address only (never a name), and:
// - homes (property classes in the 500s: houses, condos) come back with no owner and no sale price;
// - an owner is shown only for apartment and commercial classes (400s) and only when the name is
//   plainly an organization (LLC, Inc., an authority...); trusts and estates, often named for a
//   person, are withheld.
// Every request is counted against the answer's budget by the caller's fetch.

const BASE = 'https://data.norfolk.gov/resource/'
const PAGE = 'https://data.norfolk.gov/d/'
const UA = 'autonomist/0.1 (public-interest project; https://github.com/jedelman/autonomist)'

const DIRECTIONS = new Set(['N', 'S', 'E', 'W', 'NORTH', 'SOUTH', 'EAST', 'WEST'])
const TYPES = new Set(['ST', 'STREET', 'AVE', 'AVENUE', 'AV', 'RD', 'ROAD', 'BLVD', 'BOULEVARD', 'DR', 'DRIVE', 'CT', 'COURT', 'LN', 'LANE', 'PL', 'PLACE', 'WAY', 'CIR', 'CIRCLE', 'TER', 'TERRACE', 'HWY', 'HIGHWAY', 'PKWY', 'PARKWAY', 'SQ', 'ARCH', 'CRES', 'TRL'])

/** "740 W Princess Anne Rd, Norfolk" -> { number: '740', name: 'PRINCESS ANNE' }, or null. */
export function parseAddress(input) {
  const s = String(input || '').toUpperCase().split(',')[0].replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim()
  const m = s.match(/^(\d{1,6})[A-Z]?\s+(.+)$/)
  if (!m) return null
  let words = m[2].split(' ').filter(Boolean)
  while (words.length > 1 && DIRECTIONS.has(words[0])) words.shift()
  while (words.length > 1 && (TYPES.has(words[words.length - 1]) || DIRECTIONS.has(words[words.length - 1]))) words.pop()
  const name = words.join(' ')
  return name && /^[A-Z0-9 ]{2,40}$/.test(name) ? { number: m[1], name } : null
}

const ENTITY = /\b(LLC|L L C|INC|INCORPORATED|CORP|CORPORATION|COMPANY|LP|LLP|LTD|PARTNERSHIP|ASSOCIATES|ASSOCIATION|AUTHORITY|CITY OF|COMMONWEALTH|COUNTY|CHURCH|FOUNDATION|UNIVERSITY|COLLEGE|BANK|PROPERTIES|INVESTMENTS|HOLDINGS|REALTY|APARTMENTS|DEVELOPMENT|HOUSING|ENTERPRISES|GROUP|FUND|SERIES|COOPERATIVE|CO OP)\b/
const PERSONAL = /\b(TRUST|TRUSTEE|TRUSTEES|ESTATE|REVOCABLE|LIVING|HEIRS|ET AL|ETAL)\b/

/** The owner as shown: the name for an organization on a non-residential parcel, else a note. */
export function shownOwner(owner, propertyClass) {
  const cls = String(propertyClass || '')
  if (!/^4\d\d/.test(cls)) return { owner: null, note: 'withheld: a home (houses and condos are never shown with an owner)' }
  const name = String(owner || '').toUpperCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ')
  if (ENTITY.test(name) && !PERSONAL.test(name)) return { owner: String(owner).trim() }
  return { owner: null, note: 'withheld: not plainly an organization' }
}

const num = (x) => (x == null || x === '' ? null : Number(x))
const day = (x) => (x ? String(x).slice(0, 10) : null)

async function soda(fetchJson, id, params) {
  const url = BASE + id + '.json?' + new URLSearchParams(params).toString()
  const rows = await fetchJson(url)
  return { url, rows: Array.isArray(rows) ? rows : [] }
}

/**
 * Look up a building by address. fetchJson(url) must be the answer's counted fetch, returning
 * parsed JSON. Returns { found, ... } with sources for the hand-off.
 */
export async function lookupParcel(address, fetchJson) {
  const a = parseAddress(address)
  if (!a) return { found: false, error: 'Give a street address with a house number, like "740 W Princess Anne Rd".' }
  // words joined by % so "O KEEFE" matches O'KEEFE; the name is only letters, digits and spaces
  const where = `property_street_number='${a.number}' AND upper(property_street_name) like '%${a.name.replace(/ /g, '%')}%'`
  const assess = await soda(fetchJson, 'qva7-tzrf', { $where: where, $limit: '50' })
  const sources = [{ title: 'Norfolk real estate assessments, FY27 (City of Norfolk open data)', url: PAGE + 'qva7-tzrf' }, { title: 'The exact assessment query', url: assess.url }]
  if (!assess.rows.length) return { found: false, address: `${a.number} ${a.name}`, note: 'No parcel in the FY27 assessment roll matches that number and street name in Norfolk.', sources }
  // Condominium units share a building: summarize them, never list owners
  const units = assess.rows.filter((r) => r.unit_number)
  const main = assess.rows.find((r) => !r.unit_number) || assess.rows[0]
  const cls = main.property_class_description || ''
  const residential = /^5\d\d/.test(cls)
  const out = {
    found: true,
    address: [main.property_street_number, main.property_street_direction, main.property_street_name, main.property_street_type].filter(Boolean).join(' '),
    parcel_id: main.parcel_id, gpin: main.gpin,
    property_class: cls, year_built: num(main.improvement_year_built),
    building_area_sqft: num(main.commercial_building_area) ?? num(main.residential_finished_living),
    acreage: num(main.acreage),
    assessed: { land: num(main.current_land_value), improvements: num(main.current_improvement_value), total: num(main.current_total_value), effective: day(main.effective_year) },
    ...shownOwner(main.owner, cls),
  }
  if (!residential) out.last_transfer = { date: day(main.transfer_date), price: num(main.consideration) }
  if (units.length > 1) {
    out.condo_units = { count: units.length, assessed_each: [...new Set(units.map((u) => num(u.current_total_value)))].slice(0, 5), note: 'Condominium units; owners and sale prices are not shown.' }
  }
  if (assess.rows.length > 1 && !units.length) out.other_matches = assess.rows.length - 1
  const gpin = String(main.gpin || '').replace(/\D/g, '')
  if (gpin) {
    const [permits, cases] = await Promise.all([
      soda(fetchJson, 'fahm-yuh4', { $where: `gpin='${gpin}'`, $order: 'application_date DESC', $limit: '60' }),
      soda(fetchJson, 'mxtv-99gh', { $where: `gpin='${gpin}'`, $limit: '60' }),
    ])
    out.permits = { since: '2015-12', count: permits.rows.length, items: permits.rows.slice(0, 25).map((p) => ({ date: day(p.application_date), type: p.type, work: p.work_type, status: p.status, cost: num(p.project_cost) })) }
    out.code_cases = { complaints_since: '2018-08', inspections_since: '2023-11', count: cases.rows.length, items: cases.rows.slice(0, 25).map((c) => ({ date: day(c.complaint_created_date || c.inspection_created_date || c.violation_created_date), type: c.complaint_type || c.inspection_type, subtype: c.complaint_subtype, ordinance: c.violation_ordinance, violation_status: c.violation_status, status: c.complaint_status || c.inspection_status })) }
    sources.push({ title: 'Norfolk building permits (City of Norfolk open data)', url: PAGE + 'fahm-yuh4' }, { title: 'The exact permits query', url: permits.url }, { title: 'Norfolk code enforcement cases (City of Norfolk open data)', url: PAGE + 'mxtv-99gh' }, { title: 'The exact code-case query', url: cases.url })
  }
  out.not_included = 'Flood zone, rents, leases and condition behind the walls are not in these datasets.'
  return { ...out, sources }
}

export const UA_HEADER = UA
