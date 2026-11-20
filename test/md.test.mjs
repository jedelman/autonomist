import { test } from 'node:test'
import assert from 'node:assert/strict'
import { render } from '../site/js/md.js'

test('escapes HTML in text and code', () => {
  const html = render('Hello <script>alert(1)</script> `<b>`')
  assert.ok(!html.includes('<script>'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(html.includes('<code>&lt;b&gt;</code>'))
})

test('drops links that are not allowed, keeps allowed ones', () => {
  const html = render('[a](javascript:alert(1)) [b](/tools/) [c](https://evil.example/)', { allowLink: (u) => u.startsWith('/') })
  assert.ok(!html.includes('javascript:'))
  assert.ok(html.includes('<a href="/tools/">b</a>'))
  assert.ok(!html.includes('evil.example'))
})

test('raw HTML passes only when the build asks for it', () => {
  assert.ok(!render('<p class="x">hi</p>').includes('<p class="x">'))
  assert.ok(render('<p class="x">hi</p>', { rawHtml: true }).includes('<p class="x">'))
  assert.ok(!render('<!-- TODO: secret -->\n\ntext', { rawHtml: true }).includes('TODO'))
})

test('tables, lists and headings', () => {
  const html = render('## Two\n\n- a\n  - b\n\n| x | y |\n|---|---|\n| 1 | 2 |')
  assert.ok(html.includes('<h2 id="two">Two</h2>'))
  assert.ok(html.includes('<ul><li>a<ul><li>b</li></ul></li></ul>'))
  assert.ok(html.includes('<td>1</td>'))
})
