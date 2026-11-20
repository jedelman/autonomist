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

## The site and the agent

One Cloudflare Worker serves everything at `autonomist.jason-edelman.org`:

| path | what |
|---|---|
| `/` | what autonomist is, plainly marked as a public-interest project |
| `/chat/` | the organizer: Claude Haiku 5.5 with tools, behind invite codes and a "Request access" form |
| `/case-studies/` | sourced research, published only after a person checks every source |
| `/model/` | technical papers (the design paper, and `model/results.md` as published results) |
| `/tools/` | public tools that run in the browser: what an asking price means for rent, could we buy it, co-op vs rent vs condo, the federation stress lab |
| `/results/<id>` | a computation saved from the chat, rendered by code from its inputs |
| `/about/` | what "public interest" means here, and privacy |

The agent's tools: `underwrite_building`, `listing_pressure`, `compare_member`, `federation_stress` (the
engine model), `norfolk_parcel` (the City of Norfolk's open data, by address only; never a home's owner
or sale price, and an owner only when it's plainly an organization), `read_published`, `save_result`
(re-computed by code from the inputs before it's stored), and `propose_case_study` (a draft for the
steward, never published automatically). Source: `worker/`.

### Deploy

```bash
npm install
npx wrangler kv namespace create KV          # paste the id into wrangler.toml, uncomment the block
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put INVITE_SECRET        # any long random string
npx wrangler secret put IP_SALT              # any random string
npx wrangler deploy                          # builds public/ first (scripts/build.mjs)
```

Then add `autonomist.jason-edelman.org` as the Worker's Custom Domain (dashboard, or the commented
`routes` line in `wrangler.toml`). Pages work without the KV namespace and secrets; the chat refuses
until all are set (it fails closed). Limits: 30 questions per invite per UTC day and $3 of model spend
for the whole site per day, both in `wrangler.toml`.

Invites and requests: `node scripts/invites.mjs create --label "who it's for"`, `list`, `revoke`,
`requests > ~/autonomist-requests.csv` (keep it out of the repository), `proposals`. Local test:
`npm test`; `npx wrangler dev` with a `.dev.vars` holding the three secrets and a KV binding.

## What else the organizer is meant to do

Built so far: read, underwrite, publish results, propose case studies. Still design, from the working design in power-explained, `analysis/handbook/tool/lec-engine.md`:
- **Watch** listings and public records.
- **Read** a building with receipts.
- **Underwrite** from that building's own numbers.
- **Coordinate** conditional commitments from residents, lenders, patient money and the seller. When the
  stack closes, the deal is ready to offer.
- **Prepare** the documents.
- **Keep the ledger** of members' accounts and the pool.

It never sells securities, gives investment advice, holds money, or files or signs for anyone.
