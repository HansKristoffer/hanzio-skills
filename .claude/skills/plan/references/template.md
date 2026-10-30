# Plan template

Leave out a section that would be empty. Code and file paths belong in Current state, Interfaces and the slices; everything else is plain sentences.

```markdown
# <Feature name>

## Ask

> <The user's request in their own words, quoted, with the date. Add each later message that changed it.>

## Problem

What is wrong or missing today, for whom, and how we will know it is fixed. Two to five sentences.

## Current state

What exists now, with file paths: the models, routes, jobs and screens this touches, and what we reuse.

## Decisions

1. **<Decision>.** <Why, in one sentence.> One-way door. (team, 2026-10-27)
2. **<Decision>.** <Why.> (delegated, 2026-10-27)

## Interfaces

The exact shapes the slices share: TypeScript types, oRPC procedures with input and output, Prisma models and enums, events, jobs and queue payloads. Written out, not described.

## Slices

### 1 – <What we can demo when it is done>

**Depends on:** none <!-- later slices: "1" -->
**Labels:** hitl <!-- only when a person must act mid-build; omit otherwise -->

What it delivers, end to end, in two or three sentences.

**Acceptance criteria**

- [ ] <a condition, naming the test, command, or file and content that shows it>

**Proof:** <the reproduction, test, check or screenshot that will show it works>

<!-- Repeat for each slice -->

## Rollout

Migration order, backfills, feature flags, what has to happen before and after the deploy. Only when the change needs it.

## Out of scope

What this plan deliberately leaves out, specifically.

## Open questions

What is still undecided, and which slices each one blocks.

## Review log

Each reviewer finding, and how it was fixed or why it stands.
```
