(async function () {
  const { el, table } = T
  const box = document.getElementById('result')
  const id = location.pathname.split('/').filter(Boolean)[1]
  const label = (k) => k.replace(/_/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
  const show = (v) => (v == null ? '–' : typeof v === 'number' ? (Math.abs(v) >= 1000 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 1000) / 1000)) : String(v))
  function rows(obj, prefix = '') {
    const out = []
    for (const [k, v] of Object.entries(obj || {})) {
      if (k === 'reading' || k === 'inputs_used') continue
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(...rows(v, prefix + label(k) + ' · '))
      else out.push([prefix + label(k), show(v)])
    }
    return out
  }
  try {
    const res = await fetch(`/api/results/${encodeURIComponent(id || '')}`)
    const r = await res.json()
    if (!res.ok) throw new Error(r.error || 'Not found.')
    document.title = `${r.title} · autonomist`
    box.replaceChildren(
      el('h1', {}, r.title),
      el('p', { class: 'byline' }, `Saved ${r.created} · tool: ${r.tool.replace(/_/g, ' ')}`),
      el('h2', {}, 'Inputs'), table(['Input', 'Value'], rows(r.inputs)),
      el('h2', {}, 'Results'), table(['Result', 'Value'], rows(r.outputs)),
      r.outputs.reading ? el('p', { class: 'muted' }, r.outputs.reading) : '',
    )
  } catch (e) {
    box.replaceChildren(el('h1', {}, 'No such result'), el('p', {}, String(e.message || e)))
  }
})()
