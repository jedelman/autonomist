---
title: "The engine: limited-equity co-ops that people with options would choose"
summary: The design paper. Members get the paydown, the commons keeps the appreciation, leaving members are paid by refinancing, and three kinds of capital are each paid what they need.
date: 2026-11-20
---
# The engine: limited-equity co-ops that people with options would choose

<p class="byline">Jason Edelman and Claude · working paper · 2026-11-20</p>

> "What I'm really trying to do is solve the bootstrap and exit problems for limited-equity cooperatives in a way that is competitive with other investment options, for people that _have_ investment options. I believe, that with a coordinated strategy, we can beat back private equity and vulture capitalism - but everything rides on that coordination." (Jason Edelman)

This is a working design, not a finding. The numbers come from the engine model (`model/lec-core.cjs`) on one sound 8-unit apartment building, using its listed price ($2.4 million) and cap rate (6.27%). Every rate and split is a scenario. The model's full results are in [Results: the engine model](/model/results/).

## 1. Why limited-equity co-ops lose people with options

A limited-equity co-op has two exit problems.

- **The member's exit.** A member leaves with their share plus a capped gain. The limited-equity co-ops in an Urban Institute evaluation used "fixed or prime-rate indices" for that gain ([Temkin, Theodos and Price, 2010](https://www.urban.org/sites/default/files/publication/29291/412244-Balancing-Affordability-and-Opportunity-An-Evaluation-of-Affordable-Homeownership-Programs-with-Long-term-Affordability-Controls.PDF)). Someone who could buy a condo instead gives up appreciation and the equity a mortgage builds.
- **The building's exit.** Co-ops end. In Washington, DC, a 2004 study listed "all 81 LECs established... since 1977, and an inventory of those 57 still functioning", as quoted in a 2020 report that does not say why the other 24 ended ([Howell, Bruton and Clemens, 2020](https://cnhed.org/wp-content/uploads/2020/10/Creating-and-Sustaining-Limited-Equity-Cooperatives-in-Washington-DC_REV.pdf)).

There is also a bootstrap problem. A co-op raises equity slowly, usually from residents who have little, against buyers who close fast.

## 2. The design: split a building's equity growth in two

A building gains equity in two ways: its loan is paid down, and its value rises.

- **Paydown goes to members.** Each member's account holds their share, indexed, plus the principal their carrying charges paid off while they lived there. That is the wealth an owner builds by paying down a mortgage, without a bet on the sale price.
- **Appreciation stays with the commons.** The building is never sold. As its value rises, it becomes collateral for the next building.
- **A leaving member is paid by refinancing, never by selling.** The co-op borrows back the principal it paid down and pays out the member's account. A new member buys in at the indexed share price, so getting in stays affordable. With steady turnover, the loan stays near its original size while the building's value rises, so its real leverage falls.
- **The lock** is a third party's veto on resale, the model of Germany's [Mietshäuser Syndikat](https://www.syndikat.org/en/the-joint-venture), so members can't vote the building out of the commons.

How the split is set is each co-op's own decision. Paydown, appreciation and indexation are governance choices, and the federation is built to let co-ops choose differently (section 5).

## 3. Three kinds of capital, each paid what it needs

| part | who might supply it | share of cost | return (scenario) |
|---|---|---|---|
| senior notes | allies with savings, credit unions, institutions | 70% | 5%, paid down over 30 years, secured by the building |
| solidarity money | foundations, congregations, patient allies | 20% | 2%, interest only |
| member equity | residents | 10% ($30,500 a home here) | indexed 3% a year, plus the paydown credited |

Blended, that is 4.2% a year. On the worked building (price plus repairs $2.44 million, net operating income $150,480):

- **The commons stack** covers its loan payments 1.24 times over, leaving $29,612 a year, $308 a home a month.
- **A private-equity buyer** borrowing 70% at 7% covers its payments 1.09 times and earns 1.8% a year on its $732,000 of cash. A 6.27% cap rate against an 8.06% loan payment is negative leverage. At this price, that buyer makes its return only by raising rents or converting the building to condos.
- **Covering payments 1.15 times over, the commons can pay up to $2.64 million; the private-equity buyer, $2.32 million.** That gap of about $320,000 is what coordination is worth: cheaper money, pooled and committed in advance, outbids a buyer who needs 15%.

## 4. The member's side

Members of the worked building pay charges below market rent and build an account. In the model's default run (which also funds reserves and a contribution to the federation pool), a member who joins at the start holds about $68,000 after 7 years, on a $31,400 buy-in. Against renting at market, the co-op member comes out ahead in every case the model ran. Against a comparable condo, the member comes out ahead when values grow about 3% a year or less, and behind when they grow about 6%, because the condo owner holds the appreciation with leverage. The member's exit is guaranteed at book value; a condo seller pays to sell and takes the market's timing. The tables are in [Results, section 3](/model/results/#3-a-member-with-options-co-op-vs-renting-vs-a-comparable-condo).

## 5. A federation that firewalls risk

> "If coops are financially isolated from each other but have access to a common pool of resources we can hopefully prevent failures from cascading - because they will happen. It's a balance between autonomous risk and the protection that comes with collectivization - that should be fluid." (Jason Edelman)

The model compares three designs under random shocks: co-ops on their own, co-ops that are separate entities sharing a pool, and co-ops merged onto one balance sheet. Merging fails least often, but when it fails, it fails whole. The firewalled pool fails more often, in pieces. Neither protects against a shock that hits every co-op at once. Spreading the federation across independent markets does: across four markets, the firewalled pool's worst run loses 60% of homes, while the merged federation's still loses all of them. The first quarter of savings pooled does most of the protecting. Leverage at purchase matters more than any other choice, which makes the patient solidarity money the resilience lever, not only a cheap one. Details: [Results, section 4](/model/results/#4-the-federation).

One result cuts against the design. Co-ops that learn by copying whichever peer looks richest drift toward saving less and crediting more appreciation, and that raises losses under severe stress. A public ledger of failures barely helped at 24 co-ops. For the federation's nervous system to teach the right lessons, it has to record why a co-op failed, not only that it did.

## 6. Risks and unknowns

- **Interest rates.** Leaving members are paid by refinancing, so a rate spike raises everyone's charges. Long fixed-rate loans and modest leverage are the defense.
- **Solidarity money is scarce.** Without the 20% at 2%, the numbers need a lower price or a larger member share.
- **Securities law.** Notes sold to many people are securities, and any real offering needs a lawyer and a lawful route. autonomist offers none.
- **Commitments have to be binding.** To beat a cash buyer's speed, commitments must be real and in escrow at the moment they add up, not pledges.
- **Governance wears people out.** Volunteer boards tire; a federation has to supply shared services.
- **The model leaves out** taxes, refinancing and offering costs, runs on members' accounts, an aging housing stock failing at once, the value of autonomy itself, and the investors' side.
