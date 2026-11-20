T.wire((f) => {
  const { val, el, usd, pct, times } = T
  const p = { price: val(f, 'price'), ltv: val(f, 'ltv') / 100, rate: val(f, 'rate') / 100, years: val(f, 'years'), dscr: val(f, 'dscr'), costShare: val(f, 'cost') / 100 }
  if (val(f, 'noi') != null) p.noi = val(f, 'noi'); else if (val(f, 'cap') != null) p.capRate = val(f, 'cap') / 100; else throw new Error('Enter the net operating income or the cap rate.')
  const x = LEC.pressure(p)
  const rise = x.riseNeeded
  const lines = [
    el('p', { class: 'big' }, rise > 0
      ? `A buyer paying ${usd(p.price)} on these terms would need the building to earn ${usd(x.noiNeeded)} a year: ${pct(rise)} more than today's ${usd(x.noi)}.`
      : `On these terms, today's income of ${usd(x.noi)} already covers a buyer's loan at ${usd(p.price)}; no rise is needed.`),
    el('p', {}, `Today's income covers the loan payments ${times(x.dscrAtAsk)} (the lender wants ${times(p.dscr)}). Loan payments: ${usd(x.debtService)} a year.`),
  ]
  if (rise > 0 && x.rentRiseNeeded != null) lines.push(el('p', {}, `If operating costs are ${pct(p.costShare, 0)} of rent, that's about ${pct(x.rentRiseNeeded)} more in rent across the building.`))
  lines.push(el('p', {}, `The price that works on today's income with these terms: ${usd(x.priceThatWorks)}.`))
  return lines
})
