# Types: one source, derived everywhere

The engine's type system has one job: make the wrong program fail to compile, and make what the compiler can't see fail at startup. Start from the worked core. The sections down to **Implementations get typed inputs** apply to every engine; the ones after it each open with when to read them.

## The core, worked

This file typechecks as written under the strict flags below (TypeScript 5.9 and 7, Zod 4) with no cast, no `any` and no type argument at a call site. Adapt its shape to the domain.

```ts
import { z } from 'zod'

// contracts: zod only
type Schemas<O> = { readonly [Key in keyof O]: z.ZodType }
type KindContract<K extends string, V extends z.ZodType, O extends Schemas<O>> = {
  readonly key: K
  readonly value: V
  readonly operations: O
}

export const defineKind = <const K extends string, V extends z.ZodType, const O extends Schemas<O>>(
  contract: KindContract<K, V, O>,
) => contract

const title = z.string().min(1).max(255)
export const text = defineKind({
  key: 'text',
  value: title,
  operations: { set: z.object({ to: title }), append: z.object({ suffix: z.string() }) },
})
const count = z.int().min(0)
export const integer = defineKind({
  key: 'integer',
  value: count,
  operations: { set: z.object({ to: count }), add: z.object({ amount: z.int() }) },
})

// engine: pure
type ErrorCode = 'operation.unknown' | 'value.invalid' | 'params.invalid' | 'result.invalid'
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: ErrorCode } }
const fail = (code: ErrorCode) => ({ ok: false, error: { code } }) as const

export const hasKey = <T extends object>(object: T, key: PropertyKey): key is keyof T => Object.hasOwn(object, key)

export function implement<K extends string, V extends z.ZodType, O extends Schemas<O>>(contract: KindContract<K, V, O>) {
  type Value = z.output<V>
  type Applied = Result<{ kind: K; value: Value }>

  return (operations: { readonly [Op in keyof O]: (current: Value, params: z.output<O[Op]>) => Value }) => {
    function run<Op extends keyof O>(operation: Op, current: Value, rawParams: unknown): Applied {
      const params = contract.operations[operation].safeParse(rawParams)
      if (!params.success) return fail('params.invalid')
      // The callback's type says "a number". The value schema says whether it is a valid count.
      const next = contract.value.safeParse(operations[operation](current, params.data))
      return next.success ? { ok: true, value: { kind: contract.key, value: next.data } } : fail('result.invalid')
    }

    return {
      contract,
      apply(operation: string, rawCurrent: unknown, rawParams: unknown): Applied {
        if (!hasKey(contract.operations, operation)) return fail('operation.unknown')
        const current = contract.value.safeParse(rawCurrent)
        return current.success ? run(operation, current.data, rawParams) : fail('value.invalid')
      },
    }
  }
}

export const textEngine = implement(text)({
  set: (_current, params) => params.to,
  append: (current, params) => current + params.suffix,
})
export const integerEngine = implement(integer)({
  set: (_current, params) => params.to,
  add: (current, params) => current + params.amount,
})

// registry: the one list, and everything derived from it
export const kinds = { text: textEngine, integer: integerEngine }

export type Kind = keyof typeof kinds
type Contracts = { [K in Kind]: (typeof kinds)[K]['contract'] }
export type ValueOf<K extends Kind> = z.output<Contracts[K]['value']>
export type Change = {
  [K in Kind]: {
    [Op in keyof Contracts[K]['operations']]: { kind: K; operation: Op; params: z.input<Contracts[K]['operations'][Op]> }
  }[keyof Contracts[K]['operations']]
}[Kind]

export const kindLabels = { text: 'Text', integer: 'Whole number' } as const satisfies Record<Kind, string>

export const applyChange = (change: Change, current: unknown) =>
  kinds[change.kind].apply(change.operation, current, change.params)

// type tests: each rejected program beside the one that must compile
applyChange({ kind: 'integer', operation: 'add', params: { amount: 5 } }, 10)
// @ts-expect-error append is a text operation
applyChange({ kind: 'integer', operation: 'append', params: { suffix: '!' } }, 10)
// @ts-expect-error an integer operation returns a number
implement(integer)({ set: (_current, params) => params.to, add: (current) => String(current) })
```

What carries the design:

- **Adding a `money` kind** is one `defineKind`, one `implement` and one line in `kinds`. `kindLabels` stops compiling until it has the entry, and `Kind`, `ValueOf` and `Change` already include it.
- **`implement(contract)(operations)` binds before it infers.** The contract fixes `Value` and each `params` type, then the callbacks are checked against them, so a callback can't widen the contract and method-syntax bivariance can't hide a mismatch.
- **`apply` takes `unknown` and parses.** `applyChange` picks a kind at runtime and still needs no cast, because every kind has the same outer signature and re-establishes its own types inside by parsing. When a hot loop can't afford the second parse, one dispatcher holds one allowlisted cast (see **Casts**).
- **`apply` returns its own kind with the value**, so the union that comes back out of the dispatcher is still correlated: narrowing on `kind` narrows `value`. A function that must run in steps around I/O (plan, write, settle) returns the next step as a closure from the same binding, which keeps the types without passing them through the caller.
- **Every result is parsed with the value schema.** A callback's type says "a number"; the schema says whether it is a valid count, and a result that isn't is an error for that item.
- **`Change` is one case per kind and operation, then the union**, so an `integer` change can't carry a `text` operation or its params.

Three things in it that look arbitrary and aren't:

- `O extends Schemas<O>` constrains the operations by their own keys. `Record<string, z.ZodType>` would add an index signature, which erases the keys and, under `noUncheckedIndexedAccess`, makes every lookup `| undefined`.
- `schema.safeParse(raw)`, the method. The function form `z.safeParse(schema, raw)` infers `unknown` when the schema's type is an indexed access like `O[Op]`.
- `hasKey` is a type predicate. It replaces `operation as keyof O`.

## Strict program

Give every engine path a stricter tsconfig than the rest of the repo, runtime and adapters included (flags in one package don't follow its types into the backend): `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noImplicitOverride`, `noPropertyAccessFromIndexSignature`. Lint `noExplicitAny`, `noNonNullAssertion` and `useExhaustiveSwitchCases` as errors on engine paths. Measure typecheck time once a real registry exists, and simplify the slowest type when it grows.

## One case per kind, then the union

When a kind travels with its data (descriptor and value, command kind and payload, selection target and its matchers), build a mapped union so they stay correlated:

```ts
type Routed = { [K in CommandKind]: { kind: K; adapter: AdapterOf<K>; payload: PayloadOf<K> } }[CommandKind]
```

A generic with a default (`K extends Kind = Kind`) or a method typed against the whole union loses the correlation and lets a `money` payload reach a `text` handler. Use kind-bound closures like `apply` above, and match data to its command by identity (an ID or input index): a swap of two equal-looking payloads must fail a test.

## Closed unions, total maps

```ts
export const errorMessages = { 'value.format': ..., 'value.outOfRange': ... } as const satisfies Record<ErrorCode, Message>
export const retryDecision = { idempotent: {...}, conditional: {...} } as const satisfies Record<RecoveryClass, Record<Observation, Decision>>
```

Switch over a closed union with an exhaustive helper (hanzio's `typedSwitch`) and no `default:`; a `default` belongs only over open input you are parsing. Maps over external enums are keyed by the generated enum type.

**Kind hotspots.** Some per-kind maps live outside the registry (manifest projections, presentation, conformance cases). List every one in the engine rulebook under "Adding a kind touches", and make each a total map so the compiler finds them.

## Boundaries parse, codecs convert

- **Parse at every boundary:** API requests, webhooks, job payloads, persisted JSON, external API responses, file rows. `z.input` for incoming JSON, `z.output` for evaluated values.
- **Untyped data goes through a schema.** `row.payload as Command` is the classic bug; generated `unknown` scalars and DB JSON columns are the usual places.
- **Wire schemas are JSON-compatible:** no transforms, only pure refinements. A test converts every wire schema with `z.toJSONSchema` on both sides, `{ io: 'input' }` and `{ io: 'output' }`; only the output side throws on a transform.
- **One codec per boundary, named for the boundary** (`wire`, `remote`, `cell`). A slot named after a vendor leaks that vendor into every kind.
- **Two-way conversions are `z.codec`**, each in a generic `decode(encode(x)) === x` property test. Build codecs once per column or config. Row loops use `safeParse` / `safeDecode`.
- **Optional wire props use `.exactOptional()`;** engine types use required discriminants (`{ kind: 'none' } | { kind: 'some'; value }`), and an operand-less case has no operand property at all.

## Persisted JSON is versioned

For every JSON shape the engine stores.

```ts
/** @persistedParser */
export const evidence = z.discriminatedUnion('version', [v1, v2])   // upgrade on read, write the latest
```

A persisted parser has no `.default()` and no `.catch()`: a fallback silently turns corrupt or old data into plausible data. Bump the version instead.

## Errors

- One closed error vocabulary: `errorDetailSchemas` maps each code to its details schema, and messages are a total map over the codes.
- `Result<T> = { ok: true; value: T } | { ok: false; error: EngineError }` for anything that can fail validation. `kind` discriminates shapes, `status` discriminates lifecycle outcomes.
- One conversion from Zod issues to engine errors. Users see the engine's messages, never Zod's, and `reportInput` stays off.
- Labels are data (`{ kind: 'catalog'; key } | { kind: 'user'; text }`), so the UI translates them and derived keys are checked against the catalog.

## Casts

`as const` and type predicates are the tools. Any other cast is on a short allowlist, each with a comment and both a positive and a negative type test. No `any`, no `!`.

## Implementations get typed inputs

Resolve dependencies once and pass typed objects plus a small context (`{ signal: AbortSignal; locale: string }`) in place of a service locator. Streaming is `AsyncIterable` plus `AbortSignal`. Writers that must publish or abort use `await using`; only `finalize()` publishes.

## When contracts and implementations register separately

Read this when the contracts package holds the list of kinds and the backend registers the implementations, so the two can disagree.

1. Infer each local declaration with its literal types (`const` generics, `satisfies`).
2. Validate relationships against the full registry: at compile time where possible (`NoExtraKeys<I, C>` for missing and extra implementations, unknown parent keys as errors), and at startup for what types can't express (duplicates, cycles, "every writable field routes to exactly one adapter").

```ts
type NoExtraKeys<T, R> = { readonly [K in Exclude<keyof T, keyof R>]: never }

export function defineRegistry<
  const C extends Record<keyof C, Contract>,
  const I extends { readonly [K in keyof C]: Implemented<C[K]> },
>(contracts: C, impls: I & NoExtraKeys<I, C>): I { /* runtime: missing, extra, bound-to-another-contract */ }
```

Pass implementations already built with `implement`; an inline callback in `impls` gets no contextual type through the intersection.

## When a second registry needs the same types

Read this when a fixture registry in tests, or a UI kit built before the real registry exists, must reuse the derived types. Write each one generically over the registry, then bind it once beside the real registry:

```ts
export type ValueKindIn<R> = keyof R & string
export type ValueOfIn<R extends Kinds, K extends ValueKindIn<R>> = z.output<R[K]['value']>

export type ValueKind = ValueKindIn<typeof kinds>
export type ValueOf<K extends ValueKind> = ValueOfIn<typeof kinds, K>
```

## Identity and authority

Read this when the engine has more than one tenant, or a state only one module may grant (an acquired lease, an approved plan).

- **Distinct ID types.** `Id<'Invoice'>` for persisted models, per-resource external IDs from a schema (template-literal types plus a refine), so an invoice ID can't be passed where a tenant ID belongs.
- **Capabilities are minted by their owner only.** A `unique symbol` brand that only one module can name, frozen at creation, tagged with its owner:

```ts
const trusted: unique symbol = Symbol('TrustedTenant')
/** @capabilityOwner src/lib/auth/trusted-tenant.ts */
export interface TrustedTenant { readonly [trusted]: true; readonly tenantId: Id<'Tenant'> }
export const trustedTenantFromVerifiedRequest = (id: Id<'Tenant'>): TrustedTenant =>
  Object.freeze({ [trusted]: true as const, tenantId: id })
```

  Other capabilities follow the same shape: an acquired or reconciled lease, a sealed or approved plan, tenant-owned rows (`TenantOwned<T>` from `storeFor(tenant)`), a ready artifact.
- **A tenant ID sent by a client is data, never authority.** Requests get the trusted tenant from verified auth.
- **Loading is not granting.** A row with `status: 'sealed'` parses into data. Only a transition function, or a loader that checks revision, hash and evidence, returns `SealedPlan`.
- **Encode required order in types.** If you must reconcile before advancing, `advance` accepts only a `ReconciledLease`, which only `reconcile` returns.
- **Authority-bearing nested data is deeply `readonly` and frozen at runtime.**
- **Brands guard against accidents; the database decides races.** Every state write is fenced in SQL (`WHERE id = $1 AND lease_token = $2`).
