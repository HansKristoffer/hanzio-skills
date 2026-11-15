# Lessons: what reviewers actually caught

Review a plan or a diff against this list first. It ranks the mistakes that recurred while a production engine was built by agents (about 375 review findings over 30 packages), most frequent first, each with the habit that prevents it. Skip an item whose mechanism this engine doesn't have.

1. **Wrong facts about the external system** (the largest class by far): scopes a read needs, pagination caps (a list field silently truncated at 250), nullability, enum values, what "success" returns, which identity belongs to whom. Types can't catch these. Habit: every adapter starts by probing the real API and lists each assumption with expected, observed and verdict; the reviewer checks the adapter against the probe log, not against the docs.
2. **Value states conflated**: missing, null, empty, unchanged and clear collapsed into one (`undefined`, `''`, "no change"). An unreadable value read as empty; a blank cell read as a clear. Habit: name the states once in contracts, carry them end to end, and give every acceptance item touching values one case per state.
3. **Vacuous type tests**: a `@ts-expect-error` that fails for an unrelated reason, or a negative case with no positive twin. Habit: mutation-test them ([proof.md](proof.md)); a test that stays green under mutation is deleted or fixed.
4. **Interfaces invented or missing**: a builder patched around a contract that couldn't express its case. Habit: stop and raise a contract change ([process.md](process.md)).
5. **Missing runtime check for what types can't prove**: multiplicity, uniqueness, every kind having an engine, tuple-valued kinds. Habit: each such rule is a startup check with a failing fixture.
6. **Correlation leaks**: two things matched by value instead of identity, so a swap passed; a union-typed argument slipped through bivariance. Habit: match payloads to commands by identity (ID or input index), bind closures per kind, and add a swap case to the type tests.
7. **Kind hotspots missed**: a new kind compiled but broke per-kind maps that live outside the registry. Habit: the rulebook lists them under "Adding a kind touches" and each is a total map ([types.md](types.md)).
8. **Persisted data unversioned, or a parser with a default.** Habit: every stored JSON shape is a versioned envelope from its first commit.
9. **Concurrency and crash ordering**: concurrent first writes losing keys, an event arriving before initial discovery. Habit: every write path gets a "two at once" and a "crash between steps" case.
10. **Flaky DB and queue tests** from timing-based waits. Habit: wait on an observable state, never on a sleep; a flake is a bug.

With work packages, two more:

11. **Files outside ownership, or two packages owning one file.** Habit: the spec's "Owns" is checked against the diff in code review; a shared file is a hotspot (one line per entry) or belongs to one package.
12. **Acceptance with no test named**, and **dependencies between packages left implicit** (a package used another's tables before they existed). Habit: spec review checks every acceptance item names a test file, and every "Uses" names a merged package and a real module path, verified against the code.

## What paid for itself

Keep these when you cut an engine down, wherever their mechanism exists: the kind registry with derived types; contract-first binding; kind-bound closures with casts confined to a handful of dispatchers; one correlated error union with one Zod-issue conversion; a codec per boundary with a generic round-trip test; versioned persisted parsers; conformance suites that loop registries; guarantees derived from adapter facts; fenced leases; startup checks for multiplicity; mutation-tested type tests.
