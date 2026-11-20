T.wire((f) => {
  const { val, el, pct, table } = T
  const stress = { base: { shockScale: 1, regionalDrop: 0.1 }, moderate: { shockScale: 2, regionalDrop: 0.1 }, severe: { shockScale: 1, regionalDrop: 0.25 } }[f.elements.stress.value]
  const F = { architecture: f.elements.arch.value, ...stress, runs: Math.min(400, Math.max(20, val(f, 'runs') || 200)), regions: Math.min(8, Math.max(1, Math.round(val(f, 'regions') || 1))) }
  if (f.elements.pooled.value !== '') F.pooledFixed = Number(f.elements.pooled.value)
  if (f.elements.senior.value !== '') F.menu = { senior: [Number(f.elements.senior.value)] }
  const r = LEC.federation(F)
  return [
    table(['Homes lost (average)', 'Any co-op fails', 'A quarter or more fail', 'Worst run'], [[pct(r.homesLostShare), pct(r.pAnyFail, 0), pct(r.pSystemic), pct(r.worstHomesLost, 0)]]),
    el('p', { class: 'muted' }, `${r.runs} runs. Members' accounts end at ${r.memberAcct.toFixed(2)}× their buy-in on average, in co-ops that survive. Rerun with a different design to compare.`),
  ]
})
