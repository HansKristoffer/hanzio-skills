---
name: unslop
description: Simplify and refactor working code after a feature or fix, or when a cleanup or type-quality pass is requested, including the prose in the diff (comments, docs, UI copy, commit and PR text). Also use it whenever writing, changing, reviewing or sweeping tests (authoring gate, low-value or implementation-coupled tests, test-only production seams), and to revise any text for clarity, tone or formulaic AI language. Built for TypeScript monorepos (Bun or Node, Prisma, Zod, oRPC, hanzio, Vue or React/Expo); reads the repository's own rules first and lets them win.
---

# Unslop

Apply this **after** a feature or fix is working, on the **files touched** (and closely related helpers), unless the user asks for a wider sweep. When the request is only about text (a doc, a PR description, copy), go straight to [references/prose.md](references/prose.md). When it is about tests (writing them, an audit, a sweep), go straight to [references/tests.md](references/tests.md); a whole-subsystem test campaign also needs [references/test-campaign.md](references/test-campaign.md).

## Learn the repository first

Read the root and nearest `AGENTS.md` / `CLAUDE.md` for every touched area, and any UI or code contract they link. Those rules override this skill: when the repo names its date formatter, its row component, its id type or its design tokens, use those, not the generic advice here. Note the repo's lint, typecheck and test commands, and which shared packages (`packages/utils`, `@/utils`, `@scope/*`) and installed libraries already exist - you need them for the reuse ladder.

## Principles

- **Scope**: Prefer a tight diff. Do not refactor unrelated modules or "clean the world."
- **Behavior**: Preserve observable behavior unless the user asked for a change.
- **Deletion over addition**: The best cleanup removes code. A pass that only adds - helpers, types, comments, guards - is not a cleanup.
- **Boring over clever**: Clever is what someone decodes at 3am. Take the readable equivalent even when it costs a line.
- **Read before you cut**: Be lazy about the diff, never about comprehension. Trace every caller of what you touch before deleting or narrowing it. A small change in the wrong place is a second bug, not a tidier file.
- **Fix at the source**: A cast, shim, or guard repeated at several call sites is one wrong type upstream. Fix the formatter / router output / schema once instead of cleaning each site - that is both the smaller diff and the actual fix.

## The reuse ladder

For each block you are about to keep, rewrite, or extract, stop at the first rung that holds:

1. **Does it need to exist?** No caller today and no requirement asking for it - delete it, note it in one line.
2. **Does the repo already have it?** A util, composable, hook, formatter, schema, registry, mapping, or Prisma enum a few files over. Re-implementing what already lives here is the single most common artifact in an AI diff - grep before you extract.
3. **Does the stdlib or runtime cover it?** `Intl`, `URL`, `structuredClone`, array/object built-ins, Bun or Node APIs.
4. **Does a platform feature cover it?** A DB constraint over app-level checks, a Prisma enum over a string union, CSS over JS, an existing UI-library component over a hand-rolled one.
5. **Does an installed dependency cover it?** Zod, hanzio, TanStack Query, the repo's own workspace packages. Never add a new dependency during a cleanup pass.
6. **Can it be one line?** One line.
7. **Only then** keep the hand-written version.

Two rungs both work: take the earlier one and move on. The ladder shortens the code, never the reading.

### Marking what you deliberately leave

A simplification that cuts a real corner with a known ceiling (a naive heuristic, an O(n²) scan, a global lock) can stay - but leave a `ponytail:` comment naming the ceiling and the upgrade path: `// ponytail: O(n²) over items, index by id if lists grow past a few hundred`. Those markers get harvested as a debt ledger, so the shortcut is tracked instead of forgotten. Do not use the marker to annotate ordinary code.

## Common AI artifacts (remove when they add no value)

Tighten the diff by stripping patterns that often appear after AI-assisted edits but do not match the rest of the file or project:

- **Defensive bloat**: Remove try/catch or null/undefined guards that are atypical for the same layer in this repo, duplicate validation the caller already enforced, or branches that cannot happen on trusted inputs. The test: a guard is bloat when the same layer elsewhere in this repo does not have it, and load-bearing when removing it changes what happens on bad input. See **Never clean away** below.
- **Reinvented helpers**: A formatter, guard, mapping, or fetch wrapper that already exists in a shared package, a sibling feature, or an installed dependency. Delete the local copy and import the existing one - ladder rung 2. Date and relative-time formatting is the usual offender: use the repo's formatter instead of a component-local `Intl.DateTimeFormat` or `toLocaleString()`.
- **Justification comments**: Delete comments that explain why a change is correct, what the next line does, or where code came from ("moved from X", "now uses the shared helper", "safe because validated above"). A comment earns its place only by stating a constraint the code cannot show. The comments that stay get the prose pass below.
- **Assume required config is present**: Do not add `isXConfigured()` helpers, optional-secret fallback chains (`getOptionalSecret('FOO') ?? getOptionalSecret('BAR')`), or soft-disable branches for secrets/env the feature needs. Read it with the repo's required accessor (for example hanzio's `getSecret`) and let missing config fail. Keep the optional accessor for values that are genuinely optional at the product level, such as a third-party provider that disables itself when unset. Never invent a secret "with fallback to another secret" - pick one required key.
- **Types**: Remove `as any`, unnecessary `as` assertions, and `@ts-ignore` / `@ts-expect-error` unless there is a documented, unavoidable reason; fix the underlying type instead. See [references/typescript.md](references/typescript.md) for branded ids, router-derived shapes and Prisma results - **fix at the source**, not with `brandXId()` shims or `as never` at every call site.
- **Exported param/result aliases**: Remove `export type FooInput`, `export interface BarParams`, or `export type BazResult` when nothing outside the file imports them. Put the shape **inline on the function** (`input: { … }`) instead of a separate named type used only once.
- **Redundant return annotations**: Drop explicit `: Promise<SomeResult>` (or exported result types) when `SomeResult` exists only for that function. Prefer **inferred return types**. For discriminated unions callers must narrow, use `as const` on return literals (e.g. `translated: true as const`) instead of a file-local result type.
- **Deprecated shims**: On greenfield / pre-production code, do not leave `@deprecated` thin wrappers or duplicate entry points "for one PR cycle." Migrate callers to the canonical API and delete the wrapper.
- **Style**: Align naming, `const`/`let` usage, import order, and formatting with surrounding code - not a different convention introduced in one block.
- **Noise**: Drop gratuitously long identifiers, redundant intermediate variables, and "just in case" branches with no real scenario. Avoid emoji in identifiers, non-UI strings, or comments unless the file already uses them that way; emoji in user-facing copy is fine when it fits the product tone. Never use the em dash `—` (U+2014) in comments, copy or strings; end the sentence or use a comma, as [references/prose.md](references/prose.md) says.
- **Static query inputs**: Do not hoist static `queryOptions({ input: … })` literals to named constants - inline `{ input: { limit: 20 } }` (or `{}` / `undefined`) at the call site. Keep named inputs only when reactive or shared across non-trivial logic.
- **Thin handler wrappers**: Do not add functions that only forward to `openDialog`, a router navigate, or a single emit - call it inline from the template or JSX. Keep a named function when it chains `.finally()`, confirms, or does other work.
- **Prisma client as a parameter**: Do not thread `prisma` through provider/helper signatures. Import the repo's client at module scope and use it directly. Exceptions: a route handler that receives `prisma` on its context, a `$transaction` callback using its scoped `tx`, and tests using the repo's mock.
- **Loose `Record<string, …>` maps**: Do not type curated static lookup tables as `Record<string, SomeUnion>` (or leave the object untyped). Use `as const satisfies Record<SomeUnion, Value>` so every variant in the union must appear as a key - adding a union member becomes a compile error until the map is updated. When keys are runtime strings (channel names, event names), define a union of the known constants and key on that, not bare `string`.
- **Curated enum lists**: Derive option lists from the repo's enum or curated list (a Prisma enum, a `languageCodes`-style tuple), not `Object.entries(...)` plus a cast.
- **Hardcoded keyword / language / locale lists**: A literal array of words or path fragments used to *classify* input is almost always the wrong shape. See **Keyword and language lists** below.
- **Vue SFCs**: pass-through computeds, duplicated fields and slot casts - see [references/vue.md](references/vue.md).

### Keyword and language lists

A literal array of words, path fragments, or language-specific strings used to **classify** input is almost always the wrong solution. It works for exactly the languages, spellings and conventions someone remembered to type, and everywhere else it degrades **silently**: no error, no failing test, just quietly worse output for every user outside the list. That invisibility is what makes it worth flagging in cleanup rather than at runtime.

The question to ask: *what happens on a site, customer, or locale nobody on the team speaks?* If the answer is "it still runs, just worse", replace it.

Prefer, in order:

1. **Match the shape of the data, not its name.** The thing you are looking for usually has a form that survives translation: an e-mail address, a phone number, a time range, a currency amount, a postal code, a VAT-shaped token, an ISO date. Score or filter on those instead of on what the page or field calls itself.
2. **Use structure you already have.** URL path depth, `<html lang>`, `hreflang`, JSON-LD, HTTP headers, MIME type, DOM or document position, crawl/insertion order, counts and ratios. These are free, deterministic, and language-neutral.
3. **Ask the model.** If a cheap LLM call already runs in this pipeline, a keyword list is doing badly - and untestably - what the model does well. Let the prompt classify and keep the deterministic code for the parts that must be exact.
4. **Derive from a source of truth.** Prisma enums, curated language-code lists, `Intl` / ICU data, a typed registry. Never a hand-written parallel list (see **Loose `Record<string, …>` maps** above).

**When a list is fine.** The test is whether it enumerates a *closed set defined by a spec or by our own product* rather than a guess about the world:

- ISO 639/3166 codes, Prisma enums, currency codes
- file extensions, MIME types, HTTP methods, protocol tokens, reserved slugs
- our own route names, event names, queue names, secret keys, feature flags
- a specific vendor's documented error codes or webhook types

Those are facts with an authority you can point at, and a missing entry is a bug someone can find. Keep them `as const satisfies Record<Union, …>` so the compiler enforces completeness. A list of "words that probably mean contact page" has no such authority and no such check.

**Red flags when reviewing a diff:**

- one array mixing two or more languages (`'opening'` next to `'åbningstider'`)
- a comment along the lines of "add more as we expand" or "covers our main markets"
- `.includes()` / `.some()` over the list against a URL, title, or free text
- an identifier ending in `_HINTS`, `_KEYWORDS`, `_TERMS`, `_PATTERNS` used to classify rather than to parse
- a list that would need a translator - not an engineer - to extend correctly

**Worked example (website import).** Choosing which crawled pages to read a company's business details from started as `CONTACT_PAGE_HINTS = ['contact', 'kontakt', 'about', 'om-os', 'impressum', 'åbningstider', ...]`, matched against URL and title. It was replaced by a score over distinct e-mail addresses, `tel:` links, phone-shaped numbers (eight digits or more, so prices and years do not count), and opening-hours ranges such as `08.00-17.00`, with path depth and crawl order as tie-breaks. Those signals are identical in Danish, Portuguese, Japanese and Polish, so a new country needs no code change - and the ranking became unit-testable across languages instead of only against the ones in the array.

## Checklist (work in order)

1. **Simplify**
   - Remove dead code, unused imports, commented-out blocks, redundant variables, and modules with **zero importers** - but confirm "unused" first: check registries, seeders, route/queue/webhook/job registration, dynamic imports and any string-keyed lookup before deleting.
   - Run the **reuse ladder** over what is left; delete anything the repo, stdlib, platform, or an installed dependency already does.
   - Merge branches that do the same thing; prefer one clear code path.
   - Replace overly clever patterns with readable equivalents.
   - Replace keyword / language / locale lists used for classification with shape-based or structural signals.
   - Apply **Common AI artifacts** above where applicable.
   - **UI code**: move touched call sites onto the repo's design tokens and its one component per concept (row, list states, button, dialog shell), as its UI contract names them. If the repo has a vocabulary gate, a cleanup must never reintroduce what it bans.

2. **Types & contracts** - details in [references/typescript.md](references/typescript.md).
   - **Function parameters**: Inline `input: { … }` on the function. Do not keep a separate `type XInput` unless another file imports it.
   - **Private helpers** that share the public function's input shape: use `Parameters<typeof publicFn>[0]`, not a duplicated type alias.
   - **Return types**: Let TypeScript infer unless another module needs the type (then export it from a single source of truth, such as a schema or the router output). Do not export result types used only as that function's return annotation.
   - Prefer **shared types** from the backend package / Prisma client over duplicated string unions, and **Prisma enums** over string literals where values are persisted or API-owned.
   - **Typed registries**: Keep concrete registration arrays in the repo's registry files so feature wiring stays visible; keep reusable lookup/factory logic in the owning feature module. Derive key/payload types from `as const satisfies ...` registration tuples (`FooKey`, `FooByKey`, `FooPayload<K>`) instead of re-declaring string unions; preserve literal keys in `defineX()` helpers with a `TKey extends string` generic. For dynamic or persisted keys, erase explicitly to `FooAny | undefined` at the validated boundary.
   - **Exhaustive branching**: use `typedSwitch` from `hanzio` when the repo uses it (otherwise a `switch` with a `never` default) for enum / discriminated-union mappings, instead of loose `if` chains, `switch` + `default`, or `Record<string, …>`.
   - Use `import type` for type-only imports.

3. **Duplication (DRY)**
   - If the same mapping, formatter, or guard appears twice, extract a small shared helper in the nearest appropriate place (same file first; a shared util or feature helper if reused across modules).
   - Do not create abstractions for one-off duplication.
   - Consolidate duplicate agent/model invocation paths, context builders, and text-extraction helpers when multiple callers do the same thing.

4. **Optimize (lightweight)**
   - Avoid unnecessary recomputation in hot paths (cheap `computed`/`useMemo` fixes only when obvious).
   - No micro-optimizations unless profiling or clear waste (e.g. duplicate network calls).

5. **Refactor (when it pays off)**
   - Extract functions when a block has a clear name and multiple call sites or heavy nesting.
   - Keep components readable; move business rules out of huge templates or JSX into script, composables or hooks.

6. **Tests**
   - Put every test the diff adds or changes through the authoring gate in [references/tests.md](references/tests.md): it protects observable behavior, a credible regression makes it fail, existing coverage does not already catch it, and it needs no test-only production seam.
   - In touched test files, remove what matches its junk patterns, and delete the test-only exports, wrappers and flags that go with them. Keep anything the retention bar protects.

7. **Prose**
   - Run the comments, docs, user-facing copy and error messages the diff touched through [references/prose.md](references/prose.md). Do the same for the commit message and PR description you write.

8. **Verify**
   - Run the repo's lint/format, typecheck and focused tests on affected packages, plus any package-specific gate the touched area has (design vocabulary, i18n catalogs, browser-export checks) - the repo's `AGENTS.md` lists them.
   - Fix new issues introduced by the pass; do not relax lint rules without an explicit user ask.

## Never clean away

Not everything that looks defensive is bloat. Leave these unless the user explicitly asks:

- Input validation at trust boundaries: request/webhook/query parsing, user-authored content, anything crossing into the database.
- Error handling that prevents data loss or leaves a job, queue, or transaction recoverable.
- Security and tenancy: auth checks, rate limits, tenant scoping on queries.
- Accessibility basics: labels, `aria-*`, focus handling, keyboard paths.
- Code the user explicitly asked for, even when a lazier version exists. Name the alternative once, then leave it.

## Out of scope (unless requested)

- New features, migrations, or large renames.
- Rewriting `AGENTS.md` or adding standalone docs.
- Changing public API contracts without user confirmation.
- Adding a dependency, a test framework, or an abstraction layer.

## Output

Summarize what changed: files and intent, plus anything deliberately left, as `left [X], revisit when [Y]`.

Keep it shorter than the diff. Every paragraph defending a simplification is complexity smuggled back in as prose - if the write-up is longer than what you deleted, cut the write-up. If nothing needed improvement, say so in one sentence.
