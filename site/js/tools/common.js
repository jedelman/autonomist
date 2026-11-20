// Shared helpers for the tool pages: number formatting and safe DOM building (text only).
(function () {
  const usd = (x) => (x == null || !isFinite(x) ? '–' : (x < 0 ? '−$' : '$') + Math.round(Math.abs(x)).toLocaleString('en-US'))
  const pct = (x, d = 1) => (x == null || !isFinite(x) ? '–' : (x * 100).toFixed(d) + '%')
  const times = (x) => (x == null || !isFinite(x) ? '–' : x.toFixed(2) + '×')
  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag)
    for (const [k, v] of Object.entries(attrs || {})) { if (k === 'class') n.className = v; else n.setAttribute(k, v) }
    for (const k of kids.flat()) n.append(k instanceof Node ? k : document.createTextNode(String(k)))
    return n
  }
  function table(head, rows) {
    return el('div', { class: 'table' }, el('table', {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))), el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c)))))))
  }
  const val = (form, name) => { const v = form.elements[name]?.value; return v === '' || v == null ? null : Number(v) }
  function wire(run) {
    const form = document.getElementById('f'), out = document.getElementById('out')
    const go = (e) => { if (e) e.preventDefault(); out.replaceChildren(); try { out.append(...[].concat(run(form))) } catch (err) { out.append(el('p', { class: 'bad' }, String(err.message || err))) } }
    form.addEventListener('submit', go)
    go()
  }
  window.T = { usd, pct, times, el, table, val, wire }
})()
