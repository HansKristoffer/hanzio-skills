# Vue template cleanup

Read this when cleaning up **Vue 3 SFCs** (`<script setup>`) - especially after AI-assisted edits or when a component’s script has grown a wall of alias computeds.

The repo's own UI contract or `AGENTS.md` names its shared components (row, list states, tabs, dialog shell), its error and date helpers and its design tokens. Prefer those over anything generic here.

## Table of contents

1. [Core rule: one source of truth in templates](#1-core-rule-one-source-of-truth-in-templates)
2. [Pass-through computeds](#2-pass-through-computeds)
3. [Grouped state for async data](#3-grouped-state-for-async-data)
4. [Keep vs remove a computed](#4-keep-vs-remove-a-computed)
5. [Data shape in script, not duplicated fields](#5-data-shape-in-script-not-duplicated-fields)
6. [Generic components and scoped slots](#6-generic-components-and-scoped-slots)
7. [Template hygiene](#7-template-hygiene)
8. [Component boundaries (light touch)](#8-component-boundaries-light-touch)
9. [Checklist](#9-checklist)

---

## 1. Core rule: one source of truth in templates

Vue auto-unwraps refs and computeds in templates. Prefer **one reactive object** (computed ref, grouped state) and read fields on it in the template.

**Prefer**

```vue
<EmptyState
  :title="viewState.emptyTitle"
  :description="viewState.emptyDescription"
/>
<div v-if="viewState.isLoading">…</div>
```

**Remove**

```ts
const emptyTitle = computed(() => viewState.value.emptyTitle)
const isLoading = computed(() => viewState.value.isLoading)
```

Move branching and mode-specific config into **one derived computed** instead of many thin aliases.

---

## 2. Pass-through computeds

Do **not** add a computed whose only job is exposing a single field for the template.

| Remove | Use in template instead |
|--------|-------------------------|
| `computed(() => viewState.value.items)` | `viewState.items` |
| `computed(() => asyncState.value.isLoading)` | grouped state (see below) or parent field |
| `computed(() => foo.value.bar)` | `foo.bar` |

---

## 3. Grouped state for async data

Libraries that expose **refs** (TanStack Query, custom data hooks) often type-check poorly when you pass `query.isLoading` or `query.data?.items` directly as **child component props**, even when the template would unwrap correctly.

Prefer **one grouped computed** over several pass-through aliases:

```ts
const listState = computed(() => {
  const items = dataQuery.data.value?.items ?? []
  return {
    items,
    isLoading: dataQuery.isLoading.value,
    isEmpty: items.length === 0,
    count: items.length,
  }
})
```

Template: `listState.items`, `listState.isLoading`, `listState.isEmpty`, `listState.count`.

Derive **repeated template expressions** (`items.length` in three places) into this object - do not repeat the same chain in markup.

---

## 4. Keep vs remove a computed

**Remove** - pass-through field reads (section 2).

**Keep** - when the computed **transforms**, **combines**, or **narrows**:

```ts
// Keep: formats error for display
const errorMessage = computed(() => {
  const err = viewState.value.error
  if (!err) return null
  return err instanceof Error ? err.message : 'Failed to load'
})

// Keep: filters before use in multiple places
const filteredItems = computed(
  () => items.value.filter((item) => item.isActive)
)

// Keep: single switchable view model
const viewState = computed(() => /* branch on activeMode */)
```

**Keep** - used in both template and script where `.value` at every call site would clutter.

Prefer a shared error helper when the repo provides one.

---

## 5. Data shape in script, not duplicated fields

Do not duplicate the same string on multiple keys for template convenience.

**Remove**

```ts
{ label: 'Active', displayLabel: 'Active', value: 'active', count: 3 }
```

**Use**

```ts
{ label: 'Active', value: 'active', count: 3 }
```

Template / slot: `item.label`, not a separate alias field.

---

## 6. Generic components and scoped slots

When an item type **extends** a base shape (e.g. adds `count`), type the child with a **second generic** - do not cast in the slot.

```vue
<script setup lang="ts" generic="T extends string | number, I extends BaseItem<T> = BaseItem<T>">
```

Props: `items: I[]`. Slot `#label="{ item }"` then gets the full item type.

If inference fails, use `@vue-generic` on the usage site (Vue docs) - not `(item as ExtendedItem)` casts.

For `v-model` child components, prefer **`defineModel<T>()`** over manual `modelValue` + `update:modelValue`.

---

## 7. Template hygiene

- **No filtering/sorting in templates** - use a computed (`filteredItems`, `sortedItems`).
- **Stable `:key`** on `v-for` - prefer stable model ids.
- **No `v-if` and `v-for` on the same element** - filter in a computed or wrap the list.
- **Keep templates declarative** - branching and copy live in script; template binds results.
- **PascalCase** component tags and imports in SFCs.
- **Inline template actions** - prefer `@click="openDialog('id', { … })"` or `@event="(arg) => openDialog('id', { arg })"` over a one-line script wrapper. Same for trivial `router.navigate` calls. Keep a named function when it chains `.finally()`, validation, confirm, or multi-step logic.

**Static query inputs** - inline literals in `queryOptions({ input: … })`; do not extract `{ limit: 20 } as const` used only for the query.

**Formatting** - import the repo's date and relative-time formatter; do not duplicate `Intl.DateTimeFormat` or `dayjs().fromNow()` in components.

---

## 8. Component boundaries (light touch)

During cleanup, split only when it **clearly** reduces noise:

- Repeated **list row** markup (~15+ lines) → row component (props in, events up). If the repo already has a row component, compose it - do not draw a new one.
- Repeated **loading / error / empty / content** block → the repo's shared wrapper if it has one.
- Repeated **small presentational fragment** (badge, label row) → tiny child component at 2+ call sites.

Do **not** during cleanup:

- Extract a composable for every feature component “because it’s long.”
- Add slots or API surface to shared components unless a second caller needs it.
- Change fetch strategy (lazy loading, cache policy) - that is product/perf work, not template cleanup.


---

## 9. Checklist

For each touched `.vue` file:

1. Find alias computeds that only mirror `.value.field` → bind field in template or merge into grouped state.
2. Find repeated template expressions → add to grouped computed.
3. Find duplicate keys on the same object (`label` + `displayLabel`) → single canonical field.
4. Find `(item as …)` in slots → fix generic typing on the child component.
5. Find copy-pasted async UI blocks → reuse repo shared component if one exists.
6. Find raw colours, arbitrary sizes or library chrome where the repo has design tokens or wrapper components → move them onto the repo's vocabulary.
7. Find loose mode/view branching in script → `typedSwitch` (or a `never`-checked switch).
8. Run typecheck and the package's UI gates in the affected package.
