# Document skeletons

Replace every `<...>` placeholder. Drop a section that has nothing in it rather than writing "n/a".

## scope.md

```markdown
# <Project>: scope checklist

<One sentence on what we build and for whom.> This checklist is for deciding together which features to build and in what order. The questions we need answered are at the end.

## Decisions taken

- **<Decision in a few words>:** <one sentence on what it means for the customer>.

## Time

- **About <n> weeks** from start to finish, ready for the first users.
- **First version ready for testing about <n> days after the start.**

## Price

- **<total> DKK in total** excl. VAT. The price per phase is in each phase heading below.
- **Payment:** 50% when we start and 50% when the app is live.
- The price assumes <access to X by date>, <final design before the build starts>, <data shown as the APIs provide it>.

## Phase 1: <What the user gets> (<price> DKK)

- [ ] <Feature a non-developer can test>

## Phase 2: <...> (<price> DKK)

- [ ] <...>

## <Customer> tasks outside this project

- [ ] <Account, content, design or data the customer delivers>

## Later or optional

- [ ] <Feature> (<price> DKK if priced)

## How we work together

- **You are in the loop all the way.** You see the app as it grows, try it on your own phone along the way, and tell us what to change.
- **Plans change once building starts, and that is fine.** Adjustments along the way are usually included. A large new feature gets a price before we start on it, and you decide.

## After launch

- **Operations: <price> DKK a month.** We keep the system running and up to date, and you can write to us with small changes whenever you need them.
- **You own everything:** the code, the store accounts and the hosting. You pay hosting and other services directly to the providers, so you are never locked in to us.
- **Your data stays in the EU,** and we sign a data processing agreement with you.

## What can delay the project

- **<Apple and Google>:** <creating the developer accounts can take a couple of weeks, and every release must pass their review>.
- **<Access to the system's API>:** <we need it, and a test account, before we can connect the app>.
- **<Agreements with a vendor>:** <must be in place before we can use their data>.
- **<Designs and texts>:** <the build waits if they arrive later than planned>.

## Questions for <customer>

Each question has our recommendation, and a "yes" is enough. The first ones block the start.

- [ ] **<Question answered with a word or a choice>?** We recommend <answer>, because <one short reason>.
  Answer:
- [ ] **<Question>?** Options: <A> or <B>. We recommend <A>.
  Answer:
```

## technical.md

```markdown
# <Project>: technical

<What we build, for whom, on which template, and the date of the scope this matches.>

## Sources

| Source | Date | What it settled |
| --- | --- | --- |

## Product

- **Users:** <who uses what>
- **Platforms:** <iOS, Android, web, admin>
- **Screens and flows:** <each screen and what happens there>
- **Business rules:** <keep the customer's numbering>

## Template fit

| Capability | In the template | Verdict | Notes |
| --- | --- | --- | --- |
| <Auth> | <path> | Reuse / Adapt / Remove / Build | <what changes> |

## Architecture

<The components, what calls what, and where data lives.>

## Integrations

### <System>

- **Purpose:** <what we use it for>
- **Auth:** <how we authenticate; whether an end user can log in>
- **Endpoints:** <the ones the features need>
- **Data:** <granularity and freshness>
- **Limits, webhooks, sandbox:** <...>
- **Spec:** <link to sources/...>
- **Open:** <what we still need to know>

## Data model

<New entities and their key fields.>

## Accounts and login

## Admin

## Notifications

## Privacy and compliance

<Who is data controller and processor, which personal data is processed, retention, hosting region, consent, account deletion.>

## Hosting and operations

<Environments, deployment, monitoring, backups, support, and what the operations agreement covers. The hosting and service accounts are the customer's own, paid directly by them; list each one and who creates it.>

## Features by phase

### Phase 1: <name>

#### <Checklist line, exactly as in scope.md>

- **Requirements:** <what it must do>
- **Acceptance:** <how the customer tests it>
- **Build notes:** <template parts to use, edge cases>
- **Estimate:** <days>

## Estimate

| Phase | Days | Price (DKK) |
| --- | --- | --- |
| Setup | | |
| Total | | |

Day rate: <rate>. Buffer: <what it covers>.

## Decisions

| Decision | Why | Source |
| --- | --- | --- |

## Risks

- <Risk>: <what we do about it>

## Open technical questions

- [ ] <Question>
```

## reply.md

A draft for the user to send. Answer each thing the customer asked, in their order and language. Keep it to what fits in an email they read in two minutes.

```markdown
Subject: <their subject, or "<Project>: estimate and next steps">

Hi <name>,

<Yes, we are interested, and one sentence on why the project fits us.>

**Estimate:** <total> excl. VAT and about <n> weeks, split into <n> phases. The phases and what each includes are in the attached scope checklist. The price assumes <the two or three assumptions that matter most>.

**Operations:** <monthly price>, which keeps the system running and covers small changes. You own the code and the hosting and pay the providers directly.

**GDPR:** <who is data controller and who is processor, where data is hosted, and that we sign a data processing agreement>.

**Next steps:**
1. <You answer the questions at the end of the scope; the first ones block the start.>
2. <We agree the phases and sign.>
3. <We start on date, and the first version is ready to test about n days later.>

<Sign-off>
```
