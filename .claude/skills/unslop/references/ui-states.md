# Async UI states

Read this when touched UI code reads a query, runs a mutation, or shows a loading, empty or error state. The patterns here are behavior bugs, not style: an empty state that flashes before the data arrives, an error that wipes the list, a button that jumps when it starts saving. In a cleanup pass, fix them in the touched component when the fix stays inside it, and list each one in the output as a behavior change. A fix that needs a new shared component or an API change goes in the output as `left [X], revisit when [Y]`.

The repo's own list-state, notice and button components win over the placeholder names below.

## Table of contents

1. [Data first](#1-data-first)
2. [Errors stay beside what failed](#2-errors-stay-beside-what-failed)
3. [The query library owns the promise](#3-the-query-library-owns-the-promise)
4. [Store ids and edits, not copies](#4-store-ids-and-edits-not-copies)
5. [The layout holds still](#5-the-layout-holds-still)
6. [Prove a transition](#6-prove-a-transition)

---

## 1. Data first

Ask whether there is data before asking what the request is doing. `data === undefined` means no answer yet. An empty array or `0` is a successful answer and gets the empty state. A test like `items.length === 0` on `data?.items ?? []` shows "No items yet" while the first request is in flight and again after it fails.

| Data | Request | Show |
| --- | --- | --- |
| Present, empty included | Idle | The content, or the empty state |
| Present | Refetching | The content; a quiet refresh hint only for a refresh the user asked for |
| Present | Refresh failed | The content, with an inline notice and a retry |
| Present, paged | Next page loading or failed | The loaded rows, with progress or a retry at the end of the list |
| Absent | Fetching | The first-load view (section 5) |
| Absent | Failed | A blocking error for that region, with a retry |
| Absent | Paused, offline | Waiting for the connection, with a retry |
| Absent | Disabled, or its input is missing | What the user has to do first, never a spinner that never ends |

Data and an error can be present together. A refetch on window focus, a retry or a pull to refresh keeps the content mounted with its scroll position and any input.

Vue, with the grouped `listState` from [vue.md](vue.md#3-grouped-state-for-async-data):

```vue
<template v-if="listState.hasData">
  <ErrorNotice v-if="listState.error" :error="listState.error" @retry="itemsQuery.refetch()" />
  <EmptyState v-if="listState.isEmpty" />
  <ItemList v-else :items="listState.items" />
</template>
<ErrorState v-else-if="listState.error" :error="listState.error" @retry="itemsQuery.refetch()" />
<ItemListPending v-else-if="listState.isFirstLoad" />
<ItemListNotRequested v-else />
```

React:

```tsx
const itemsQuery = useQuery(orpc.items.list.queryOptions({ input: {} }))

if (itemsQuery.data !== undefined) {
  const { items } = itemsQuery.data
  return (
    <>
      {itemsQuery.error && <ErrorNotice error={itemsQuery.error} onRetry={() => itemsQuery.refetch()} />}
      {items.length === 0 ? <EmptyState /> : <ItemList items={items} />}
    </>
  )
}
if (itemsQuery.error) return <ErrorState error={itemsQuery.error} onRetry={() => itemsQuery.refetch()} />
if (itemsQuery.isFetching) return <ItemListPending />
return <ItemListNotRequested />
```

Keep the query result as the library returns it and branch where it is rendered. A shared `loading | error | success` wrapper loses the "data and an error" and "data and refetching" rows of the table.

---

## 2. Errors stay beside what failed

- An error shows next to the content or the action it belongs to, and stays until the user retries or the cause goes away. A toast is for news with no place on screen, like a background export that finished.
- A failed mutation keeps what the user typed and the content already on screen.
- The error's code picks the copy and the recovery: the API's typed errors, or the repo's error helper. Matching on `error.message` breaks the first time the backend rewords it. A generic message covers only the codes the screen does not know.

---

## 3. The query library owns the promise

Flag a `loading` ref or `useState(false)` set before an `await` and cleared in `finally`, an `error` ref filled in `catch`, and a copy of `isPending` kept in local state. The same bookkeeping moved into a composable, hook or reducer is the same bug: two owners of one lifecycle that drift apart on the first early return.

Use `useMutation` for writes, `useQuery` for reads and, in React, `useTransition` for a simple action with nothing to show but pending. Read `isPending`, `error` and `data` from it directly.

Before:

```ts
const saving = ref(false)
const saveError = ref<unknown>(null)

async function save() {
  saving.value = true
  saveError.value = null
  try {
    await client.items.update(form.value)
  } catch (error) {
    saveError.value = error
  } finally {
    saving.value = false
  }
}
```

After:

```ts
const { mutate: save, isPending: isSaving, error: saveError } = useMutation(
  orpc.items.update.mutationOptions(),
)
```

This is about state the UI renders. Server code and plain library code compose promises as usual.

---

## 4. Store ids and edits, not copies

- A selection holds the id (`selectedItemId`) and reads the row from the query data where it is used. A stored copy of the row goes stale on the next refetch. Handle an id that is no longer in the data.
- An edit form over a fetched record holds only the fields the user changed. Each field shows the edit when there is one and the fetched value otherwise, so a refetch updates untouched fields and never overwrites typing. Replace a record copied into the form (`ref({ ...query.data.value })`, `useState(data)`) together with the `watch` or `useEffect` that re-syncs it.
- An edit counts by key presence, not truthiness, so a field cleared to `''` or `false` stays cleared. Object spread already behaves this way.

```ts
const edits = ref<{ name?: string; note?: string }>({})

const fields = computed(() => {
  const item = itemQuery.data.value
  return { name: item?.name ?? '', note: item?.note ?? '', ...edits.value }
})
```

The input binds `:model-value="fields.name"` and `@update:model-value="edits.name = $event"`. Save sends `{ id, ...edits.value }`, reset sets `edits.value = {}`, and a `:key="itemId"` on the form starts a new record with no edits.

A product that needs a fixed baseline, such as conflict detection against the version the user opened, designs that snapshot on purpose. It is not the default for every form.

---

## 5. The layout holds still

- **First load in the loaded frame.** The pending view uses the loaded view's container, padding, alignment and markers, with honest pending text or skeletons where the content will be. A "Loading…" line at the top left that turns into a centered empty state is a jump, even at zero layout shift. No placeholder data and no enabled actions before the data arrives.
- **Progress on the trigger.** A mutation shows its progress on the button that started it: the repo's button loading state, disabled against double submits, `aria-busy="true"`, and a label that says what is happening ("Save" becomes "Saving…"). Dimming alone does not read as progress. The button keeps its size (reserve the width of the longer label) so its neighbors stay put. The status lives on the button, so the form gets no extra "Saving…" row.
- **The request and the resource settle separately.** A restart can be accepted while the resource still reports "restarting". That status shows in the resource's own status spot, from its query or subscription, and the button returns to idle when the request settles.
- **Errors in a slot.** In a region the user works in (a form, an editor, a chat), an error goes into a slot the region already has, like a header status area or the space beside the action, and long messages wrap instead of clipping. One compact slot beats a large blank strip reserved for an error that rarely happens.

---

## 6. Prove a transition

A screenshot of the settled state cannot show a jump that happened on the way. Layout shift metrics also ignore shifts within 500 ms of user input, which is exactly when a clicked button moves. Prove the transition with the repo's browser tooling:

1. **Hold the request.** Route the endpoint and wait on a promise the test resolves, set up before the navigation or click. No sleeps and no throttled network. Data rendered on the server never passes through a browser route, so give it a test backend.
2. **Measure before.** Take the bounding boxes of the trigger and of the text inside the region: the text element itself, not a full-width wrapper that hides movement inside it.
3. **Act and measure again.** Assert the pending state is visible (`aria-busy`, the label), then compare boxes within 1px. Where the text changes, as in pending to content, compare the edge its alignment uses: left and top for left-aligned text, the center for centered text.
4. **Release and settle.** Assert the settled state. Repeat for failure, retry, and a refresh that fails while data is shown, at a desktop and a narrow viewport, with a long error message.
5. **Look.** Screenshot the pending and settled states. The boxes catch what moved, the screenshot catches what looks wrong.

```ts
test('saving keeps the button in place', async ({ page }) => {
  let release = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.route('**/rpc/items/update', async (route) => {
    await held
    await route.continue()
  })

  await page.goto('/items/1')
  const save = page.getByTestId('item-save')
  const before = await save.boundingBox()

  await save.click()
  await expect(save).toHaveAttribute('aria-busy', 'true')
  const during = await save.boundingBox()
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    expect(Math.abs(during![key] - before![key])).toBeLessThanOrEqual(1)
  }
  await expect(page).toHaveScreenshot('item-save-pending.png')

  release()
  await expect(save).not.toHaveAttribute('aria-busy', 'true')
})
```

The route pattern is whatever path the repo's RPC link calls. Use `route.fulfill` with a fixture when there is no test backend.

Before trusting a new check, make it go red once: append a status row under the button or swap the pending view for a centered one, watch the test fail, then revert. Screenshot baselines are reviewed with the diff, never updated in CI to make a failure pass.
