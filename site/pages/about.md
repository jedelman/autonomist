---
title: About and privacy · autonomist
description: What it means that autonomist is a public-interest project, and what it does with your information.
---
# About and privacy

## A public-interest project

autonomist is a public-interest project of Jason Edelman. It is not a company, it has no customers, and it sells nothing.

- **No securities, investments or loans.** Nothing on this site is an offer to sell securities or a solicitation of an offer to buy them. Where the model talks about senior notes, solidarity money or member shares, it is describing how a co-op could be financed, not offering any.
- **No advice.** Nothing here is investment, financial, legal or tax advice. The model's numbers are scenarios that show how a design behaves, not forecasts. For a real building, talk to a lawyer, a tenant-rights group and a lender who works with cooperatives.
- **No money, no signatures.** autonomist holds no one's money and files or signs nothing for anyone. It prepares and explains.
- **Not the government.** autonomist is independent and not affiliated with the City of Norfolk or any public body. Norfolk building records come from the City's open data portal, read as any member of the public could.

## The chat agent

The chat is an AI: Claude, by Anthropic. It can be wrong. It computes with the engine model and reads public records, and it says which numbers it computed and which it assumed.

- **Your questions go to Anthropic** to be answered. autonomist doesn't store conversations: the chat keeps yours in your browser tab, and it's gone when you close the tab.
- **It reads buildings, not people.** The building lookup takes an address only. It never shows the owner or sale price of a home, and it shows an apartment or commercial building's owner only when the owner is plainly an organization.
- **Saved results are public.** When you ask for a link, the result page shows the computation and a title, rendered from the inputs by code. Nothing else from your conversation appears there.
- **Case-study proposals go to a person.** The agent can send a draft to the project's steward; nothing is published until every source has been checked.

## Request access

The chat is invite-only while it's new. The request form asks for an email (and, if you like, a name, an organization and a note). It's used only to send you an invite and news about autonomist, it's kept out of the public source code, and it's deleted on request.

<!-- TODO (Jason): the contact address for deletion requests and questions. -->

## Limits and logs

To keep costs bounded, the site counts questions per invite and per day, and spending for the whole site per day. Visitors are counted by a salted hash of their network address, never the address itself. The server logs which tools an answer used and what it cost, never the question or the answer. There are no trackers or analytics.

## Source

The code, the model and its results are public under the MIT license at [github.com/jedelman/autonomist](https://github.com/jedelman/autonomist).
