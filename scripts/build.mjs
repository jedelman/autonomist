// build.mjs: renders the site into public/ for Workers Static Assets. wrangler runs it before
// every deploy ([build] in wrangler.toml); `npm run build` runs it by hand.
//
// Sources:
//   site/layout.html          the page shell
//   site/pages/**/*.md        pages (index.md is a section's front page; {{list}} lists the section)
//   site/tools/*.html         the public tools, with front matter
//   site/chat.html, site/results.html   the chat and the saved-result shell
//   content/model/*.md        technical papers; model/results.md is published as /model/results/
//   content/case-studies/*.md case studies (each reviewed before it is added)
//   content/journal/*.md      the news journal: commentary on what autonomist reads (checked by scripts/journal-check.mjs)
//   site/css, site/js, site/favicon.svg, and model/lec-core.cjs (as /js/lec-core.js)
// Also writes public/content-index.json, which the agent reads to cite what is published.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { render, esc } from '../site/js/md.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'public')
const read = (p) => readFileSync(join(root, p), 'utf8')
const layout = read('site/layout.html')

function frontMatter(src) {
  const m = src.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { meta: {}, body: src }
  const meta = {}
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':')
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^"(.*)"$/, '$1')
  }
  return { meta, body: src.slice(m[0].length) }
}

function page({ title, description = '', content, section = '', scripts = '', bodyClass = '', wide = false }) {
  let html = layout
    .replace('{{title}}', esc(title))
    .replace('{{description}}', esc(description))
    .replace('{{bodyClass}}', bodyClass)
    .replace('{{mainClass}}', wide ? 'wide' : '')
    .replace('{{content}}', content)
    .replace('{{scripts}}', scripts)
  for (const s of ['chat', 'journal', 'thinking', 'case-studies', 'model', 'tools']) html = html.replace(`{{nav:${s}}}`, s === section ? ' aria-current="page"' : '')
  return html
}

function write(path, html) {
  const file = join(out, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, html)
}

function copyDir(from, to) {
  mkdirSync(to, { recursive: true })
  for (const name of readdirSync(from)) {
    const a = join(from, name), b = join(to, name)
    statSync(a).isDirectory() ? copyDir(a, b) : copyFileSync(a, b)
  }
}

const md = (body) => render(body, { rawHtml: true })
const listHtml = (items, empty) => items.length
  ? `<ul class="cards">${items.map((x) => `<li><a href="${esc(x.url)}">${esc(x.title)}</a>${x.summary ? `<p>${esc(x.summary)}</p>` : ''}</li>`).join('')}</ul>`
  : `<p class="muted">${esc(empty)}</p>`

rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
copyDir(join(root, 'site/css'), join(out, 'css'))
copyDir(join(root, 'site/js'), join(out, 'js'))
copyFileSync(join(root, 'model/lec-core.cjs'), join(out, 'js/lec-core.js'))
copyFileSync(join(root, 'site/favicon.svg'), join(out, 'favicon.svg'))

const index = { journal: [], 'case-studies': [], model: [], tools: [] }

// papers: content/model/*.md, then the generated results
const papers = []
for (const name of readdirSync(join(root, 'content/model')).filter((n) => n.endsWith('.md')).sort()) {
  const { meta, body } = frontMatter(read(`content/model/${name}`))
  papers.push({ slug: name.replace(/\.md$/, ''), title: meta.title, summary: meta.summary, body })
}
{
  const body = read('model/results.md')
  papers.push({ slug: 'results', title: 'Results: the engine model', summary: 'The model\'s tables, regenerated on every run: one co-op over time, interest-rate risk, a member with options, and a federation under stress.', body })
}
for (const p of papers) {
  const url = `/model/${p.slug}/`
  write(`model/${p.slug}/index.html`, page({ title: `${p.title} · autonomist`, description: p.summary, content: md(p.body), section: 'model', wide: p.slug === 'results' }))
  index.model.push({ slug: p.slug, title: p.title, summary: p.summary, url, text: p.body.slice(0, 24000) })
}

// case studies
const csDir = join(root, 'content/case-studies')
for (const name of (existsSync(csDir) ? readdirSync(csDir) : []).filter((n) => n.endsWith('.md')).sort()) {
  const { meta, body } = frontMatter(read(`content/case-studies/${name}`))
  const slug = name.replace(/\.md$/, ''), url = `/case-studies/${slug}/`
  write(`case-studies/${slug}/index.html`, page({ title: `${meta.title} · autonomist`, description: meta.summary, content: md(body), section: 'case-studies' }))
  index['case-studies'].push({ slug, title: meta.title, summary: meta.summary, url, text: body.slice(0, 24000) })
}

// the journal: content/journal/*.md, newest first
const jDir = join(root, 'content/journal')
const journal = existsSync(jDir) ? readdirSync(jDir).filter((n) => n.endsWith('.md')).map((name) => ({ name, ...frontMatter(read(`content/journal/${name}`)) })) : []
journal.sort((a, b) => b.name.localeCompare(a.name))
for (const { name, meta, body } of journal) {
  const slug = name.replace(/\.md$/, ''), url = `/journal/${slug}/`
  write(`journal/${slug}/index.html`, page({ title: `${meta.title} · autonomist`, description: meta.summary, content: md(body), section: 'journal' }))
  index.journal.push({ slug, title: meta.title, summary: `${meta.date} · on ${meta.outlet}: ${meta.summary}`, url, text: body.slice(0, 24000) })
}

// tools
const tools = []
for (const name of readdirSync(join(root, 'site/tools')).filter((n) => n.endsWith('.html'))) {
  const { meta, body } = frontMatter(read(`site/tools/${name}`))
  const slug = name.replace(/\.html$/, '')
  const scripts = (body.match(/<script[\s\S]*?<\/script>/g) || []).join('\n')
  tools.push({ slug, meta, content: body.replace(/<script[\s\S]*?<\/script>\s*/g, ''), scripts })
}
tools.sort((a, b) => Number(a.meta.order || 99) - Number(b.meta.order || 99))
for (const t of tools) {
  const url = `/tools/${t.slug}/`
  write(`tools/${t.slug}/index.html`, page({ title: `${t.meta.title} · autonomist`, description: t.meta.summary, content: t.content, scripts: t.scripts, section: 'tools' }))
  index.tools.push({ slug: t.slug, title: t.meta.title, summary: t.meta.summary, url, text: t.content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 6000) })
}

// pages, with section lists
function walk(dir) {
  return readdirSync(dir).flatMap((n) => { const p = join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p] })
}
const sectionOf = (rel) => rel.split('/')[0].replace(/\.md$/, '')
for (const file of walk(join(root, 'site/pages')).filter((p) => p.endsWith('.md'))) {
  const rel = relative(join(root, 'site/pages'), file)
  let { meta, body } = frontMatter(readFileSync(file, 'utf8'))
  const section = rel.includes('/') ? sectionOf(rel) : ''
  if (body.includes('{{list}}')) {
    const items = index[section] || []
    const empty = section === 'case-studies' ? 'None are published yet.' : 'Nothing here yet.'
    const list = listHtml(items, empty)
    body = body.replace('{{list}}', section === 'journal' ? `<div id="journal-list">${list}</div>` : list)
  }
  const target = rel === 'index.md' ? 'index.html' : rel.endsWith('/index.md') ? rel.replace(/index\.md$/, 'index.html') : rel.replace(/\.md$/, '/index.html')
  // a page's own scripts (external files only, under the strict CSP) go at the end of the body, as on the tool pages
  const scripts = (body.match(/<script[\s\S]*?<\/script>/g) || []).join('\n')
  body = body.replace(/<script[\s\S]*?<\/script>\s*/g, '')
  write(target, page({ title: meta.title || 'autonomist', description: meta.description, content: md(body), scripts, section }))
}

// chat, the saved-result shell, and 404
for (const [src, target, section, bodyClass] of [['site/chat.html', 'chat/index.html', 'chat', 'chat'], ['site/results.html', 'results/index.html', '', ''], ['site/admin.html', 'admin/index.html', '', '']]) {
  const { meta, body } = frontMatter(read(src))
  const scripts = (body.match(/<script[\s\S]*?<\/script>/g) || []).join('\n')
  write(target, page({ title: meta.title, description: meta.description, content: body.replace(/<script[\s\S]*?<\/script>\s*/g, ''), scripts, section, bodyClass, wide: target.startsWith('results') }))
}
// the shell the Worker fills for journal entries autonomist wrote itself (worker/journal-pages.js)
write('_shell/journal.html', page({ title: '{{journal:title}}', description: '{{journal:description}}', content: '<!--journal:content-->', section: 'journal' }))
// the same shell under Thinking, for the notes on people who opted in (worker/known-pages.js)
write('_shell/known.html', page({ title: '{{journal:title}}', description: '{{journal:description}}', content: '<!--journal:content-->', section: 'thinking' }))
write('404.html', page({ title: 'Not found · autonomist', content: '<h1>Not found</h1><p>There is no page at this address. Try the <a href="/">front page</a>.</p>' }))
write('robots.txt', 'User-agent: *\nDisallow: /api/\nDisallow: /results/\nDisallow: /admin/\nDisallow: /_shell/\nDisallow: /known/\nDisallow: /newsletter/confirm/\n')
write('content-index.json', JSON.stringify(index))
console.log(`built public/: ${papers.length} papers, ${index.journal.length} journal entries, ${index['case-studies'].length} case studies, ${tools.length} tools`)
