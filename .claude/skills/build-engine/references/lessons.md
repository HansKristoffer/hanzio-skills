# Lessons: what reviewers actually caught

Read this before planning a work package or a review. It ranks the mistakes that recurred while a production engine was built by agents (about 375 review findings over 30 packages), with the habit that prevents each. Review a plan against this list first: it is where the blocking findings came from.

## Recurring findings, most frequent first

1. **Wrong facts about the external system** (the largest class by far): scopes a read needs, pagination caps (a list field silently truncated at 250), nullability, enum values, what "success" returns, which identity belongs to whom. Types can't catch these. Habit: every adapter package starts by probing the real API and lists each assumption with expected, observed and verdict; the reviewer checks the adapter against the probe log, not against the docs.
2. **Value states conflated**: missing, null, empty, unchanged and clear collapsed into one (`undefined`, `''`, "no change"). An unreadable value read as empty; a blank cell read as a clear. Habit: name the states once in contracts, carry them end to end (reads, plans, receipts, files, UI), and give every acceptance item touching values one case per state.
3. **Vacuous type tests**: a `@ts-expect-error` that fails for an unrelated reason, or a negative case with no positive twin. Habit: **mutation-test** type tests: replace the type under test with `never` (or widen it) and the typecheck must go red. A test that stays green under mutation is deleted or fixed.
4. **Interfaces invented or missing**: a builder patched around a contract that couldn't express its case. Habit: stop and raise a contract change (see process). Expect several per wave; stack them as separate PRs ahead of the feature PR.
5. **Missing runtime check for what types can't prove**: multiplicity, uniqueness, every kind having an engine, tuple-valued kinds. Habit: each such rule is a startup check with a failing fixture.
6. **Correlation leaks**: two things matched by value instead of identity, so a swap passed; a union-typed argument slipped through bivariance. Habit: match payloads to commands by identity (ID or input index), bind closures per kind, and add a swap case to the type tests.
7. **Kind hotspots missed**: a new kind compiled but broke the per-kind maps that live outside the registry (handle builders, manifest projections, presentation, conformance cases). Habit: list every such map in the engine rulebook under "Adding a kind touches", and make each one a total map so the compiler finds them.
8. **Files outside ownership, or two packages owning one file.** Habit: the spec's "Owns" is checked against the diff in code review; a shared file is a hotspot (one line per entry) or belongs to one package.
9. **Acceptance with no test named**, and **dependencies between packages left implicit** (a package used another's tables before they existed). Habit: spec review checks every acceptance item names a test file, and every "Uses" names a merged package and a real module path, verified against the code.
10. **Persisted data unversioned, or a parser with a default.** Habit: every stored JSON shape is a versioned envelope from its first commit.
11. **Concurrency and crash ordering**: concurrent first writes losing keys, an event arriving before initial discovery. Habit: every write path gets a "two at once" and a "crash between steps" case.
12. **Flaky DB and queue tests** from timing-based waits. Habit: wait on an observable state, never on a sleep; a flake is a bug.

## Cost against value

**Worth every line:** the kind registry with derived types; contract-first binding; kind-bound closures with a cast allowlist confined to a handful of dispatchers; one correlated error union with one Zod-issue conversion; a codec per boundary with a generic round-trip test; versioned persisted parsers; conformance suites that iterate registries; guarantees derived from adapter facts; fenced leases; startup checks for multiplicity; mutation-tested type tests.

**Diminishing returns, keep them small:**
- **The custom AST rule engine.** Its cast, capability and brand rules pay; chasing every bypass (cloning, template parsing, exotic syntax) costs review rounds. A scanner bug once made builders contort product code to avoid a construct. Keep the rule set short, grade "a heuristic check misses a contrived bypass" as `should`, and fix a checker bug in the checker, never by bending product code.
- **A very long frozen design doc.** Agents only read the sections their package lists, and decisions were still needed mid-build. Keep the design short and numbered, and let the decision log grow.
- **Strict compiler flags in one package only.** Engine runtime code in the backend went without them. Put every engine path, runtime included, in a strict program from the start.
- **Framework typing of correlated props.** Budget for it (see manifest.md) instead of discovering it in the frontend package.

For how proofs and packages are sized, see [process.md](process.md).
