# Proof: tests that grow with the registry

The engine is correct when every registered thing passes the same suites, and the rules that keep it that way are checked by machines. Conformance suites, type tests and the import-graph test belong to every engine. Each later section says what it is added for.

## Conformance suites per contract kind

Every contract kind (field type, codec, adapter, layout, container) has one suite in the engine's `testing` package. An implementation supplies cases or generators and **independent** expectations; the suite does the rest.

```ts
// cases are typed per kind where they are written, and erased where they run
const cases = { text: textCases, integer: integerCases } satisfies { [K in Kind]: Case<K>[] }

for (const key of Object.keys(kinds)) {
  if (!hasKey(kinds, key)) continue
  describe(key, () => kindSuite(kinds[key], cases[key]))
}
```

The suite takes the erased view of an implementation (`apply(operation, unknown, unknown)`), so it runs any kind; the `satisfies` line is what types each case and makes a kind without cases fail to compile.

- **Tests iterate registries.** A hand-written list of implementations in a test is a bug (a repo check can catch it). Register a thing and it is covered.
- **Harness maps are total.** `harnesses satisfies { [K in keyof typeof adapters]: Harness<K> }`, so a new adapter without a harness doesn't compile.
- **Fault injection belongs in the suite:** crash before and after send, timeout, zombie worker, partial batch failure. A harness declares its recovery class so it can't run an easier class's cases.
- **Round-trip property tests** for every codec: `decode(encode(x)) === x`.

## Type tests

`*.type-test.ts` files inside the package typecheck (test runners like Bun don't typecheck).

```ts
type _ = Expect<Equal<ValueOf<'money'>, CanonicalDecimal>>
// @ts-expect-error  a text payload can't route to the money adapter
route({ kind: 'money', payload: textPayload })
route({ kind: 'money', payload: moneyPayload })   // the positive twin: must compile
```

Every `@ts-expect-error` has a positive twin, or the test passes for the wrong reason. **Mutation-test** them: replace the type under test with `never` (or widen it) and the typecheck must go red; a type test that stays green under mutation proves nothing. Use adversarial inputs: union-typed variables, mismatched descriptor and value, widened registry entries, method-syntax callbacks. Assert `IsAny` is false on anything coming from codegen.

## Import-graph test

Walk each entry's import graph, type-only and dynamic imports included (a test that reads the `import` lines of each file is enough while the layers are folders), and assert what it may reach: contracts only zod, engine only contracts and its few value libraries, neither reaches testing or the backend, both bundle for the browser.

## Startup checks

Add one for each rule the types can't express. What types can't prove runs when the registry loads, with a failing fixture to prove the check works: duplicate keys, cycles, missing implementations, every writable field routing to exactly one adapter.

## Real-system leg

For an engine that talks to an external system.

- **Probes** (`scripts/probes/*`) test each assumption about the external API against a real sandbox account and record expected, observed and verdict in a doc. Re-run them when you bump the pinned API version. With no sandbox yet, run them against the client or fake you have and mark each verdict as not yet confirmed on the real system.
- **The conformance suite has an opt-in real leg** (`ENGINE_REAL_SUITE=1`). Without credentials it is **skipped with a reason**, never failed and never silently passed.
- Keep DB tests in their own pattern (`*.db.test.ts`) so the unit run stays fast.
- DB and queue tests wait on an observable state, never on a sleep. A flake is a bug.

## Docs tied to code

A coverage matrix in a doc (which external types are supported, which operations) gets a test that parses the doc and compares it with the code in both directions. A doc that can drift will.

## Repo checks with fixtures

Add a repo check when review has caught the same mistake twice. Write the rule as an AST check (TypeScript compiler API) over engine paths: unsafe casts, `as` on JSON, capabilities built outside their owner, brands minted outside their owner, `Record<string, ...>` registries, `default:` over closed unions, fallbacks in persisted parsers, unscoped queries on engine tables. Give each rule a fixture file where a line marked `// expect: <rule>` must produce exactly that finding and no other line produces any; a rule that stops firing fails the check.

Keep the set short: the cast, capability and brand rules pay for themselves, while chasing every contrived bypass (cloning, template parsing, exotic syntax) costs review rounds. Grade a heuristic check missing a contrived bypass as `should`. A checker bug is fixed in the checker; product code keeps its natural shape.

## Regression fixtures stay

When a bug is fixed, its fixture (the escape collision, the missing cell, the duplicate route) joins the suite permanently.
