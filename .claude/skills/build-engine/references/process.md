# Process: building an engine with many agents

Use this when several agents (or people) build the engine in parallel. A solo build needs the design doc and the frozen-contract discipline, not the rest.

## The design document

One numbered document: glossary, concepts and the invariant each protects, the flow, guarantees, a decisions table. Once fan-out starts it is **frozen**: it changes only by adding a numbered decision row. When an agent finds it wrong, unclear or silent, the agent writes the question in its PR and does not invent an answer. A value it leaves open (a timeout, a limit) becomes a named constant with a comment saying it is provisional, and the PR lists it.

The engine package's `AGENTS.md` is the rulebook: numbered, one paragraph each, each citing the design section it comes from. Agents follow the rulebook without reading the whole design. When the rulebook and the design disagree, stop and ask.

## Waves

1. **Groundwork:** repo, checks, strict tsconfig, bundle boundary, empty registries.
2. **Contracts:** one agent writes every shared interface, then they freeze.
3. **Proofs:** executable vertical slices that exercise the frozen interfaces on the hardest paths (typing across the API, durable execution, file round trips). Finding a contract mistake here is cheap.
4. **Fan-out:** a few agents at a time, one work package each.

## Work packages

`docs/work-packages/WP-<id>.md`, fixed shape:

- **Goal** in one paragraph.
- **Read:** only the design sections it needs.
- **Uses / Provides:** interfaces consumed and produced.
- **Owns:** the files it may create or change. Nothing else, except **hotspots**: one-line additions to registries.
- **Work**, then **Acceptance:** each item names a test file, type test or check row. Acceptance is executable.
- **Out of scope.**

"Interfaces are given, not designed." If one is missing or wrong, the package stops and raises a contract change instead of inventing a local replacement.

## Contract changes

A frozen contract changes only in its own `contract-change` PR that touches the contract and its existing users and nothing else. In-flight packages rebase on it. This keeps a fan-out from forking the type system.

## Plan, build, review

1. The builder writes a plan (`plans/WP-<id>.md`): approach, files, interfaces used and provided, acceptance mapping, provisional constants, open questions, review log, time log.
2. A **different model** reviews the plan, then the code, at most two rounds per gate.
3. Findings are `F<n> [blocking|should|nit]` with What, Why, Fix. A blocking finding needs a reproduction.
4. After the last round the builder may fix remaining blockers alone only when each fix is local, disputes no decision, and comes with a failing test. Anything else goes to a human.
5. Steps only a human can run (a real-account suite, a production credential) end with a draft PR listing the exact commands, and the builder stops.

## Logs

Keep the review log and a short time log in the plan. They are how you learn which packages were mis-sized and which rules keep getting broken (turn those into repo checks).
