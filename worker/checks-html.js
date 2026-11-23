// Fact-checks as HTML, for the journal's entry pages and the run journal on /thinking/. Everything is escaped; a
// source link is shown only for an http(s) URL, and only verdicts and stances the code gives are shown as such.
import { esc } from '../site/js/md.js'

const VERDICT = {
  confirmed: 'confirmed: two independent sites support it',
  supported: 'supported by one source',
  disputed: 'disputed: a source contradicts it',
  unsettled: 'sources found, none settles it',
  unverified: 'no source could be verified',
}
const STANCE = { supports: 'supports', contradicts: 'contradicts', unclear: "doesn't settle it" }

export function checksHtml(checks) {
  const list = (Array.isArray(checks) ? checks : []).filter((c) => c && c.claim && VERDICT[c.verdict])
  if (!list.length) return ''
  return `<ul class="checks">${list.map((c) => {
    const sources = (Array.isArray(c.sources) ? c.sources : []).filter((x) => /^https?:\/\//.test(x?.url || ''))
    const items = sources.map((x) => {
      let site = ''
      try { site = new URL(x.url).hostname.replace(/^www\./, '') } catch { /* shown without a name */ }
      return `<li>${esc(STANCE[x.stance] || STANCE.unclear)} · <a href="${esc(x.url)}">${esc(site || x.url)}</a>${x.quote ? `: “${esc(x.quote)}”` : ''}</li>`
    }).join('')
    return `<li><p>${esc(c.claim)}</p><p class="verdict verdict-${esc(c.verdict)}">${esc(VERDICT[c.verdict])}</p>${items ? `<ul>${items}</ul>` : ''}</li>`
  }).join('')}</ul>`
}
