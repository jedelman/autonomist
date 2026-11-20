T.wire((f) => {
  const { val, el, usd, table } = T
  const years = Math.min(15, Math.max(1, Math.round(val(f, 'years') || 7)))
  const run = LEC.runCoop({ years: 15, market: { rentGrowth: (val(f, 'growth') ?? 3) / 100 } })
  const x = LEC.compare(run, { portfolio: (val(f, 'port') ?? 6) / 100, mortgageRate: (val(f, 'mort') ?? 6.5) / 100, condoPrice: val(f, 'condo') || 350000 })[years - 1]
  const best = [['renter', x.renter], ['condo owner', x.condo], ['co-op member', x.member]].sort((a, b) => b[1] - a[1])[0][0]
  return [
    table(['', 'Renter', 'Condo owner', 'Co-op member'], [
      [`Net worth after ${years} year${years > 1 ? 's' : ''}`, usd(x.renter), usd(x.condo), usd(x.member)],
      ['Housing cost a month, final year', usd(x.rent / 12), usd(x.condoCost / 12), usd(x.coop / 12)],
    ]),
    el('p', { class: 'big' }, `Ahead here: the ${best}.`),
    el('p', { class: 'muted' }, `The co-op member bought in for ${usd(run.buyIn0)} and leaves with an account of ${usd(run.ownAcct[years - 1])}.`),
  ]
})
