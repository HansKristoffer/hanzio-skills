# Vue template cleanup

Read this when cleaning up **Vue 3 SFCs** (`<script setup>`), especially after AI-assisted edits or when a component's script has grown a wall of alias computeds.

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

A computed whose only job is exposing a single field for the template fails the deletion test: read the field in the template.

| Remove | Use in template instead |
|--------|-------------------------|
| `computed(() => viewState.value.items)` | `viewState.items` |
| `computed(() => asyncState.value.isLoading)` | grouped state (see below) or parent field |
| `computed(() => foo.value.bar)` | `foo.bar` |

---

## 3. Grouped state for async data

Libraries that expose **refs** (TanStack Query, custom data hooks) return a plain object of refs, and a template unwraps only top-level refs. `query.isLoading` passed as a **child component prop** or tested in `v-if` is the ref itself, which is always truthy, and `query.data?.items` reads a property of the ref, not of the data.

Prefer **one grouped computed** over several pass-through aliases:

```ts
const listState = computed(() => {
  const items = itemsQuery.data.value?.items
  return {
    items: items ?? [],
    hasData: items !== undefined,
    isEmpty: items?.length === 0,
    isFirstLoad: items === undefined && itemsQuery.isFetching.value,
    error: itemsQuery.error.value,
    count: items?.length ?? 0,
  }
})
```

Template: `listState.items`, `listState.hasData`, `listState.isEmpty`, `listState.isFirstLoad`, `listState.error`, `listState.count`.

`undefined` means no answer yet, and `[]` is a successful empty list, so `isEmpty` is false until data arrives. Computing `isEmpty` from `data?.items ?? []` shows the empty state while loading and after an error. The order to branch in the template is in [ui-states.md](ui-states.md#1-data-first).

Derive **repeated template expressions** (`items.length` in three places) into this object, so the markup holds each chain once.

---

## 4. Keep vs remove a computed

**Remove** pass-through field reads (section 2).

**Keep** a computed that **transforms**, **combines**, or **narrows**:

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

**Keep** one used in both template and script, where `.value` at every call site would clutter.

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

When an item type **extends** a base shape (e.g. adds `count`), type the child with a **second generic** instead of casting in the slot.

```vue
<script setup lang="ts" generic="T extends string | number, I extends BaseItem<T> = BaseItem<T>">
```

Props: `items: I[]`. Slot `#label="{ item }"` then gets the full item type.

If inference fails, use `@vue-generic` on the usage site (Vue docs), not `(item as ExtendedItem)` casts.

For `v-model` child components, prefer **`defineModel<T>()`** over manual `modelValue` + `update:modelValue`.

---

## 7. Template hygiene

- **Filter and sort in a computed** (`filteredItems`, `sortedItems`), not in the template.
- **Stable `:key`** on `v-for`, from model ids.
- **`v-if` and `v-for` on separate elements**: filter in a computed or wrap the list.
- **Declarative templates**: branching and copy live in script, and the template binds results.
- **PascalCase** component tags and imports in SFCs.

---

## 8. Component boundaries (light touch)

During cleanup, split only when it **clearly** reduces noise:

- Repeated **list row** markup (~15+ lines) → row component (props in, events up). If the repo already has a row component, compose it instead of drawing a new one.
- Repeated **loading / error / empty / content** block → the repo's shared wrapper if it has one.
- Repeated **small presentational fragment** (badge, label row) → tiny child component at 2+ call sites.

Leave for other work:

- a composable extracted only because a component is long;
- a slot or prop on a shared component that no second caller needs;
- fetch strategy (lazy loading, cache policy), which is product or performance work, not template cleanup.

---

## 9. Checklist

For each touched `.vue` file:

1. Find alias computeds that only mirror `.value.field` → bind field in template or merge into grouped state.
2. Find repeated template expressions → add to grouped computed.
3. Find duplicate keys on the same object (`label` + `displayLabel`) → single canonical field.
4. Find `(item as …)` in slots → fix generic typing on the child component.
5. Find copy-pasted async UI blocks → reuse the repo's shared component if one exists. Check each one branches on data first, keeps content through refetch and errors, and shows saving on its button ([ui-states.md](ui-states.md)).
