// The digest's visual channels (Jason, 2026-11-27: "pretty up the digest a bit - have autonomist fetch image previews,
// play with typesetting, and otherwise give different visual channels to communicate what they're seeing"). Each
// part is drawn by code from the digest's record, for the page (classes, the site's stylesheet) and for the email
// (inline styles, since mail clients drop stylesheets):
//   - the lead image and each story's image: the publisher's own preview image, served from autonomist's site
//   - one square per person who shared a story
//   - threads over time: a strip of days per theme, by code's counts
//   - the power map: who holds the power, what's at stake, who bears the cost, which way it moves, with its evidence
//   - a pull quote: a passage the digest quotes, chosen by code from those it verified
import { esc } from '../site/js/md.js'
import { blobCid } from './bot/images.js'
import { DIRECTIONS } from './bot/analysis.js'

/** The broadsheet's inks, as hex for email (the site's OKLCH tokens, converted). */
export const INK = { paper: '#f9f3ea', sheet: '#fdfaf4', ink: '#261b16', ink2: '#41352f', muted: '#63554d', line: '#d5c8bc', spot: '#d73d1f', spotText: '#b82b19', wash: '#fdd4c6' }
const LEVELS = ['transparent', '#f6c9b9', '#ec9a7f', '#df6a47', '#c23a1b']

const http = (u) => /^https?:\/\/[^\s"<>]+$/.test(String(u || ''))
/** Where an image is served: the site's own route, or a stand-in (a dry run's data URI). */
export const imageSrc = (blob, { origin = '', src } = {}) => {
  const cid = blobCid(blob)
  if (!cid) return null
  return src ? src(cid) : `${origin}/journal/img/${cid}`
}

export const longDate = (day) => {
  const d = new Date(`${day}T12:00:00Z`)
  return Number.isNaN(d.getTime()) ? String(day || '') : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

// ---------------------------------------------------------------------------------------------------------------
// the page

/** The top story's image, credited, above the body. */
export function leadHtml(story, opts) {
  const src = imageSrc(story?.image?.blob, opts)
  if (!src) return ''
  const credit = http(story.image.article) ? `<a href="${esc(story.image.article)}">${esc(story.image.outlet || 'the publisher')}</a>` : esc(story.image.outlet || 'the publisher')
  return `<figure class="lead"><img src="${esc(src)}" alt="${esc(story.image.alt || '')}" loading="eager" decoding="async"><figcaption>${esc(story.label || '')} · Image: ${credit}</figcaption></figure>
`
}

/** One square per person who shared, up to 40; a number past that. Hidden from screen readers, which get the words. */
export function unitsHtml(n) {
  const k = Math.max(0, Math.round(Number(n) || 0))
  if (!k) return ''
  return `<span class="units" aria-hidden="true">${'<i></i>'.repeat(Math.min(k, 40))}${k > 40 ? `<b>+${k - 40}</b>` : ''}</span>`
}

const levelOf = (v, max) => (v <= 0 || max <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((v / max) * 4))))
const daysIn = (values, n) => values.slice(-n).filter((v) => v > 0).length

/** Threads over time: a row of days per theme, darker for more people. */
export function trendHtml(trend) {
  const rows = Array.isArray(trend?.rows) ? trend.rows.filter((r) => Array.isArray(r.values)) : []
  if (!rows.length) return ''
  const days = Number(trend.days) || rows[0].values.length
  const covered = new Set(trend.covered || [])
  const end = Date.parse(`${trend.end}T12:00:00Z`)
  const dates = Array.from({ length: days }, (_, i) => new Date(end - (days - 1 - i) * 86400_000).toISOString().slice(0, 10))
  const max = Math.max(...rows.flatMap((r) => r.values.map(Number)))
  const first = [...covered].sort()[0]
  const li = rows.map((r) => {
    const values = r.values.map((v) => Math.max(0, Number(v) || 0))
    const cells = values.map((v, i) => `<i class="${covered.has(dates[i]) ? `l${levelOf(v, max)}` : 'nd'}"></i>`).join('')
    const d7 = daysIn(values, 7), d30 = daysIn(values, days)
    return `<li><span class="tr-theme">${esc(r.theme)}</span><span class="tr-cells" aria-hidden="true">${cells}</span><span class="tr-sum">${d7} of the last 7 days${days > 7 ? `<span class="muted">, ${d30} of ${days}</span>` : ''}</span></li>`
  }).join('')
  return `<figure class="trend" aria-labelledby="trend-h">
<h2 id="trend-h">What the network keeps coming back to</h2>
<p class="muted">The themes of each day's stories over the last ${days} days. Each square is a day: the darker, the more people shared stories on the theme (someone who shared two of its stories counts twice). A dash is a day without a digest that carries themes${first ? `; the first is ${esc(longDate(first))}` : ''}. Counted by code; the themes are autonomist's.</p>
<ol class="tr">${li}</ol>
</figure>
`
}

const DIR_LABEL = { 'toward enclosure': 'Toward enclosure', contested: 'Contested', 'toward the commons': 'Toward the commons' }
const dirClass = (d) => ({ 'toward enclosure': 'enclosure', contested: 'contested', 'toward the commons': 'commons' })[d] || 'contested'

/** The power map, row by row, with each row's evidence. */
export function powerMapHtml(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r?.thread && DIRECTIONS.includes(r.direction))
  if (list.length < 2) return ''
  const li = list.map((r) => `<li>
<h3>${esc(r.thread)}</h3>
<dl><div><dt>Holds the power</dt><dd>${esc(r.holds)}</dd></div><div><dt>At stake</dt><dd>${esc(r.atStake)}</dd></div><div><dt>Bears the cost</dt><dd>${esc(r.bearsCost)}</dd></div></dl>
<p class="pm-dir pm-${dirClass(r.direction)}"><span class="pm-scale" aria-hidden="true"><span>Enclosure</span><span class="pm-track"><i></i></span><span>Commons</span></span><strong>${esc(DIR_LABEL[r.direction])}</strong></p>
${(r.evidence || []).filter((e) => e?.quote).map((e) => `<blockquote class="pm-ev"><p>“${esc(e.quote)}”</p></blockquote><p class="pm-src">${http(e.url) ? `<a href="${esc(e.url)}">${esc(e.outlet || 'source')}</a>` : esc(e.outlet || '')}</p>`).join('\n')}
</li>`).join('\n')
  return `<section class="power-map" aria-labelledby="power-map-h">
<h2 id="power-map-h">The power map</h2>
<p class="muted">Who holds the power in each thread, what's at stake, who bears the cost, and which way it's moving, read through Power Explained. Written by autonomist; code checked that every passage below is in the article it links.</p>
<ol class="pm">
${li}
</ol>
</section>
`
}

/** A passage the digest quotes, set large. */
export function pullHtml(pull) {
  if (!pull?.quote) return ''
  return `<figure class="pull"><blockquote><p>“${esc(pull.quote)}”</p></blockquote><figcaption>${http(pull.url) ? `<a href="${esc(pull.url)}">${esc(pull.outlet || 'source')}</a>` : esc(pull.outlet || '')}</figcaption></figure>
`
}

/**
 * Sets the new parts into the rendered body: threads over time before "The common threads", the pull quote after that
 * section's second paragraph, the power map before "For people organizing". Anything whose place isn't found goes at
 * the end. `h` is how the renderer writes a section's heading (with ids on the page, without in email).
 */
export function assemble(bodyHtml, { trend = '', pull = '', powerMap = '' }, h = (id) => `<h2 id="${id}">`) {
  let html = String(bodyHtml)
  const tail = []
  const before = (marker, part) => {
    if (!part) return
    const i = html.indexOf(marker)
    if (i < 0) tail.push(part)
    else html = html.slice(0, i) + part + html.slice(i)
  }
  before(h('the-common-threads', 'The common threads'), trend)
  if (pull) {
    const start = html.indexOf(h('the-common-threads', 'The common threads'))
    const first = start < 0 ? -1 : html.indexOf('</p>', start)
    const second = first < 0 ? -1 : html.indexOf('</p>', first + 4)
    const next = start < 0 ? -1 : html.indexOf('<h2', start + 4)
    if (second > 0 && (next < 0 || second < next)) html = html.slice(0, second + 4) + '\n' + pull + html.slice(second + 4)
    else tail.push(pull)
  }
  before(h('for-people-organizing', 'For people organizing'), powerMap)
  return html + tail.join('')
}

// ---------------------------------------------------------------------------------------------------------------
// the email: the same parts, inline-styled

const DISPLAY = "'Big Shoulders', 'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue', Arial, sans-serif"
const SERIF = "Georgia, 'Times New Roman', serif"
const LABEL = `font-family:${DISPLAY};font-weight:700;font-size:13px;line-height:1.2;letter-spacing:1.6px;text-transform:uppercase;color:${INK.spotText}`
const H2 = `${LABEL};margin:34px 0 12px;padding-top:12px;border-top:1px solid ${INK.ink}`
const MUTED = `color:${INK.muted};font-size:14px;margin:0 0 12px`

export function leadEmail(story, opts) {
  const src = imageSrc(story?.image?.blob, opts)
  if (!src) return ''
  return `<div style="margin:6px 0 22px"><img src="${esc(src)}" width="596" alt="${esc(story.image.alt || '')}" style="display:block;width:100%;max-width:596px;height:auto;border:0"><p style="${MUTED};margin-top:6px">${esc(story.label || '')} · Image: ${esc(story.image.outlet || 'the publisher')}</p></div>
`
}

export function trendEmail(trend, { days = 14 } = {}) {
  const rows = Array.isArray(trend?.rows) ? trend.rows.filter((r) => Array.isArray(r.values)) : []
  if (!rows.length) return ''
  const all = Number(trend.days) || rows[0].values.length
  const covered = new Set(trend.covered || [])
  const end = Date.parse(`${trend.end}T12:00:00Z`)
  const dates = Array.from({ length: all }, (_, i) => new Date(end - (all - 1 - i) * 86400_000).toISOString().slice(0, 10)).slice(-days)
  const max = Math.max(...rows.flatMap((r) => r.values.slice(-days).map(Number)))
  const tr = rows.map((r) => {
    const values = r.values.slice(-days).map((v) => Math.max(0, Number(v) || 0))
    const cells = values.map((v, i) => covered.has(dates[i])
      ? `<td style="width:11px;height:11px;padding:0;background:${LEVELS[levelOf(v, max)]};border:1px solid ${INK.line}"></td>`
      : `<td style="width:11px;height:11px;padding:0;text-align:center;color:${INK.line};font-size:9px;line-height:11px">&ndash;</td>`).join('<td style="width:2px;padding:0"></td>')
    return `<tr><td style="padding:3px 10px 3px 0;font-size:14px;color:${INK.ink};white-space:nowrap">${esc(r.theme)}</td><td style="padding:3px 0"><table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse"><tr>${cells}</tr></table></td><td style="padding:3px 0 3px 10px;font-size:13px;color:${INK.muted};white-space:nowrap">${daysIn(values, 7)} of 7 days</td></tr>`
  }).join('')
  return `<h2 style="${H2}">What the network keeps coming back to</h2>
<p style="${MUTED}">The themes of each day's stories over the last ${days} days. Each square is a day: the darker, the more people shared stories on the theme. A dash is a day without a digest that carries themes. Counted by code.</p>
<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:0 0 18px">${tr}</table>
`
}

export function powerMapEmail(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r?.thread && DIRECTIONS.includes(r.direction))
  if (list.length < 2) return ''
  const scale = (d) => `<table role="presentation" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin:8px 0"><tr>${DIRECTIONS.map((x) => `<td style="font-family:${DISPLAY};font-weight:700;font-size:12px;letter-spacing:1px;text-transform:uppercase;padding:5px 9px;border:1px solid ${INK.ink};${x === d ? `background:${INK.spotText};color:${INK.sheet}` : `color:${INK.muted}`}">${esc(DIR_LABEL[x])}</td>`).join('')}</tr></table>`
  const field = (k, v) => `<p style="margin:0 0 4px"><span style="font-family:${DISPLAY};font-weight:700;font-size:12px;letter-spacing:1.2px;text-transform:uppercase;color:${INK.muted}">${k}</span><br>${esc(v)}</p>`
  return `<h2 style="${H2}">The power map</h2>
<p style="${MUTED}">Who holds the power in each thread, what's at stake, who bears the cost, and which way it's moving, read through Power Explained. Written by autonomist; code checked that every passage is in the article it links.</p>
${list.map((r) => `<div style="margin:0 0 18px;padding:14px 16px;border:1px solid ${INK.line};background:${INK.paper}">
<p style="font-family:${SERIF};font-weight:700;font-size:18px;line-height:1.3;margin:0 0 8px;color:${INK.ink}">${esc(r.thread)}</p>
${field('Holds the power', r.holds)}${field('At stake', r.atStake)}${field('Bears the cost', r.bearsCost)}${scale(r.direction)}
${(r.evidence || []).filter((e) => e?.quote).map((e) => `<p style="margin:8px 0 0;font-style:italic;color:${INK.ink2}">“${esc(e.quote)}” <span style="font-style:normal;color:${INK.muted};font-size:14px">${http(e.url) ? `<a href="${esc(e.url)}" style="color:${INK.ink};text-decoration:underline;text-decoration-color:${INK.spot}">${esc(e.outlet || 'source')}</a>` : esc(e.outlet || '')}</span></p>`).join('')}
</div>`).join('\n')}
`
}

export function pullEmail(pull) {
  if (!pull?.quote) return ''
  return `<div style="margin:24px 0;padding:14px 0;border-top:3px double ${INK.ink};border-bottom:1px solid ${INK.ink}"><p style="font-family:${SERIF};font-style:italic;font-size:23px;line-height:1.35;margin:0 0 8px;color:${INK.ink}"><span style="color:${INK.spot}">“</span>${esc(pull.quote)}<span style="color:${INK.spot}">”</span></p><p style="${LABEL};margin:0">${esc(pull.outlet || '')}</p></div>
`
}
