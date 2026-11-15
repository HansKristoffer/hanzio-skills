# React component cleanup

Read this when cleaning up **React or Expo components and hooks**, especially after AI-assisted edits or when a component has grown effects that copy one piece of state into another.

The repo's own UI contract or `AGENTS.md` names its shared components, hooks and state library. Prefer those over anything generic here. Queries, mutations, loading states and forms over fetched data are in [ui-states.md](ui-states.md).

## Table of contents

1. [Core rule: compute it during render](#1-core-rule-compute-it-during-render)
2. [Effects talk to the outside](#2-effects-talk-to-the-outside)
3. [Memoization](#3-memoization)
4. [Components and keys](#4-components-and-keys)
5. [Checklist](#5-checklist)

---

## 1. Core rule: compute it during render

A value that can be worked out from props, state or query data is a `const` in the component body. Kept in state, it renders once with the old value and again with the new one, and it drifts the first time a dependency is missed.

**Remove**

```tsx
const [visibleItems, setVisibleItems] = useState<Item[]>([])

useEffect(() => {
  setVisibleItems(items.filter((item) => item.isActive))
}, [items])
```

**Use**

```tsx
const visibleItems = items.filter((item) => item.isActive)
```

The same goes for an `isValid` or `hasChanges` flag kept in state, a total, a label, and `useState(props.value)` that mirrors a prop: read the prop. A prop that only seeds the state is named for it (`initialValue`). A selection holds the id, as [ui-states.md](ui-states.md#4-store-ids-and-edits-not-copies) shows.

A ref whose value the render reads is state hidden from React: make it state. State the render never reads, such as a timer id, is a ref.

---

## 2. Effects talk to the outside

An effect that stays connects the component to something React does not own: a subscription, a browser or native API, a timer, a third-party widget. It returns a cleanup for whatever it starts, and its dependency array is complete, with no lint disable on `react-hooks/exhaustive-deps`.

| An effect that | Becomes |
| --- | --- |
| sets state from props or other state | a value computed during render (section 1) |
| runs because the user did something (`if (submitted) …` with `[submitted]`) | code in the event handler |
| tells the parent about a change (`onChange(value)` with `[value]`) | a call to `onChange` in the handler that changes `value` |
| resets state when an id prop changes | `key={id}` where the component is rendered |
| sets state so that another effect runs | the whole next state worked out in one handler or reducer |
| fetches and stores the result | the query library ([ui-states.md](ui-states.md#3-the-query-library-owns-the-promise)) |
| subscribes to a store by hand | the store's own hook, or `useSyncExternalStore` |

---

## 3. Memoization

`useMemo`, `useCallback` and `memo` each add a dependency list that has to stay right. One earns its place when something needs the stable identity (an effect dependency, a `memo` child, a row in a long list) or when the computation is slow enough to measure.

In code the diff added, remove the ones around a cheap expression, around a handler passed to a plain element, and around a value only this render uses.

Check whether the repo runs React Compiler (`babel-plugin-react-compiler` in the lockfile, or the framework's `reactCompiler` flag). With it, new code leaves memoization to the compiler and keeps a manual one only to hold a value steady for an effect dependency.

Memoization that was there before the diff stays. React's documentation warns that removing it can change what the compiler produces, and whether it still pays is a question for a measurement.

---

## 4. Components and keys

- **A component defined inside another component** is a new component type on every render, so React remounts it and drops its state and focus. Move it to module scope and pass what it needs as props.
- **A `renderHeader()` function called once** is JSX with a detour. Put the JSX where it is rendered, or make it a component at module scope when a second place uses it.
- **`key` is the record's id.** An array index hands one row's state to another when the list reorders, inserts or deletes. An index is fine for a fixed list that never changes order.
- **`&&` on a number renders the number.** `items.length && <List />` puts a `0` on the page, and in React Native a bare number or string outside `<Text>` throws. Compare first: `items.length > 0 && <List />`.
- **One way to pass a thing.** A component takes the record or its id, not both, and a boolean prop that picks one of two implementations is two components.

---

## 5. Checklist

For each touched component or hook file:

1. For every `useState`, ask whether props, other state or query data already determine it → compute it during render.
2. For every `useEffect`, name the thing outside React it keeps in sync. With none, it is a row of the table in section 2. With one, check its cleanup and its dependency array.
3. For every `useMemo`, `useCallback` and `memo` the diff added, name the consumer that needs the stable identity, or the measurement. With neither, remove it.
4. Move components declared inside components to module scope.
5. Find index keys on lists that change, and `&&` with a number on its left.
6. Put every query, mutation and loading, empty or error state through [ui-states.md](ui-states.md).
