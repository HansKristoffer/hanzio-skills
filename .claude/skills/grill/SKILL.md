---
name: grill
description: Interview the user in rounds until a plan, design or scope has no open decisions, each question with a recommended answer, looking up every fact instead of asking for it. Use when asked to grill or stress-test a plan, when a plan, spec or scope still has open decisions, or when another skill needs decisions settled before it writes.
---

# Grill

Topic: the plan, idea or scope in the conversation, or the one the calling skill names. The calling skill may bring its own typical roots, its own rules for who decides, and the document where decisions are recorded; those win over the defaults here.

## The decision tree

Map the decisions as a tree, where each decision opens the decisions that hang off it. "Who owns the record" opens "who can edit it", which opens "how an edit reaches the other system". Typical roots for a change in a repository:

- the data: what is stored, who owns it, what already exists;
- who can see and do what: roles, tenancy, auth;
- the contract other code depends on: routes, types, events, tables;
- where it lives for the user: which screen, which flow;
- what happens to existing data and users: migration, rollout, flags;
- what is out of scope.

Mark every **one-way door**: a decision that is expensive to undo once shipped (a schema, a public API, a data migration, a vendor contract). Those get the most care and the plainest wording.

## Rounds

The **frontier** is every decision whose prerequisites are settled. Ask the whole frontier in one round, then wait:

- Number each question.
- Give each one your recommendation, worded so a bare "yes" accepts it.
- A question that depends on another question in the same round waits for the next round.

```
**Q1 – <title>**: <the question, with the options and what each costs in time, risk or reversibility>

→ <your recommendation, and why in one sentence>

---

**Q2 – <title>**: ...
```

Each answer moves the frontier, so recompute it and ask the next round.

**Facts are yours, decisions are ours.** Never ask what the code, the docs, the sources or a quick probe can answer. Look it up instead, with a subagent when it takes a while. Only the questions downstream of a running lookup wait for it; ask the rest of the frontier now.

**Delegation is not an answer.** "You decide" or "whatever you think" on a one-way door gets the decision put back once, with your recommendation, as a yes or no. On anything else, take your recommendation and record it as delegated.

## Record as you go

Write each decision the moment it settles, into the document the calling skill names (a plan's Decisions, a `technical.md`), numbered so later work can cite it, with its source ("team", the user's name or "delegated") and the date. A term that settles goes into the repository's glossary when it has one.

## Done

The interview is done when the frontier is empty: every branch visited, nothing silently assumed. Sum up the decisions in a few lines and ask for confirmation before anything is written from them.

If the user says to skip the interview, use your recommendations and list every one they have not confirmed at the top of the hand-off.
