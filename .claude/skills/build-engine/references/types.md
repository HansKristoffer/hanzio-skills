# Types: one source, derived everywhere

The engine's type system has one job: make the wrong program fail to compile, and make what the compiler can't see fail at startup. Every rule below serves that.

## Strict program

Give the engine packages a stricter tsconfig than the rest of the repo: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`. Lint `noExplicitAny`, `noNonNullAssertion` and `useExhaustiveSwitchCases` as errors on engine paths. Measure typecheck time once a real registry exists; deep generics are fine until they aren't.

## Declare once with `const` generics

A kind (field type, entity, command, document format, device model) is one declaration. Unions are derived from the registry, never typed out:

```ts
export function defineKind<const K extends string, const V extends z.ZodType, const O extends Operations<V>>(
  def: { key: K; value: V; operations: O }
) {
  return Object.freeze(def)
}

export const kinds = defineRegistry({ money, text, integer })

type KindKey = keyof typeof kinds                         // derived
type ValueOf<K extends KindKey> = z.output<(typeof kinds)[K]['value']>
```

If you ever write `type Kind = 'money' | 'text' | ...` by hand, the registry and the union will drift. Delete the hand-written one.

## Bind before you infer

Accept implementation callbacks only after the contract fixed the types, so a callback can't widen them (and method-syntax bivariance can't hide a mismatch):

```ts
export const moneyEngine = implement(money)({
  canonicalize: canonicalDecimal,
  operations: { add: (current, params) => ... },   // current, params, result: money's types only
})
```

`implement(contract)` returns a function typed by the contract. The builder also checks every result against the contract's schema at runtime.

## Two-stage registries

1. Infer each local declaration with its literal types (`const` generics, `satisfies`).
2. Validate relationships against the full registry: at compile time where possible (`NoExtraKeys<I, C>` for missing and extra implementations, unknown parent keys as errors), and at startup for what types can't express (duplicates, cycles, "every writable field routes to exactly one adapter").

```ts
type NoExtraKeys<T, R> = { readonly [K in Exclude<keyof T, keyof R>]: never }

export function defineRegistry<
  const C extends Record<keyof C, Contract>,
  const I extends { readonly [K in keyof C]: Implemented<C[K]> },
>(contracts: C, impls: I & NoExtraKeys<I, C>): I { /* runtime: missing, extra, bound-to-another-contract */ }
```

Never annotate a registry as `Record<string, ...>`: it erases every key. A repo check can reject that.

## One case per kind, then the union

When a kind travels with its data (descriptor and value, command kind and payload, selection target and its matchers), build a mapped union so they stay correlated:

```ts
type Routed = { [K in CommandKind]: { kind: K; adapter: AdapterOf<K>; payload: PayloadOf<K> } }[CommandKind]
```

A generic with a default (`K extends Kind = Kind`) or a method typed against the whole union loses the correlation and lets a `money` payload reach a `text` handler. Prefer kind-bound closures over union methods.

## Closed unions, total maps

```ts
export const errorMessages = { 'value.format': ..., 'value.outOfRange': ... } as const satisfies Record<ErrorCode, Message>
export const retryDecision = { idempotent: {...}, conditional: {...} } as const satisfies Record<RecoveryClass, Record<Observation, Decision>>
```

No `default:` in a switch over a closed union; use an exhaustive switch helper (hanzio's `typedSwitch`). A `default` is fine only over open input you are parsing. Maps over external enums are keyed by the generated enum type.

## Boundaries parse, codecs convert

- **Parse at every boundary:** API requests, webhooks, job payloads, persisted JSON, external API responses, file rows. `z.input` for incoming JSON, `z.output` for evaluated values.
- **Never `as` on untyped data.** `row.payload as Command` is the classic bug. Generated `unknown` scalars and DB JSON columns go through a schema.
- **Wire schemas are JSON-compatible:** no transforms, only pure refinements. A test converts every wire schema with `z.toJSONSchema(schema, { io: 'input' })`.
- **Two-way conversions are `z.codec`**, each in a generic `decode(encode(x)) === x` property test. Build codecs once per column or config, not per row. Row loops use `safeParse` / `safeDecode`, never throwing variants.
- **Optional wire props use `.exactOptional()`;** engine types use required discriminants (`{ kind: 'none' } | { kind: 'some'; value }`), and an operand-less case has no operand property at all.

## Persisted JSON is versioned

```ts
/** @persistedParser */
export const evidence = z.discriminatedUnion('version', [v1, v2])   // upgrade on read, write the latest
```

No `.default()` or `.catch()` in a persisted parser: a fallback silently turns corrupt or old data into plausible data. Bump the version instead.

## Identity and authority

- **Distinct ID types.** `Id<'Invoice'>` for persisted models, per-resource external IDs from a schema (template-literal types plus a refine). A bare `string` ID is a bug.
- **Capabilities are minted by their owner only.** A `unique symbol` brand that only one module can name, frozen at creation, tagged with its owner:

```ts
const trusted: unique symbol = Symbol('TrustedTenant')
/** @capabilityOwner src/lib/auth/trusted-tenant.ts */
export interface TrustedTenant { readonly [trusted]: true; readonly tenantId: Id<'Tenant'> }
export const trustedTenantFromVerifiedRequest = (id: Id<'Tenant'>): TrustedTenant =>
  Object.freeze({ [trusted]: true as const, tenantId: id })
```

  Other capabilities follow the same shape: an acquired or reconciled lease, a sealed or approved plan, tenant-owned rows (`TenantOwned<T>` from `storeFor(tenant)`), a ready artifact.
- **Loading is not granting.** A row with `status: 'sealed'` parses into data, never into `SealedPlan`. Only a transition function, or a loader that checks revision, hash and evidence, returns the capability.
- **Encode required order in types.** If you must reconcile before advancing, `advance` accepts only a `ReconciledLease`, which only `reconcile` returns.
- **Authority-bearing nested data is deeply `readonly` and frozen at runtime.**
- **Brands guard against accidents, not forgery.** The database fences the real race.

## Errors

- One closed error vocabulary: `errorDetailSchemas` maps each code to its details schema, and messages are a total map over the codes.
- `Result<T> = { ok: true; value: T } | { ok: false; error: EngineError }` for anything that can fail validation. `kind` discriminates shapes, `status` discriminates lifecycle outcomes.
- One conversion from Zod issues to engine errors. Zod's messages are never shown to users; never set `reportInput: true`.
- Labels are data (`{ kind: 'catalog'; key } | { kind: 'user'; text }`), so the UI translates them and derived keys are checked against the catalog.

## Casts

None outside an allowlist. Each allowlisted cast has a comment and both a positive and a negative type test. `as const` is fine. No `any`, no `!`.

## Implementations get typed inputs

Resolve dependencies once and pass typed objects plus a small context (`{ signal: AbortSignal; locale: string }`), never a service locator. Streaming is `AsyncIterable` plus `AbortSignal`. Writers that must publish or abort use `await using`; only `finalize()` publishes.
