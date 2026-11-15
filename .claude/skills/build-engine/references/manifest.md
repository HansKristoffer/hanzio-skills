# Manifest: the backend describes, the frontend renders

Read this when the engine has a UI, or exposes its kinds to an AI tool. The goal: a new kind, field or operation reaches the screen without anyone touching the frontend, and a missing renderer is a compile error.

## The chain

1. Routes declare `input` and `output` with the contract schemas.
2. A manifest route projects the registry into JSON: kinds, fields, labels, parameters.
3. The router type is exported and the frontend infers its API types from it (`InferRouterInputs` / `InferRouterOutputs`): `useQuery((o) => o.catalog.manifest.queryOptions({ input: {} }))`. Engine types arrive with `import type` only.
4. The UI renders the manifest through total maps keyed by kind.

A small engine stops there, with one manifest route and one renderer map per surface (inputs, displays), built by the rules under **Building the manifest** and **Rendering**. Handles, derived capabilities, paging and the etag each say below what they are added for.

## The handle is the one carrier

Add handles when a field's facts differ per tenant or adapter (nullable here, read-only there) and several projections must agree on them. Resolve each field once into a **handle**: address, kind, kind-narrowed descriptor, codecs, operations, facts (nullable, clearable, read-only reason) and effective capabilities. Build handles only through a kind-bound binder:

```ts
type HandleBinders = { readonly [K in ValueKind]: (parts: HandleParts<K>) => FieldHandle<K> }
export function handleBinder<K extends ValueKind>(kind: K): HandleBinders[K] { /* the allowlisted cast lives here */ }
```

Everything else is a **projection** of the handle: the manifest field, a file column, an AI tool's field description. A projection never carries a fact the handle doesn't; when one needs a new fact, add it to the handle first.

## Capabilities are derived, with a reason

Add this when what a field supports varies by tenant, plan, permission or adapter. One pure function answers, per field and tenant: can it be filtered, edited, imported, exported, undone? Each answer is `{ supported: true } | { supported: false; reason: Label }`. Inputs are the declared facts, the adapter binding, what the pinned external API supports, the tenant's configuration and granted permissions, and plan limits. The manifest, the planner and the executor call the same function, so the UI and the server can't disagree. The UI shows an unsupported control disabled with its reason.

## Building the manifest

- **From contracts and handles only**, never from implementations and never by reading Zod internals. Probe a parameter schema through its public API instead: `schema.safeParse(undefined)` tells you whether it is required and what its default is; a default must parse with its own schema.
- **Parameters are declared once** with their control: `param(schema, control, { label })`. Conditional parameters are branches with a discriminator, not free-form visibility rules; values from a hidden branch never survive a branch change.
- **Wire schemas per kind come from iterating the registry**, so a kind added to the registry is in the manifest schema without an edit.
- **Facts that reference other declarations are checked when the manifest is built** (a field's group exists, its default operator is one of its effective operators).
- **Shop- or tenant-specific fields are paged** once a tenant can have more than a screenful: the base manifest carries kinds, static fields, family summaries and shared operation definitions; a bounded `fields` endpoint pages the rest, with a constraint rule (not a list) for pickers.
- **One opaque etag** when the manifest is cached. Keep the dimensions that feed it (definitions, tenant catalog, capabilities, locale) server-side for diagnosis; the client only compares. The cache key includes the verified tenant, never a token.
- **Decode in two stages on the client:** the envelope (version, etag, identities), then each known kind strictly. An unknown future kind renders read-only; an invalid known descriptor is an error.

## Rendering

- **Total renderer maps keyed by kind**, checked per key: `inputs satisfies { [K in ValueKind]: Renderer<ValueInputProps<K>> }`, and the same for displays and controls. Pages never index the maps; one dispatcher per map holds the single allowlisted cast and keeps descriptor, value and update callback together.
- **Props are correlated per kind and nullability**: build each `(kind × nullable)` case, then the union, so a required money input rejects `null` and a union-typed input rejects a boolean paired with money.
- **One display per kind, everywhere**: grid cells, previews, history and receipts use the same display map.
- **Drafts are not values.** Inputs hold a raw draft (`-` mid-typing is valid), parse it, and emit only parsed values; invalid drafts keep their errors and survive virtualization and refetches.
- **Overrides** for the few fields that need a custom UI are a registry with the same contract, used only when the field's kind matches.
- **A kitchen-sink manifest** generated from the real registry mounts every input, display and control in one test and checks that what each emits parses with the wire schema.

## Framework notes

- **Vue:** `Component<P>` collapses correlated prop unions, so a per-key map check passes things it shouldn't. A small `Renderer<P>` type built on the component's `$props`, plus `defineProps<Keys & /* @vue-ignore */ Props<'money'>>()` and a compile-time key-drift assertion, kept the per-kind check honest. Check this in the first frontend proof, not later.
- **React:** `ComponentType<Props<K>>` per key works with `satisfies`; keep discriminated props unions intact by not spreading them through generic wrapper components.
- **Bind the kit to the real registry as soon as it exists.** A kit typed against a small fixture registry hides every missing renderer until the switch.
