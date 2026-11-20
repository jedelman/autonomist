# autonomist

An AI organizer for an autonomous cooperative federation.

Jason Edelman, 2026-11-20: "What I'm really trying to do is solve the bootstrap and exit problems for
limited-equity cooperatives in a way that is competitive with other investment options, for people that
_have_ investment options. I believe, that with a coordinated strategy, we can beat back private equity
and vulture capitalism - but everything rides on that coordination." It is a sibling of Siren (his
civic agent): "More radical than Siren, more action-focused."

## Design commitments so far

- **Each co-op governs its own split.** How much of the loan paydown and the appreciation goes to
  members is "a governance question for each coop".
- **A federation that firewalls risk.** Co-ops are "financially isolated from each other but have access
  to a common pool of resources", so that failures, which "will happen", don't cascade.
- **Different risk models, for networked learning.** Co-ops choose differently, and the federation learns
  from the spread. The balance between autonomous risk and collective protection "should be fluid".
- **The model is the nervous system.** Updated live and made public. It lives in `model/`.

## The model

`model/lec-core.cjs` is the engine model. It runs in Node and in a browser (`window.LEC`), so a public
page can run the same code. It covers:
- **One co-op over time:** a tranched capital stack, members' accounts (an indexed share plus whatever
  paydown and appreciation the co-op credits), turnover paid by refinancing within a loan-to-value cap,
  reserves, and the federation pool.
- **A member with options:** co-op vs renting vs a comparable condo, from the same starting wealth and
  the same budget.
- **A federation:** Monte Carlo over co-ops that are isolated, firewalled with a shared pool, or merged
  onto one balance sheet. It includes rate, regional, repair and vacancy shocks, an underwriting gate,
  the pooling dial, several markets, and peer learning with or without a public ledger of failures.

Run `node model/run.mjs`. It regenerates `model/results.md` (the tables, with what they show and what
the model leaves out) and `model/results.json`. Every input is a SCENARIO unless the code cites a
source.

What the current numbers say (read `results.md` for the conditions):
- **Against renting,** the co-op member comes out ahead in every case run.
- **Against a condo,** the member comes out ahead when values grow slowly or moderately, and behind when
  they boom.
- **The architectures fail differently.** A merged federation fails least often but fails whole. A
  firewalled pool fails more often, in pieces.
- **Spread across independent markets,** the firewalled pool beats merging in the tail. A firewall
  stops contagion, not a shock that hits everyone at once.
- **Leverage at purchase moves risk most.** The patient junior money is the resilience lever. The first
  quarter of savings pooled does the most of the dial's work.

## What the organizer would do (design, not built)

From the working design in power-explained, `analysis/handbook/tool/lec-engine.md`:
- **Watch** listings and public records.
- **Read** a building with receipts.
- **Underwrite** from that building's own numbers.
- **Coordinate** conditional commitments from residents, lenders, patient money and the seller. When the
  stack closes, the deal is ready to offer.
- **Prepare** the documents.
- **Keep the ledger** of members' accounts and the pool.

It never sells securities, gives investment advice, holds money, or files or signs for anyone.
