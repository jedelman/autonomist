import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { checkEntry, extractQuotes, normalize, htmlToText, parseRobots, robotsDecision, SECTIONS } from '../scripts/journal-check.mjs'

const entry = (over = {}, body = null) => {
  const meta = { title: 'T', summary: 'S', date: '2026-11-23', outlet: 'O', headline: 'H', source: 'https://a.example/x', sources: 'https://a.example/x https://b.example/y', written: 'W', ...over }
  const fm = Object.entries(meta).filter(([, v]) => v !== null).map(([k, v]) => `${k}: ${v}`).join('\n')
  return `---\n${fm}\n---\n# T\n\n${body ?? SECTIONS.map((s) => `## ${s}\n\nText with “a quote”.\n`).join('\n')}`
}

test('every published entry has the shape the journal requires', () => {
  const dir = new URL('../content/journal/', import.meta.url)
  const names = readdirSync(dir).filter((n) => n.endsWith('.md'))
  assert.ok(names.length > 0)
  for (const n of names) assert.deepEqual(checkEntry(n, readFileSync(new URL(n, dir), 'utf8')), [], n)
})

test('a sound entry passes; missing fields, sections, quotes and a stray source are caught', () => {
  assert.deepEqual(checkEntry('2026-11-23-x.md', entry()), [])
  assert.ok(checkEntry('2026-11-23-x.md', entry({ written: null })).includes('missing written:'))
  assert.ok(checkEntry('2026-11-22-x.md', entry()).includes('the file name must start with the date'))
  assert.ok(checkEntry('2026-11-23-x.md', entry({ sources: 'https://b.example/y' })).includes('sources: must include the source'))
  assert.ok(checkEntry('2026-11-23-x.md', entry({ sources: 'https://a.example/x http://plain.example/' })).some((p) => p.startsWith('sources: not an https URL')))
  assert.ok(checkEntry('2026-11-23-x.md', entry({}, '## What it says\n\n“q”\n')).some((p) => p.startsWith('missing section')))
  assert.ok(checkEntry('2026-11-23-x.md', entry({}, SECTIONS.map((s) => `## ${s}\n\nno quotes\n`).join('\n'))).includes('no quoted passages: quote the source at least once'))
})

test('quotes: only curly double quotes count, trailing punctuation dropped', () => {
  assert.deepEqual(extractQuotes('He said “one,” then "two" and “three.”'), ['one', 'three'])
})

test('normalize folds what copying changes, and an HTML page reads as its text', () => {
  assert.equal(normalize('It’s  “Done” — fully­'), 'it\'s "done" - fully')
  const text = normalize(htmlToText('<p>Held in place by the <em>absence</em> of&nbsp;functioning alternatives.</p><script>x</script>'))
  assert.ok(text.includes(normalize('held in place by the absence of functioning alternatives')))
})

test('robots: Content-Signal ai-input=no closes a site; our own group wins over *; the longest rule wins', () => {
  assert.equal(robotsDecision(parseRobots('Content-Signal: search=yes, ai-input=no'), 'https://x.example/a').ok, false)
  assert.equal(robotsDecision(parseRobots(''), 'https://x.example/a').ok, true)
  const r = parseRobots('User-agent: *\nDisallow: /\n\nUser-agent: autonomist\nAllow: /news/\nDisallow: /news/private')
  assert.equal(robotsDecision(r, 'https://x.example/news/today').ok, true)
  assert.equal(robotsDecision(r, 'https://x.example/news/private/1').ok, false)
  assert.equal(robotsDecision(parseRobots('User-agent: *\nDisallow: /'), 'https://x.example/a').ok, false)
  // a robots.txt that is only comments (Jacobin's, read 2026-11-23) neither grants nor restricts
  assert.equal(robotsDecision(parseRobots('# content signals preamble\n# ai-input: ...'), 'https://x.example/a').ok, true)
})
