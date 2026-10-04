# Typed contracts cleanup

Read this when cleaning up **type assertions**, **loose `string` ids**, or **manual shape mirrors** between a backend and its clients. The examples assume branded ids (`Id<'Model'>`, `asId`, `zId`), Prisma, and an oRPC router; translate them to the repo's equivalents, and follow its `AGENTS.md` where it names its own types and helpers.

## Table of contents

1. [Fix types at the source, not at every call site](#1-fix-types-at-the-source-not-at-every-call-site)
2. [Backend formatters and Prisma query results](#2-backend-formatters-and-prisma-query-results)
3. [Router-derived shapes on the client](#3-router-derived-shapes-on-the-client)
4. [Branded id boundaries](#4-branded-id-boundaries)
5. [Enums and curated literals](#5-enums-and-curated-literals)
6. [Casts inside generic helpers](#6-casts-inside-generic-helpers)
7. [Exhaustive branching](#7-exhaustive-branching)
8. [Anti-patterns (remove on sight)](#8-anti-patterns-remove-on-sight)
9. [Checklist](#9-checklist)

---

## 1. Fix types at the source, not at every call site

**Do not** add client helpers whose only job is re-branding ids from the API:

```ts
// ❌ Shim sprawl - every caller needs the helper
export function brandOrderId(order: { id: string }) {
  return asId<'Order'>(order.id)
}
```

**Do** fix the backend formatter / row type so the router output already exposes `Id<'Order'>`.

One `asId` at a **true external boundary** (URL param, env, test fixture) is fine. Ten casts at API consumers means the producer type is wrong.

---

## 2. Backend formatters and Prisma query results

Prisma's raw `GetPayload` on a `select` yields plain `string` ids. When the repo brands ids on query results (a Prisma client extension that maps `id` and relation `*Id` fields to `Id<'Model'>`), type formatter rows from **the extended client**, not from raw `GetPayload`, and the brands flow through to the router output for free.

**Prefer**

```ts
// Row type derived from the extended client's findMany result
export type OrderListRow = ExtendedFindManyRow<
  typeof prisma.order.findMany<{ select: typeof orderListSelect }>
>

export function formatOrderListItem(row: OrderListRow) {
  return {
    id: row.id, // Id<'Order'> - flows into the router output
    organizationId: row.organizationId, // Id<'Organization'> - no asId()
  }
}
```

**Avoid**

```ts
type Row = Prisma.OrderGetPayload<{ select: typeof select }>
// row.id is string → forces client casts everywhere

return {
  id: asId<'Order'>(row.id),
  organizationId: asId<'Organization'>(row.organizationId),
}
// ❌ Redundant when the row comes from the extended client - ids are already branded
```

Return each key explicitly and let inference carry branded ids through route handlers.

**Direct `prisma.*` calls** (providers, jobs, sync): use result fields as-is. Do not re-wrap them with `asId`. If a field still types as `string`, the column has no `@relation` in the schema or the extension needs a manual mapping for it, or the row type came from raw `GetPayload` - fix that once.

---

## 3. Router-derived shapes on the client

Derive client shapes from the router - do not mirror them by hand.

```ts
import type { RouterInput, RouterOutput } from '@scope/backend'

type OrderListItem = RouterOutput['order']['getAll']['items'][number]
type MarkReadInput = RouterInput['inbox']['markRead']
```

Build call inputs with **`satisfies`** on the inferred input type instead of `as never`:

```ts
const input = {
  sessionId: props.sessionId,
  throughMessageId: asId<'Message'>(messageId), // came in as a plain string from the DOM
} satisfies MarkReadInput
await orpc.inbox.markRead.call(input)
```

Shared client types (a protocol package, shared schemas) come from that package - not local duplicates or `Pick<RouterOutput, …>` re-shapes.

---

## 4. Branded id boundaries

| Source | Pattern |
|--------|---------|
| Extended Prisma query / mutation result | Use `row.id`, `row.organizationId` **directly** |
| Router list/get/detail output | Use `item.id` directly once the backend formatter is fixed |
| URL / route param | `asId<'Model'>(id)` **once** at the route boundary |
| Callback handing back a plain `string` (DOM, observer) | `asId<'Model'>(id)` at the mutation call site |
| Test fixtures | `asId<'Model'>('fixture-id')` |
| Webhook / JSON / env / untrusted string | `zId('Model').parse(…)` (or `asId` after validation) **once** at the parse boundary |

**React / Expo screens:** if hooks require `Id<'Model'>` but the route param may be missing, split the screen - guard in the outer component and render an inner one that receives `id: Id<'Model'>`, so hooks are never fed `null` or empty-string placeholders.

**Vue props:** type `orderId: Id<'Order'>` on connected components; do not accept `string` and cast at every query site.

---

## 5. Enums and curated literals

Use the shared curated list, not `Object.entries` plus a cast:

```ts
import { languageCodeMapping, languageCodes } from '@scope/utils'

languageCodes.map((value) => ({ value, label: languageCodeMapping[value] }))
```

**Prisma enums** - import them from the generated client or the repo's Prisma package; do not re-declare string unions.

---

## 6. Casts inside generic helpers

A generic infrastructure helper (a live-query or subscription wrapper, a typed fetch layer) may genuinely need a cast where the library's typing gives out. That is acceptable **only inside the shared helper** - not copied into every feature wrapper. When touching such a helper, fix its generic once rather than adding `as never` at each call site, and do not add new escapes in feature code to avoid fixing it.

---

## 7. Exhaustive branching

Use **`typedSwitch`** from **`hanzio`** (when the repo uses it) for discriminated unions and enums in TS, TSX and Vue script:

```ts
typedSwitch(props.status, {
  VERIFIED: () => `${kind} verified`,
  EXPIRED: () => `${kind} verification expired`,
  CANCELLED: () => `${kind} verification cancelled`,
  PENDING: () => `Verifying ${kind}…`,
})
```

- Scalar discriminator: `typedSwitch(value, { A: () => …, B: () => … })`
- Object discriminator: `typedSwitch(obj, 'kind', { start: (e) => …, result: (e) => … })`
- Constrained return: `typedSwitch<ReturnType>(discriminator, { … })`

Without hanzio, use a `switch` with a `const _exhaustive: never = value` default. Either way, replace loose ternary chains on enums and `Record<string, Component>` for closed registries (`Record<RenderKind, Component>` makes a missing key a compile error). Template `v-if` chains on discriminated types are fine when they narrow props for child components.

---

## 8. Anti-patterns (remove on sight)

| Pattern | Fix |
|---------|-----|
| `props.x as never` on an oRPC `.call()` | Router input type + `satisfies` |
| `item.id as Id<'Model'>` on router output | Fix the backend formatter's row type |
| `asId<'Organization'>(row.organizationId)` on a Prisma result | Use the field directly; fix the row type, schema relation or extension mapping if it is still `string` |
| `brandFooId()` used in 3+ files | Fix the producer's output type; delete the helper |
| `value as LanguageCode` from `Object.entries` | The curated list from the shared package |
| `ref<string \| null>` for entity ids | `Id<'Model'> \| null` |
| `reason: null as string \| null` | `reason: null` |
| `(data ?? null) as SomeState \| null` | Fix the helper's generic; drop the cast |
| Duplicate local API response types | `RouterOutput['route']['method']` |
| `as never as Foo[]` on data from a shared protocol | Run it through that package's parser or reducer |

---

## 9. Checklist

For touched backend formatters, API consumers and list code:

1. Grep touched files for `\bas\b`, `as never`, `as unknown`, `: any` - eliminate or document at a single boundary.
2. Backend formatters and providers: row types come from the extended client when returning branded ids; **no `asId` on Prisma query fields**.
3. Clients: consume router input/output types and shared protocol packages - no parallel shapes.
4. Route params: **`asId` once** at the boundary; props typed as `Id<'Model'>` downstream.
5. Enum/union maps: **`typedSwitch`** or a `never`-checked switch.
6. Run the typecheck for every affected package.
