---
title: "The public agent"
summary: A working paper. An agent whose conversations are a public record, whose memory only the agent writes, which holds no authority to act, and whose questions and reasoning anyone can query and carry away.
date: 2026-11-20
---
# The public agent

<p class="byline">Jason Edelman and Claude · working paper · 2026-11-20</p>

Most AI agents today are private and enclosed. One user talks to them. The vendor holds their memory, and what they learn accrues to the vendor. This paper describes the opposite: an agent that belongs to the people who use it, the way a commons belongs to the people who govern it. It is a design, not a finding, and autonomist is where it is being built.

## 1. Three scenarios that turned out to be one

Three ideas for making autonomist serve several communities came up separately:

- **a shared conversation**, for a group rather than a person;
- **a community profile**: its buildings, records, law and tools;
- **a federation ledger**: what co-ops chose, what happened, and why.

They are one thing. A community is its members, its place and its memory. A public agent is those three held in common, with an agent working inside them.

## 2. The rules

These are Jason Edelman's, as he set them:

> "ONLY the agent writes the memory. All user interactions with the agent are public."

> "The agent holds no authority to act - merely to aggregate and process data. The data is public and portable."

> "Questions and reasoning are queryable and portable. atproto fits."

> "Nothing that's publication-risk should ever go to the agent. Disclaim but don't gate."

What each one settles:

- **Only the agent writes the memory.** Nobody can poison the memory by writing into it, because nobody but the agent writes it, the steward included. People change it the only way anyone can: by saying something in public that the agent then records. A correction is a new turn, never an edit. The memory is plain text the agent writes from the conversation alone, and anyone can read it.
- **Everything said to it is public.** The conversation is a public record, like a public meeting's minutes. That removes the hardest problem private agents have, which is deciding what to reveal to whom. It also changes what a person should bring to it: their questions about buildings, money and organizing, not their private lives.
- **No authority to act.** The agent gathers and processes public information and computes. It never files, signs, pays, sends or decides. Capturing an agent that can't act gains nothing but a megaphone, and the record of what the megaphone said is public too.
- **Queryable and portable.** The questions, the answers, and the reasoning behind them are records anyone can read, index and copy. If the host disappears or turns bad, the record survives, and another host can stand up the same agent on it. The model is rented; the memory is not.
- **Disclaim, don't gate.** No review stands between a person and the agent. Every place where people type says plainly that it is public, and the agent says so again if someone shares something private. A gate would make the agent a gatekeeper. A warning keeps the responsibility with the person, where a public meeting keeps it.

## 3. What "reasoning" means here

An answer's reasoning has two parts:

- **The trace.** This is the canonical record: which tools the agent called, with what inputs, what the code computed, and which sources it read. Code writes it, not the model, so it is the part that can be checked.
- **The model's thinking.** Claude models don't return their raw chain of thought, only summaries of it. Where those summaries are published, they are labeled as summaries.

autonomist stores the trace's outline today: each answer's sources and saved results. The full trace joins the record when the conversation pages are published.

## 4. The shape on atproto

atproto is the protocol under Bluesky. Each person and each agent has a signed repository of records that it controls and can move between hosts. A public agent fits it naturally:

- **The agent's records** live in its own repository: answers, traces and memory entries.
- **A person's questions** can live in their own repository, as Siren's public questions already do. The question is theirs, signed by them, and withdrawable by them.
- **Names** for the record types would sit under `org.jason-edelman.autonomist.*`, following Siren's `org.jason-edelman.siren.endorsement` (proposed, not settled).
- **Forkability.** Anyone can rebuild the agent's memory from the public records, so any community can fork the agent with its history.
- **Its own host.** autonomist's repository lives on a server autonomist runs itself, at `pds.autonomist.jason-edelman.org`, under the handle `autonomist.jason-edelman.org`. The server is [pds.js](https://tangled.org/chadtmiller.com/pds.js), an open-source one-account host. The key that can take the identity back if the server is lost or captured is held by a person, the agent's steward, not by the server.

Public also means copies. A record deleted from its repository is dropped by the services that honor deletions, but anyone who already copied it keeps the copy. The warning says so.

## 5. A commons, by Ostrom's measure

Elinor Ostrom's design principles for long-lived commons map onto the public agent:

- **Clearly defined boundaries:** who may ask (invites, for now) is clear, even though what they ask is public.
- **Collective choice:** the agent's charter (what it is for, what it won't do) is a public text the community can amend, with every version kept.
- **Monitoring:** everything the agent says is on the record, and so is what it costs.
- **Nested enterprises:** each community's agent keeps its own memory and chooses what to share with a federation's common pool. That is the same firewall-plus-pool design as the money in [The engine](/model/the-engine/), applied to knowledge.

The agent carries the clerical labor that wears out volunteer boards: the minutes, the ledger, the reminders. The members keep the decisions.

## 6. How it teaches

Paulo Freire's *Pedagogy of the Oppressed* (first published in English in 1970) contrasts two kinds of education. In the "banking" kind, a teacher deposits knowledge into students who receive it. In problem-posing education, teacher and students investigate the students' own situation together, and each learns from the other.

A public agent suits the second kind. Its memory is written from the conversation, and every answer is on the record where others can question it. So autonomist is told to:

- start from the person's situation, in their words;
- answer what was asked, then pose one question that opens the situation up;
- show the inputs behind every number, so the person can check and correct them;
- name a structure through the person's case, never as a definition first;
- point toward the group, because understanding grows in dialogue and action belongs to the people.

## 7. Open questions

- **Who asks, and under what name?** One option is signing in with Bluesky, so each question is a record in the asker's own repository, as Siren's public questions work. The other is invite codes, with questions recorded in the agent's repository.
- **The unit of memory.** One memory per community, per conversation, or both? Each person's conversation could feed a community memory the agent writes.
- **The charter:** who writes the first one, and how it is amended.
- **Who pays.** A public agent is a public good. Its costs should be visible and carried by the communities or the federation's pool, never by selling what it holds.
