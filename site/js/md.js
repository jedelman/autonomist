// md.js: a small Markdown renderer with no dependencies. The build uses it for the site's own
// pages; the chat page uses it for the agent's answers. It escapes every character of input
// before adding markup, so text can never become HTML; links survive only when allowLink(url)
// says so (default: same-site paths and https). Covers what the site's pages use: headings,
// paragraphs, lists (nested by indentation), tables, blockquotes, fenced code, hr, and inline
// code, bold, italic and links.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const defaultAllow = (url) => /^\/(?!\/)/.test(url) || /^#[\w-]+$/.test(url) || /^https:\/\/[^\s"'<>]+$/.test(url)

export function inline(text, allowLink = defaultAllow) {
  // pull out code spans first so their contents stay literal
  const codes = []
  let s = String(text).replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000` })
  const links = []
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => { links.push([label, url]); return `\u0001${links.length - 1}\u0001` })
  s = esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?=[^*\w]|$)/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?=[^_\w]|$)/g, '$1<em>$2</em>')
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => {
    const [label, url] = links[+i]
    const inner = inline(label, () => false)
    if (!allowLink(url)) return inner
    const ext = /^https:/.test(url)
    return `<a href="${esc(url)}"${ext ? ' rel="noopener noreferrer"' : ''}>${inner}</a>`
  })
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`)
}

const isTableSep = (l) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(l)
const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim())

export function render(src, { allowLink = defaultAllow, headingIds = true, rawHtml = false } = {}) {
  // rawHtml is for the site's own pages only (the build): HTML comments are dropped and a block that
  // starts with a tag passes through as written. Chat answers never set it.
  if (rawHtml) src = String(src).replace(/<!--[\s\S]*?-->/g, '')
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let i = 0
  const slug = (t) => t.toLowerCase().replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }
    if (rawHtml && /^<(p|ul|ol|div|section|table|figure|details|aside|form)[\s>]/.test(line)) {
      const buf = []
      while (i < lines.length && lines[i].trim()) buf.push(lines[i++])
      out.push(buf.join('\n'))
      continue
    }
    let m
    if ((m = line.match(/^```(\w*)\s*$/))) {
      const buf = []; i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++])
      i++
      out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`)
      continue
    }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      const n = m[1].length, html = inline(m[2], allowLink)
      out.push(`<h${n}${headingIds && n > 1 ? ` id="${slug(html)}"` : ''}>${html}</h${n}>`)
      i++; continue
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push('<hr>'); i++; continue }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && isTableSep(lines[i + 1])) {
      const head = cells(line); i += 2
      const rows = []
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]))
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c, allowLink)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, allowLink)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''))
      out.push(`<blockquote>${render(buf.join('\n'), { allowLink, headingIds: false })}</blockquote>`)
      continue
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const block = []
      while (i < lines.length && (lines[i].trim() === '' ? (i + 1 < lines.length && /^\s+\S|^\s*([-*]|\d+\.)\s+/.test(lines[i + 1])) : /^\s*([-*]|\d+\.)\s+|^\s{2,}\S/.test(lines[i]))) block.push(lines[i++])
      out.push(list(block, allowLink))
      continue
    }
    const buf = []
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|>|\s*([-*]|\d+\.)\s+|(-{3,}|\*{3,})\s*$)/.test(lines[i]) && !(/^\s*\|/.test(lines[i]) && i + 1 < lines.length && isTableSep(lines[i + 1]))) buf.push(lines[i++].trim())
    out.push(`<p>${inline(buf.join(' '), allowLink)}</p>`)
  }
  return out.join('\n')
}

function list(block, allowLink) {
  const indentOf = (l) => l.match(/^\s*/)[0].length
  const base = indentOf(block.find((l) => l.trim()))
  const ordered = /^\s*\d+\./.test(block[0])
  const items = []
  for (const l of block) {
    if (!l.trim()) { if (items.length) items[items.length - 1].push(''); continue }
    if (indentOf(l) === base && /^\s*([-*]|\d+\.)\s+/.test(l)) items.push([l.replace(/^\s*([-*]|\d+\.)\s+/, '')])
    else if (items.length) items[items.length - 1].push(l)
  }
  const li = items.map(([first, ...rest]) => {
    const nested = rest.filter((l) => /^\s*([-*]|\d+\.)\s+/.test(l) || (l.trim() && indentOf(l) > base))
    const sub = nested.length && nested.some((l) => /^\s*([-*]|\d+\.)\s+/.test(l)) ? list(nested, allowLink) : ''
    const cont = sub ? '' : rest.map((l) => l.trim()).filter(Boolean).join(' ')
    return `<li>${inline([first, cont].filter(Boolean).join(' '), allowLink)}${sub}</li>`
  })
  return `<${ordered ? 'ol' : 'ul'}>${li.join('')}</${ordered ? 'ol' : 'ul'}>`
}
