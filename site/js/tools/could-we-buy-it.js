T.wire((f) => {
  const { val, el, usd, times, table } = T
  const b = { units: val(f, 'units'), price: val(f, 'price'), repairs: val(f, 'repairs') || 0 }
  if (val(f, 'noi') != null) b.noi = val(f, 'noi'); else if (val(f, 'cap') != null) b.capRate = val(f, 'cap') / 100; else throw new Error('Enter the net operating income or the cap rate.')
  const u = LEC.underwrite(b)
  const names = { commons: 'Commons', cdfi: 'Community lender + seller note', patient: 'Patient lender', bank: 'Bank (typical private buyer)' }
  const rows = Object.entries(u.stacks).map(([k, s]) => [names[k], times(s.dscr), usd(s.cashAfterDebt), usd(s.cashPerHomeMonth), usd(s.equity), usd(s.equityPerHome), usd(s.maxCost)])
  return [
    el('p', {}, `Total cost ${usd(u.need)} (${usd(u.perHome)} a home). Net operating income ${usd(u.noi)} a year.`),
    table(['Way of paying', 'Covers payments', 'Left a year', 'A home a month', 'Cash up front', 'A home', 'Could pay'], rows),
    el('p', { class: 'big' }, `The commons stack could pay ${usd(u.coordinationDividend)} more than the bank-financed buyer and still cover its payments 1.15 times. That's what coordination is worth on this building.`),
  ]
})
