---
name: build-engine
description: Design and build a typed TypeScript domain engine with one kind registry driving types, routes, tests and UI, pure logic, and external-system adapters. Use when starting an engine or integration, adding a kind, adapter or command, planning packages, or reviewing one.
---

# Build an engine

An **engine** is a typed core that models one domain (products, invoices, contacts, devices), changes it in an external system through adapters, and exposes it to a UI without anyone restating a type. Adding a kind, field or adapter is one declaration plus one registry line; the compiler and the tests that loop the registry name everything else that has to change.

Build the **smallest engine that is correct**: the core below, plus the rows of **Add what the domain needs** whose need is true here. This skill is distilled from a production engine that needed every row. Most engines need two or three.

## Learn the repository first

Read the root and nearest `AGENTS.md` / `CLAUDE.md`, any design doc for the engine, and the existing registries before writing anything. If the repo already has an engine rulebook, it wins over this skill; where they disagree, ask. Note the lint, typecheck and test commands, and which pieces already exist (an `fn` route wrapper, a queue, a Result type, `typedSwitch`, ID helpers). Reuse them.

If you are extending an existing engine, skip to **Add to an existing engine**.

## The core

Every engine has these six, at any size. [references/types.md](references/types.md) opens with all of them in one example that compiles; start from its shape.

1. **One registry, everything derived.** A **kind** is the unit this domain keeps adding (a field, a value type, a command, a document format, a device model). It is one `defineKind` call, and the registry is the one list. Every union of kinds, operations, values and payloads comes from it with `keyof typeof` and `z.output`. The API, the UI, the tests and the docs hold no second list.
2. **Bind before you infer.** `implement(contract)({ ... })` fixes the contract's types first, then accepts the callbacks, so their parameters and results are the contract's.
3. **Parse at every boundary.** API input, webhooks, job payloads, persisted JSON, external responses, file rows: `unknown` in, one schema, typed inside.
4. **Closed unions get total maps.** `satisfies Record<Kind, ...>` and an exhaustive switch, so a new member breaks the build at every place that must handle it.
5. **Value states are explicit.** Name the states a value can be in for this domain (missing, null, empty, unchanged, clear and unreadable are the usual ones) once in the contracts, and keep them distinct in reads, plans, receipts, files and the UI.
6. **Tests loop the registry.** One conformance suite per contract kind loops the registry, so registering an implementation covers it. See [references/proof.md](references/proof.md).

## Keep the types plain

The types exist to reject wrong programs. Each one is as simple as that job allows.

- **Types come from values.** Declare with `const` type parameters, `as const` and `satisfies`; derive with `typeof`, `keyof` and `z.output`. A derived alias is one line and named for the domain (`ValueOf<K>`).
- **Type-level code lives in the few `define` and `implement` helpers.** Call sites are plain object literals: no type arguments, no casts, no annotations that repeat what was inferred. A call site that needs one points at a helper to fix.
- **A type parameter ties two positions together** (a contract to its callbacks, a kind to its value). One that appears once is a plain type.
- **A kind travels with its data as a mapped union**, `{ [K in Kind]: { kind: K; value: ValueOf<K> } }[Kind]`, so narrowing on `kind` narrows the rest.
- **Kinds cross the dispatcher as `unknown`.** Each kind's bound function parses its own value and parameters, so the code that picks a kind at runtime needs no cast and no correlated generics.
- **Every type-level mechanism names the wrong program it rejects**: a `@ts-expect-error` line with the compiling twin beside it. A conditional, recursive or branded type you can't write that line for comes out.

## The shape

Dependencies point one way, and a test that walks each entry's import graph holds them there from day one.

```
contracts  ->  engine (pure)  ->  adapters + runtime (backend)  ->  transport (thin API)  ->  UI
```

| Layer | Holds | Boundary |
| --- | --- | --- |
| **contracts** | Zod wire schemas, kind declarations, closed vocabularies (command kinds, error codes) | imports only zod and pure TS |
| **engine** | Pure implementations: canonicalizers, codecs, evaluators, planning rules | no I/O, clock, DB or network |
| **adapters** | One folder per external workflow: payload schemas, reads, writes, a test harness | translates; the rules stay in the engine |
| **runtime** | Persistence, the run driver, leases, the tenant-scoped store | imported only by the backend |
| **transport** | Routes that parse input, call one service, map errors | holds no logic |
| **UI** | Renderers keyed by kind, driven by a manifest the backend sends | reads the manifest, never implementations or Zod internals |
| **testing** | Conformance suites, type-test helpers, fixture registries | stays out of production bundles |

These are folders in one package to begin with. A layer becomes its own package when a second consumer imports it (the frontend taking contracts is the usual first). The runtime layer exists only when a row below adds it.

## Add what the domain needs

Each row is a mechanism with a cost. It enters when its need is true for this domain. The rows about the external system are in [references/execution.md](references/execution.md), one section each.

| Need | Add | Skip it while |
| --- | --- | --- |
| The engine reads or writes an external system | adapters; probes that record expected, observed and verdict for each assumption about its API; types generated from its published schema at a pinned version | the engine owns all its data |
| It writes there | one shared write wrapper with client retries off that classifies each result as applied, rejected or `unknown`; a timeout is `unknown` until read back | the engine is read-only |
| A run outlives one request (batches, a queue, crash recovery) | every write a persisted attempt recorded before sending; guarantees derived from adapter facts; a run driver | each change is one request the user watches, and repeating it is safe |
| The external API has no compare token or ETag | checked write: re-read, write, read back | it supports conditional writes |
| A stored plan is approved after it was made (later, or by someone else) | intent, sealed plan, receipt; approval binds to the plan hash | apply follows preview in one sitting and carries the values the user saw |
| Users must reverse changes | undo planned from receipts through a total inverse map | changes are trivially re-editable |
| Several workers can touch one run | lease with a fencing token; every state write fenced in SQL | one process, one request |
| Large volumes | bulk operations with tagged payloads | page-sized batches suffice |
| More than one tenant, or a state only one module may grant | a tenant-scoped store; authority as a brand only its owner mints ([types.md](references/types.md), **Identity and authority**) | one tenant and no approvals |
| A rule the types can't express (every writable field routes to exactly one adapter, no cycles) | a check when the registry loads, with a failing fixture ([proof.md](references/proof.md)) | the compiler already rejects it |
| A UI or an AI tool shows the kinds | a manifest route and total renderer maps, so a new kind reaches the screen untouched ([manifest.md](references/manifest.md)) | there is no UI yet |
| Review caught the same mistake twice | a repo check for that rule, with a fixture ([proof.md](references/proof.md)) | it happened once |
| Several agents or people build in parallel | a frozen design doc, work packages, contract-change PRs, review rounds ([process.md](references/process.md)) | one person or agent builds it |

## Start a new engine

1. **Size it.** Go through the table with what the user asked for and answer every row: "yes, because" or "no, until". Where the answer is the user's to give, settle it by calling the Skill tool with `grill`. Done when every row has an answer.
2. **Write the design doc**, short and numbered: domain glossary, the kinds, the flow, the guarantees you promise and the ones you don't, the sizing answers, open questions. Number the decisions so later work can cite them. A core-only engine fits on a page.
3. **Probe the external system** for every assumption the design rests on (idempotency, ordering, error shapes, limits, what "success" really returns). Record the results and fix the design before writing code.
4. **Write the contracts and the rulebook.** One `AGENTS.md` beside the engine with numbered rules: the core, plus one rule per row you answered yes. Add the import-graph test and the strict tsconfig flags from [references/types.md](references/types.md).
5. **Build one vertical slice**: one kind, one adapter, one route, one rendered field, end to end, with its conformance suite and type tests, and one case of every family of change the contracts must carry (a scalar field, a collection, a bulk change), since the easiest family proves the least.
6. **Add a second kind as the test of the slice.** The diff is one declaration, one implementation, one registry line and the entries the compiler demanded in total maps. Anything else you had to edit is a hand-written list: derive it from the registry, then fix the contracts while it is still cheap.
7. **Add the rest**, one kind or adapter at a time. With several builders, freeze the contracts first ([references/process.md](references/process.md)).

## Add to an existing engine

- **New kind:** declare it in contracts, implement it with the bind-first helper, register it in one line, then cover every kind hotspot the rulebook lists. The compile errors in total maps (messages, renderers, inverses) list the rest of the work.
- **New adapter:** payload schemas, binding, read, write through the shared write wrapper, a conformance harness. Declare only facts (does it have a compare token?); the runtime derives its guarantee and recovery class.
- **New command or operation:** add it to the closed vocabulary, then follow the build errors. A `default:` branch or a `Record<string, ...>` appearing in your diff means the union is being widened somewhere: find where.
- **A contract seems wrong:** raise a contract change ([references/process.md](references/process.md)) and build on the changed contract.

## Before calling work done

Review the plan and the diff against [references/lessons.md](references/lessons.md), the ranked list of what reviewers caught, then check every line that applies:

- [ ] Every mechanism in the diff belongs to the core or to a row answered yes. The rest is removed.
- [ ] The registry is the only list of kinds, operations and implementations, tests included.
- [ ] Every boundary parses. Typecheck passes with no `any`, no `!`, and no cast outside the allowlist.
- [ ] Every closed union touched has a total map and an exhaustive switch.
- [ ] Every `@ts-expect-error` has a twin that compiles, and each type-level helper has such a pair.
- [ ] Every value touched keeps its named states distinct, with a test case per state.
- [ ] The conformance suite reaches the new implementation through the registry.
- [ ] Every assumption about the external system has a probe result behind it.
- [ ] External writes go through the shared wrapper. With a durable runtime, the attempt is persisted first.
- [ ] Authority types are created only by their owning module.
- [ ] The frontend uses router-inferred types and the manifest.
- [ ] Provisional constants are named, commented and listed.
