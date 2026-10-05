---
name: build-engine
description: Design and build a typed domain engine end to end - contracts, pure engine logic, adapters to an external system (an e-commerce platform, CRM, payments, ERP, IoT fleet), a durable runtime, a thin API and a UI that renders from the engine's own manifest - so one set of schemas types everything from the database to the browser. Use when starting an engine or integration like this, adding a new kind, adapter or command to one, planning its work packages, or reviewing whether an engine still follows its rules. Built for TypeScript monorepos (Bun or Node, Prisma, Zod, oRPC, hanzio, Vue or React/Expo); reads the repository's own rules first and lets them win.
---

# Build an engine

An **engine** here is a typed core that models one domain (products, invoices, contacts, devices), changes it in an external system through adapters, and exposes it to a UI without anyone restating a type. The point is not the layering. The point is that adding a new kind, field or adapter is one declaration plus one registry line, and the compiler, the startup checks and the conformance suites tell you everything else you forgot.

This skill is distilled from a production engine. Use its principles; do not copy its machinery. Most engines need a fraction of it (see **Scale the machinery**).

## Learn the repository first

Read the root and nearest `AGENTS.md` / `CLAUDE.md`, any design doc for the engine, and the existing registries before writing anything. If the repo already has an engine rulebook, it wins over this skill; where they disagree, ask. Note the lint, typecheck and test commands, and which pieces already exist (an `fn` route wrapper, a queue, a Result type, `typedSwitch`, ID helpers). Reuse them.

If you are extending an existing engine, skip to the reference for the part you touch.

## The shape

Dependencies point one way. Each arrow is enforced by a test, not by goodwill.

```
contracts  ->  engine (pure)  ->  runtime + adapters (backend)  ->  transport (thin API)  ->  UI
  zod only     contracts + small     DB, queue, external clients     one route = decode,       renders the
               browser-safe libs                                     one service call, map     manifest
```

| Layer | Holds | Must not |
| --- | --- | --- |
| **contracts** | Zod wire schemas, kind declarations (`defineX`), descriptors, closed vocabularies (command kinds, error codes), typed implementation interfaces | import anything but zod and pure TS |
| **engine** | Pure implementations: canonicalizers, codecs, evaluators, planning and admission rules, query semantics | touch I/O, the clock, the DB or the network |
| **testing** | Conformance suites per contract kind, type-assertion helpers, fixture registries | ship in a production bundle |
| **runtime** | Persistence, the run driver, leases, durable effects, the tenant-scoped store | be imported by contracts or engine |
| **adapters** | One folder per external workflow: payload schemas, binding, reads, writes, a test harness | contain engine rules; they translate |
| **transport** | Routes that parse input, call one service, map errors | contain logic |
| **UI** | Renderers keyed by kind, driven by a manifest the backend sends | read implementations or Zod internals |

Put the boundary into a test on day one: walk each entry's import graph and fail if `contracts` reaches anything but zod, or `engine` reaches the backend. A package boundary nobody checks is a suggestion.

## Core principles

These are the rules that carry the design. Each reference file expands one area.

1. **Declare once, derive everything.** A kind is one `defineX` call with `const` generics. Every union of kinds, operations, values and payloads is derived from the registry. There is no second hand-maintained list anywhere: not in the API, the UI, the tests or the docs. See [references/types.md](references/types.md).
2. **Bind before you infer.** `implement(contract)({ ... })`: fix the contract's types first, then accept callbacks, so an implementation cannot widen or drift from its contract.
3. **Parse at every boundary.** API input, webhooks, job payloads, persisted JSON, external API responses, file rows. Untyped data enters only through a parser; never `as` on JSON.
4. **Closed unions get total maps.** Messages, renderers, retry policy, inverses: `satisfies Record<Kind, ...>`, no `default:` in a switch over a closed union. Adding a member breaks the build until every map handles it.
5. **Authority is a type only its owner can make.** Tenant context, leases, approved plans, tenant-owned rows: branded with a `unique symbol` and minted in one module. A tenant ID sent by a client is never authority. Loading a row is not granting it.
6. **Types narrow who can call; the database decides.** Every state write is fenced (`WHERE id = $1 AND lease_token = $2`). Types prevent mistakes, constraints prevent races.
7. **Intent, plan, receipt are three things.** What the user asked for, the sealed and hashed set of commands, and what the external system confirmed. Approval binds to the plan hash; undo reads receipts only. See [references/execution.md](references/execution.md).
8. **An external write is unknown until observed.** Persist the attempt before sending, never let a client library retry a mutation, and treat a timeout as `unknown`, not failure. Guarantees are derived from what the adapter can prove, not claimed by it.
9. **Tests iterate registries.** A new implementation is covered the moment it is registered, because every conformance suite loops the registry and the harness map must be total. See [references/proof.md](references/proof.md).
10. **What types can't prove is a startup check.** Every writable field routes to exactly one adapter, no duplicate keys, no cycles: validated when the registry loads, with a failing fixture.
11. **Prove the external system's behavior before relying on it.** Probes against a real sandbox account record expected, observed and verdict for every assumption the engine makes about the API.
12. **Interfaces are frozen before fan-out.** Contracts are designed once, proven, then frozen; changing one is its own PR. See [references/process.md](references/process.md).
13. **Value states are explicit end to end.** Missing, null, empty, unchanged and clear are distinct states in reads, plans, receipts, files and the UI, never collapsed into `undefined` or `''`. This was the second most frequent bug class in review.

## Front to back, typed by construction

The chain that makes the UI safe:

1. Contracts declare the kinds and their wire schemas.
2. The backend registry binds implementations and adapters; startup validation runs.
3. Routes declare `input` and `output` with the contract schemas. A manifest route projects the registry (per tenant) into JSON: kinds, fields, labels, parameters, capabilities.
4. The router type is exported (`InferRouterInputs` / `InferRouterOutputs`). The frontend never writes an API type by hand: `useQuery((o) => o.catalog.manifest.queryOptions({ input: {} }))`.
5. The UI renders the manifest through total maps keyed by kind (`renderers satisfies Record<Kind, Component>`) and imports engine types with `import type` only.
6. For the external system, generate its types (GraphQL codegen, OpenAPI) from a pinned schema version, and key any map over its enums by the generated enum.

The result: a new kind appears in the API, the manifest and the UI without touching them, and a missing renderer is a compile error. Handles, derived capabilities, manifest building and renderer typing are in [references/manifest.md](references/manifest.md).

## Scale the machinery

Start from the smallest engine that is correct, and add a mechanism only when its failure mode is real for this domain:

| Need | Add | Skip it when |
| --- | --- | --- |
| Several kinds share behavior | kind registry, `defineX`, conformance suite | there is one kind |
| Writes to an external system | adapters, durable attempts, `unknown` outcomes | the engine is read-only |
| The external API has no compare token / ETag | checked write: re-read, write, read back | it supports conditional writes |
| Long or batched changes users approve first | intent, sealed plan, receipt, run driver | changes are single, immediate and cheap |
| Concurrent workers on the same run | lease with fencing token, claims | one process, one request |
| Users must reverse changes | undo planned from receipts | changes are trivially re-editable |
| Large volumes | bulk operations with tagged payloads | page-sized batches suffice |
| Many agents building in parallel | frozen design doc, work packages, review rounds | one person or agent builds it |

Name what you skipped and when it becomes necessary, in the design doc, so the next person adds it deliberately instead of reinventing it.

## Start a new engine

1. **Write the design doc first**, short and numbered: domain glossary, the kinds, the flow (intent to receipt, or less), the guarantees you promise and the ones you don't, open questions. Number the decisions so later work can cite them.
2. **Probe the external system** for every assumption the design rests on (idempotency, ordering, error shapes, limits, what "success" really returns). Record results; fix the design before writing code.
3. **Write the contracts and the rulebook.** One `AGENTS.md` in the engine package with numbered rules (start from the principles above, cut what you don't need). Add the bundle-boundary test and the strict tsconfig flags (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`).
4. **Prove the hard parts with one vertical slice**: one kind, one adapter, one route, one rendered field, end to end, with its conformance suite and type tests, and one case of every command family the contracts must carry. Fix the contracts now; this is the last cheap moment.
5. **Freeze, then fan out** one kind or adapter per work package.

## Add to an existing engine

- **New kind:** declare it in contracts, implement it with the bind-first helper, register it in one line, then cover every kind hotspot the rulebook lists. Run the type tests and conformance suite; let the compile errors in total maps (messages, renderers, inverses) list the rest of the work.
- **New adapter:** payload schemas, binding, read, write through the shared write wrapper, a conformance harness. Declare only facts (does it have a compare token?); let the runtime derive its guarantee and recovery class.
- **New command or operation:** add it to the closed vocabulary, then follow the build errors. If you find yourself writing a `default:` branch or a `Record<string, ...>`, stop: the union is being widened somewhere.
- **A contract seems wrong:** do not patch around it locally. Raise a contract change (see process).

## Before calling work done

Review the plan and the diff against [references/lessons.md](references/lessons.md), the ranked list of what reviewers actually caught, then check:

- [ ] No hand-written list of kinds, operations or implementations anywhere, including tests.
- [ ] Every boundary parses; no `as` on external or persisted data; no `any`, no `!`.
- [ ] Every closed union touched has a total map; no `default:` over it.
- [ ] Authority types are created only by their owning module.
- [ ] New external writes go through the shared wrapper and persist the attempt first.
- [ ] Type tests: every `@ts-expect-error` has a positive twin that compiles.
- [ ] The conformance suite covers the new implementation because it is registered, not because it was listed.
- [ ] The frontend uses router-inferred types and the manifest, not copied shapes.
- [ ] Provisional constants are named, commented and listed.
- [ ] Every value touched keeps missing, null, empty, unchanged and clear distinct, with a test case per state.
- [ ] Every assumption about the external system is backed by a probe result, not by its docs.
