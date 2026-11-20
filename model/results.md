# Results: the engine model

Generated 2026-11-20 by `model/run.mjs` from `model/lec-core.cjs`. Every input is a SCENARIO
unless the code cites a source. The worked building is an 8-unit listing at a 6.27% cap rate. This is a
mechanism model, not a forecast: it shows which design choices move risk and wealth, and by roughly how much.
The tables regenerate on every run; the prose between them was written against these numbers, so reread it
after changing an input.

## 1. One co-op, default governance

Stack: 70% senior at 5% over 30 years (repriced at year 10), 20% junior at 2% interest-only, 10% member
equity ($31,400 a home). Members get the paydown (no appreciation), the share is indexed at 3%, 5% of
market rent is saved (half to the federation pool), one home in seven turns over a year, and refinancing
to pay leavers is capped at 75% of value (senior debt only). Rents and costs grow 3% a year.

| year | value | debt | market rent /mo | charge /mo | average account | reserve |
|---|---|---|---|---|---|---|
| 1 | $2,472,000 | $2,238,114 | $2,691 | $2,558 | $35,178 | $78,458 |
| 3 | $2,622,545 | $2,198,887 | $2,855 | $2,641 | $42,300 | $91,961 |
| 5 | $2,782,258 | $2,165,891 | $3,029 | $2,738 | $49,065 | $106,287 |
| 7 | $2,951,697 | $2,137,230 | $3,213 | $2,848 | $55,691 | $121,485 |
| 10 | $3,225,399 | $2,099,177 | $3,511 | $3,038 | $65,760 | $146,035 |
| 15 | $3,739,122 | $2,040,030 | $4,070 | $3,424 | $84,085 | $192,114 |

A member who joins at the start holds $68,345 after 7 years and $139,632 after 15.

## 2. Interest-rate risk at the senior reset (year 10)

| rate at reset | charge /mo, year 10 | charge /mo, year 11 | market rent /mo, year 11 |
|---|---|---|---|
| 5.0% | $3,038 | $3,108 | $3,616 |
| 6.5% | $3,038 | $3,271 | $3,616 |
| 8.0% | $3,038 | $3,443 | $3,616 |

Long fixed terms remove this risk; a 10-year reset is the conservative case.

## 3. A member with options: co-op vs renting vs a comparable condo

Same starting wealth (a 20% down payment plus 3% closing on a $350,000 condo, the sibling building's 2023
sale) and the same yearly budget; what a path does not spend on housing is invested. Condo: 6.5% 30-year
mortgage, Norfolk's $1.23 per $100 tax (City FAQ, effective 2024-07-01), $450/mo fee, 1% maintenance,
7% to sell. Co-op: the run above. No income taxes modeled. Net worth at the horizon:

| rent growth | value growth (a year) | portfolio return | horizon | renter | condo owner | co-op member |
|---|---|---|---|---|---|---|
| 1% | -0.5% | 6% | 7 years | $148,171 | $62,379 | $173,671 |
| 1% | -0.7% | 6% | 15 years | $254,354 | $90,138 | $325,699 |
| 1% | -0.5% | 8% | 7 years | $166,921 | $62,379 | $186,218 |
| 1% | -0.7% | 8% | 15 years | $328,709 | $90,138 | $377,559 |
| 3% | 3.0% | 6% | 7 years | $134,954 | $148,352 | $180,449 |
| 3% | 3.0% | 6% | 15 years | $215,096 | $340,000 | $379,380 |
| 3% | 3.0% | 8% | 7 years | $153,126 | $148,352 | $193,249 |
| 3% | 3.0% | 8% | 15 years | $283,425 | $341,854 | $436,022 |
| 5% | 6.2% | 6% | 7 years | $128,345 | $252,618 | $195,756 |
| 5% | 6.1% | 6% | 15 years | $204,562 | $700,089 | $504,494 |
| 5% | 6.2% | 8% | 7 years | $146,042 | $252,751 | $208,953 |
| 5% | 6.1% | 8% | 15 years | $270,313 | $708,250 | $571,986 |

Read across a row: the co-op beats renting everywhere here. It beats the condo when values grow slowly or
moderately, and loses to it when values boom, because the condo owner holds the appreciation with leverage.

## 4. The federation

24 co-ops of 6–24 homes, bought at cap rates of 5–7% only if they underwrite (DSCR ≥ 1.15), held for
15 years, 400 runs a case. Each co-op draws its own governance from a menu (senior share 60/70/80%,
savings 3/5/8% of rent, pooled share 0–100%, appreciation credited 0/10/25%, paydown credited 50/100%).
Shocks: interest rates wander (mean-reverting around 5%); a regional rent drop hits in 7% of years and
recovers over three; each co-op faces repair bills of 1–8% of value (6% of years) and vacancy spells (5% of
years). A shortfall is met by the co-op's reserve, then a one-off assessment on members (up to 10% of a
year's charges), then refinancing within 75% of value, then the pool, or the co-op fails and its lender
takes the building.

- **isolated:** no pool.
- **firewalled pool:** each co-op is its own entity; it lends to the pool what it chooses to pool and may draw
  up to a quarter of the pool, or four times what it has put in, in a year; draws are repaid over five years.
- **merged:** one balance sheet and one blanket loan; everything pooled, no limits, and one default takes all.

### 4.1 Architecture under stress

| case | homes lost (mean ± s.e.) | any co-op fails | a quarter or more fail | worst run |
|---|---|---|---|---|
| base, isolated | 2.3% (±0.2%) | 36% | 0.3% | 27% |
| base, firewalled pool | 1.1% (±0.1%) | 23% | 0.0% | 16% |
| base, merged | 0.0% (±0.0%) | 0% | 0.0% | 0% |
| moderate, isolated | 11.6% (±0.9%) | 73% | 13.0% | 100% |
| moderate, firewalled pool | 5.3% (±0.6%) | 53% | 3.8% | 100% |
| moderate, merged | 3.8% (±1.0%) | 4% | 3.8% | 100% |
| severe, isolated | 15.2% (±1.3%) | 63% | 17.3% | 100% |
| severe, firewalled pool | 8.9% (±1.1%) | 44% | 7.2% | 100% |
| severe, merged | 9.0% (±1.4%) | 9% | 9.0% | 100% |

Merged fails least often, but when it fails, it fails whole. The firewalled pool fails more often, in
pieces.

### 4.2 One city or several (severe stress)

| case | homes lost (mean ± s.e.) | any co-op fails | a quarter or more fail | worst run |
|---|---|---|---|---|
| one market, isolated | 15.2% (±1.3%) | 63% | 17.3% | 100% |
| one market, firewalled pool | 8.9% (±1.1%) | 44% | 7.2% | 100% |
| one market, merged | 9.0% (±1.4%) | 9% | 9.0% | 100% |
| four markets, isolated | 15.5% (±0.8%) | 83% | 24.3% | 88% |
| four markets, firewalled pool | 6.9% (±0.5%) | 58% | 8.5% | 60% |
| four markets, merged | 10.0% (±1.5%) | 10% | 10.0% | 100% |

A firewall stops contagion, not a shock that hits everyone at once. Spread across independent markets, the
firewalled pool beats merging in the tail; merging gains nothing from spread, because one default still takes all.

### 4.3 The fluid dial: how much each co-op pools (firewalled)

| case | homes lost (mean ± s.e.) | any co-op fails | a quarter or more fail | worst run |
|---|---|---|---|---|
| moderate, pooled 0% | 11.9% (±0.9%) | 72% | 13.5% | 100% |
| moderate, pooled 25% | 6.7% (±0.7%) | 56% | 5.5% | 100% |
| moderate, pooled 50% | 5.3% (±0.8%) | 40% | 4.3% | 100% |
| moderate, pooled 75% | 4.2% (±0.7%) | 32% | 3.5% | 100% |
| moderate, pooled 100% | 3.5% (±0.7%) | 25% | 3.0% | 100% |
| severe, pooled 0% | 17.2% (±1.4%) | 66% | 19.0% | 100% |
| severe, pooled 25% | 11.6% (±1.4%) | 44% | 10.5% | 100% |
| severe, pooled 50% | 10.0% (±1.4%) | 34% | 9.0% | 100% |
| severe, pooled 75% | 9.6% (±1.4%) | 26% | 9.0% | 100% |
| severe, pooled 100% | 9.3% (±1.4%) | 21% | 9.0% | 100% |

The first quarter pooled does the most. The model does not price what autonomy buys (local control of
reserves, room to experiment), so it will always favor pooling more; that judgment stays with each co-op.

### 4.4 What else moves risk (firewalled, moderate stress unless noted)

| case | homes lost (mean ± s.e.) | any co-op fails | a quarter or more fail | worst run |
|---|---|---|---|---|
| senior debt 60% at purchase | 3.7% (±0.8%) | 17% | 3.5% | 100% |
| senior debt 70% at purchase | 5.7% (±0.7%) | 42% | 4.8% | 100% |
| senior debt 80% at purchase | 15.6% (±0.9%) | 93% | 13.5% | 100% |
| pool seeded with 0% of purchase cost | 6.7% (±0.7%) | 58% | 4.8% | 100% |
| pool seeded with 1% of purchase cost | 5.3% (±0.6%) | 53% | 3.8% | 100% |
| pool seeded with 3% of purchase cost | 4.8% (±0.5%) | 53% | 2.5% | 100% |
| severe; members stay up to 100% of market rent | 8.9% (±1.1%) | 44% | 7.2% | 100% |
| severe; members stay up to 110% of market rent | 5.4% (±0.8%) | 37% | 4.3% | 100% |

Leverage at purchase matters most: the patient junior money is the resilience lever, not only a cheap
one. Members who will pay a little above market through a downturn (their accounts give them a reason)
cut losses by more than half.

### 4.5 Networked learning

Every three years each co-op compares itself with a random peer and, half the time, copies a better peer's
savings, pooled share and member credits (5% of the time it tries a random one). "Survivors" sees only co-ops
still alive. "Public" also sees the federation's ledger of failures by policy and discounts a policy by its
failure rate times what members stand to lose.

| case | homes lost (mean ± s.e.) | any co-op fails | a quarter or more fail | worst run | average account ÷ buy-in | savings | pooled | appreciation credited |
|---|---|---|---|---|---|---|---|---|
| moderate, none | 5.3% (±0.6%) | 53% | 3.8% | 100% | 2.72× | 5.3% | 51% | 12% |
| moderate, survivors | 5.1% (±0.6%) | 52% | 3.3% | 100% | 2.90× | 4.5% | 50% | 16% |
| moderate, public | 4.4% (±0.5%) | 50% | 1.8% | 100% | 2.90× | 4.6% | 50% | 16% |
| moderate, merged, survivors | 4.0% (±1.0%) | 4% | 4.0% | 100% | 2.81× | 4.3% | 96% | 16% |
| severe, none | 8.9% (±1.1%) | 44% | 7.2% | 100% | 2.69× | 5.1% | 49% | 11% |
| severe, survivors | 10.6% (±1.3%) | 43% | 9.3% | 100% | 2.79× | 4.2% | 47% | 15% |
| severe, public | 10.3% (±1.3%) | 42% | 8.8% | 100% | 2.76× | 4.1% | 47% | 15% |
| severe, merged, survivors | 8.5% (±1.4%) | 9% | 8.5% | 100% | 2.75× | 4.0% | 92% | 15% |

Learning from success drifts toward member wealth: less saving, more appreciation credited. Under severe
stress that drift raises losses. The public failure ledger helps a little under moderate stress and not
clearly under severe; the differences sit within about one standard error. Failures here come mostly from
luck and from terms set at purchase, which co-ops cannot copy later, and 24 co-ops give the ledger thin
evidence. A real ledger would carry causes, not just counts.

## 5. What the model leaves out

- Taxes, transaction costs of refinancing, and legal costs of the offering.
- Member behavior beyond a fixed turnover and the charge cap: no runs on accounts, no governance failure.
- Correlation between repair shocks (an old housing stock ages together).
- The value of autonomy, so the dial in 4.3 can only show the protection side.
- The investors' side: whether 5% senior notes sell, and what happens to them when a co-op fails.
