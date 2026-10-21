# hanzio

Written against hanzio@3.1.1 (2026-10-21, today is 2026-10-21). Repo: HansKristoffer/hanzio. Re-read its README and CHANGELOG when it releases.

The shared utility layer for every app and library. The root entry is dependency-free, runtime-neutral helpers (arrays, strings, Result/retry/abort, cache, state machine, `typedSwitch`, dates, URLs, colors, guards, objects, events). Everything that needs Zod, the network, a framework or a specific runtime lives in its own subpath. Each subpath is a thin layer over a native API: `node:util` `parseArgs` (`/cli`), `Bun.RedisClient` (`/redis`), Web Crypto (`/crypto`, `/jwt`), `Intl` (`/format`), `fetch` (`/api-wrapper`), Infisical HTTP API/CLI (`/secrets`). It is not an ORM, a router, an i18n framework or a logger.

## Install
```sh
bun add hanzio
bun add zod   # for /zod, /api-wrapper, /secrets, /cli and the hanzio-i18n bin
```
Peers (all optional, one subpath each):
- `zod` ^4.3.6: `/zod`, `/api-wrapper`, `/secrets`, `/cli`, `hanzio-i18n`.
- `libphonenumber-js` ^1.10.0: `/format/phone`.
- `vue-i18n` >=10: `/i18n/vue`. `i18next` >=23: `/i18n/i18next`. `vite` >=6: `/i18n/vite` (and `/secrets/vite` is used from a Vite config).
- `@intlify/message-compiler` >=10: `hanzio-i18n check` for `runtime: 'vue-i18n'` catalogs.

Runtime: ESM only. `engines` says `bun >=1.0.0`; Bun resolves the `bun` export condition to the TypeScript source, Node and bundlers get `dist`. `/redis` is Bun-only. `/cli` runs in Bun and Node 22.4+. `/api-wrapper/connection-auth` needs `node:crypto`. `/secrets/worker` runs in Workers without Node compat.

## Exports
| Subpath | Gives |
| --- | --- |
| `hanzio` | Arrays (`groupBy`, `keyBy`, `countBy`, `sortBy`, `partition`, `chunkArray`, `compact`, `toArray`, `findArrayDifferenceByKey`), strings (`slugify`, `truncate`, `stableStringify`, `generateId`, `sha256Id`, `safeJsonParse`, `extractNumber`, `matchesSearch`, `toJsonValue`), Result/promises (`tryCatch`, `ok`, `err`, `retry`, `withTimeout`, `pMap`, `createTaskPool`, `anySignal`, `timeoutSignal`, `raceAbort`, `createLatestGuard`, `startTimer`, `timed`), `cacheFunction`, `createCache` (TTL, LRU, dedupe, pluggable `CacheStore`), `createStateMachine`, `typedSwitch`, `typedSwitchGroup`, `assertNever`, dates (`getPeriod`, `addPeriod`, `formatPeriodLabel`), URLs (`buildUrl`, `buildQueryString`, `buildMailto`, `parseRetryAfter`), math, color (`withAlpha`, `contrastText`, `pickFromPalette`), errors (`getErrorMessage`, `toError`, `must`, `invariant`), guards (`isDefined`, `isOneOf`, `isRecord`, `hasKey`, `nonEmpty`), objects (`pick`, `omit`, `typedKeys`, `typedEntries`, `getAtPath`, `setAtPath`), `debounce`, `keyedDebounce`, `throttle`, `createHeartbeat`, `createEmitter`, types (`MaybePromise`, `ValueOf`, `ElementOf`, `NonEmptyArray`, `Simplify`, `Nullable`) |
| `hanzio/zod` | `createIdHelpers` (`zId`, `asId`, `parseId`), `createZId`, `zJsonValue`, `zJsonObject`, `parseJson`, `E164_REGEX`, `zOptionalE164`, `zSingleOrArray`, `createMinMaxFilter`/`toGteLteFilter`, `zodDefaults`, `zodToTypeString`, `zodToExample`, `jsonToZodSchemaMapper` |
| `hanzio/api-wrapper` | `createApiClient`, `defineEndpoint`, `defineAction`, `paginate`, `otelMiddleware`, error classes and guards (`ApiError`/`isApiError`, `HttpResponseError`/`isHttpResponseError`, `NetworkError`, `RequestTimeoutError`, `Request/ResponseValidationError`), `describeApiError`, `apiErrorLogAttributes` |
| `hanzio/api-wrapper/testing` | `createMockFetch`, `jsonResponse` |
| `hanzio/api-wrapper/connection-auth` | `ConnectionAuthCache`: one shared token exchange per connection across many client instances |
| `hanzio/jwt` | `jwtSign`, `jwtVerify`, `jwtVerifyResult`, `jwtDecode` (HS256/384/512 via Web Crypto) |
| `hanzio/sitemap` | `getDomainSitemap`, `getDomainSitemapEntries`, `parseRobotsTxt`, `isAllowedByRobots` |
| `hanzio/p-queue` | `PQueue` (default and named), `TimeoutError`, `PriorityQueue` |
| `hanzio/cool-console-log` | `createCoolLogger`, `startOperation`, `logOperationSummary`, `colorize`, `logBanner`, `supportsColor` |
| `hanzio/format` | Cached `Intl`: `formatNumber`, `formatCurrency`, `formatPrice`, `formatPercent`, `formatCompactNumber`, `formatBytes`, `formatDuration`, `formatClockDuration`, `formatRelativeTime`, `formatDate`, `formatDateTime`, `formatDateRange`, `formatCompactTime`, `formatDayDivider`, `formatList`, `formatCappedCount`, `pluralize`, `withLocale`, `EM_DASH` |
| `hanzio/format/phone` | `formatPhone(value, country?)` |
| `hanzio/crypto` | `safeEqual`, `hmacSign`, `verifyHmacSignature`, `verifySvixSignature`, `createSealer` (`seal`/`open`, `sealJson`/`openJson`, AES-256-GCM), `randomToken`, `sha256Hex`, base64/hex/utf8 codecs |
| `hanzio/storage` | `createStorageItem`, `createAsyncStorageItem`, `createMemoryStorage` (typed, never throw) |
| `hanzio/i18n` | `interpolate`, `extractPlaceholders`, `createTranslator`, `flattenMessages`, `typedTranslate`, `TypedTranslate`, `DynamicTranslate`, `defineLocales`, `LocaleOf`, `createLocaleSelector` |
| `hanzio/i18n/vue` | `createVueI18n` returns `{ i18n, setLocale, useI18n }` |
| `hanzio/i18n/i18next` | `initI18next` returns `{ ready, locale, setLocale, syncLocale }` |
| `hanzio/i18n/vite` | `localeCatalogReloadPlugin()` |
| `hanzio/i18n/check` | `defineI18nConfig`, `validateCatalogs`, `writeCatalogTypes`, `generateCatalogTypes`, `parseMessages` |
| `hanzio/iso` | `countryNames`/`countryCodes`/`CountryCode`/`isCountryCode`/`countryFlag`, `currencyNames`/`CurrencyCode`, `languageNames`/`LanguageCode`/`matchLanguageCode`, `languageFromE164PhoneNumber` |
| `hanzio/secrets` | `defineSecretSet` (eager), `createSecretSet` (lazy, `load()`/`reload()`), `SecretLoadError`, loaders (`processEnvLoader`, `infisicalLoader`), `getSecretEnvironment` |
| `hanzio/secrets/vite` | `viteSecretSetPlugin`, `getViteDefine`, `readPublicConfig` |
| `hanzio/secrets/worker` | Same set APIs plus `cloudflareWorkerEnvLoader`, no CLI/HTTP adapter, no `process.env` |
| `hanzio/redis` | `createManagedRedis`, `createRedisConcurrencyLimit`, `createLuaScript` |
| `hanzio/http` | `withSseKeepAlive`, `createSseKeepAliveTransform`, `SSE_KEEPALIVE_COMMENT` |
| `hanzio/cli` | `defineCli`, `defineCommand`, `CliError`, types `CommandContext`, `Command`, `CommandNode`, `Cli`, `CliIO` |
| `hanzio/testing` | `ModuleMocker`, `createPrismaMock`, `installWindowShim`, `createTestStorage`, `connectionAuthContract`, `mockCallArg`, `noopLogger` |

## Setup

### `/cli` (library bins and app CLIs)
Each command's `input` is a `z.object`. Keys become `--kebab-case` flags (`dryRun` → `--dry-run`); Zod validates; `run(input, ctx)` gets the typed output.
```ts
// src/cli.ts
import { z } from 'zod'
import { defineCli, defineCommand } from 'hanzio/cli'

export default defineCli({
	name: 'better-mastra-evals',
	version: '1.0.0',
	commands: {
		run: defineCommand({
			description: 'Run eval suites',
			input: z.object({
				suite: z.string().meta({ positional: true }),
				repeats: z.number().default(1).describe('Runs per case'),
				json: z.boolean().optional()
			}),
			run: async (input, ctx) => {}
		}),
		inspect: () => import('./commands/inspect') // loaded only when used
	}
})
```
```ts
#!/usr/bin/env node
import cli from './cli.js'
process.exitCode = await cli.run() // process.exit(await cli.run()) if DB/Redis handles keep the process alive
```
Schema to flag mapping:
| Schema | Command line |
| --- | --- |
| `z.string()`, `z.enum([...])` | `--name value`, `--name=value` |
| `z.number()` | coerced before validation |
| `z.boolean()` | `--x`, `--no-x`; missing is `false` |
| `z.array(z.string())` | repeatable; missing is `[]` |
| `.optional()`, `.default(x)` | may be left out |
| `.describe('…')` | help text |
| `.meta({ positional: true })` | positional in key order; an array takes the rest |
| `.meta({ alias: 'r' })` | `-r` |
| `.meta({ env: 'APP_REGION' })` | env fallback when the flag is missing |
Pipes read their input side (`z.stringbool()` takes `--submit true`). Importing `hanzio/cli` types these keys on Zod's `GlobalMeta` (same keys as trpc-cli plus `env`).

`defineCommand` has three forms: `{ description, input, run, output? }`; `{ description, raw: true, run }` (no parsing, everything in `ctx.argv`); `{ description, load: () => import('./x') }` (lazy with a description in help). A bare `() => import('./x')` whose default export is a command also works. `commands` is one command (single-command CLI) or nested plain objects (`{ check: { docs } }` runs as `tool check docs`).

`defineCli({ name, version?, description?, globals?, context?, guard?, commands })`:
- `globals`: a `z.object` accepted before or after the command names; validated values arrive in `ctx.globals` and in `context(globals)`.
- `context(globals)`: runs after parsing (so `--help` never connects); its return is `ctx.context`. Required by the types once any command needs a context. Type a command in its own file with `run: (input, { context }: CommandContext<AppContext>) => …`.
- `guard({ path, input, globals, context })`: runs before every command; throw `CliError` to refuse.
- `ctx`: `context`, `globals`, `path`, `argv`, `passthrough` (after `--`), `json`, `stdout`, `stderr`, `env`, settable `exitCode`.
- `run`'s return goes to `output(result, ctx)`; default prints strings as-is, other values as indented JSON (compact with `--json`), `undefined` nothing.
- Exit codes: 0 ok, 1 `run` threw or `ctx.exitCode = 1`, 2 usage error. `new CliError(msg, { exitCode })` prints without a stack; with `--json` errors print as `{"error": "…"}`.
- Free: `-h/--help` at every level, `--version` when `version` is set, "Did you mean …?", and `tool completion bash|zsh` (`source <(tool completion zsh)`).
- Tests: `await cli.run(argv, { stdout, stderr, env })` resolves to the exit code and never touches `process`.

App CLI: commands come from orpc-fn procedures (`meta: { cli: true }`) via `procedureCommands` from `orpc-fn/cli`; `defineCli` stays hanzio's. Pattern from hellu `apps/backend/src/entry/lib/cli.ts`:
```ts
import { CliError, defineCli } from 'hanzio/cli'
import { procedureCommands } from 'orpc-fn/cli'

export const cli = defineCli({
	name: 'bun cli',
	globals: z.object({ as: z.string().optional(), org: z.string().optional(), json: z.boolean().default(false) }),
	context: async (options): Promise<AppContext> => resolveCliContext(options),
	commands: procedureCommands<AppContext>(cliRouter, { context: (context, meta) => context })
})
```

### `/redis` (Bun servers)
```ts
import { createManagedRedis, createRedisConcurrencyLimit } from 'hanzio/redis'

export const redis = createManagedRedis({
	url: () => getSecret('REDIS_URL'),
	onError: (error, { role, stage, channel }) => captureException(error, 'redis', { role, stage, channel })
})
await redis.getClient().set('key', 'value')
const unsubscribe = await redis.subscribe('orders', (message, channel) => handle(JSON.parse(message)))
redis.close() // on shutdown

const withOpenAiSlot = createRedisConcurrencyLimit({
	key: 'openai', max: 20, slotTtlMs: 30_000, maxStartsPerSecond: 10,
	send: (command, args) => redis.getClient().send(command, args)
})
await withOpenAiSlot(() => openai.chat(request), signal)
await withOpenAiSlot.tripCooldown(retryAfterMs) // after a 429
```
One command and one subscriber connection, both retry forever; one `SUBSCRIBE` per channel shared by handlers, resubscribed after reconnect. The limiter uses Redis `TIME`, renews held slots, fails open after `failOpenAfterMs` (15s) of Redis outage, and exposes `queueDepth()`, `onWait`, `dispose()`.

### `/http`
```ts
import { withSseKeepAlive } from 'hanzio/http'
return withSseKeepAlive(createUIMessageStreamResponse({ stream })) // 15s `:` comments + no-buffer headers
```

### `/secrets`
```ts
import { defineSecretSet } from 'hanzio/secrets'
export const backendSecrets = await defineSecretSet(['DATABASE_URL', 'APP_SECRET'] as const, {
	organizationId: 'infisical-organization-id',
	projectId: 'infisical-project-id'
})
const databaseUrl = backendSecrets.secret('DATABASE_URL')
```
`auth: 'auto' | 'http' | 'cli'`. HTTP uses `INFISICAL_CLIENT_ID`/`INFISICAL_CLIENT_SECRET` or `~/.infisical/universal-auth.json`; otherwise the signed-in CLI (`infisical login --domain=https://eu.infisical.com`). Environment: `environment` option, then `SECRETS_ENV`, then `NODE_ENV` (`dev`/`staging`/`prod`, custom via `{ slug }`). Use `createSecretSet(...)` + `await secrets.load()` in modules that tooling imports. In `vite.config.ts`: `plugins: [viteSecretSetPlugin(frontendSet)]` (only `VITE_` keys unless `publicKeys`).

### `/i18n`
```ts
import { defineLocales, type LocaleOf } from 'hanzio/i18n'
export const uiLocales = defineLocales({
	locales: { en: { tag: 'en-US', name: 'English' }, da: { tag: 'da-DK', name: 'Dansk' } },
	defaultLocale: 'en',
	aliases: { no: 'nb' }
})
export type UiLocale = LocaleOf<typeof uiLocales>

// Vue
import { createVueI18n } from 'hanzio/i18n/vue'
export const { i18n, setLocale, useI18n } = createVueI18n({ locales: uiLocales, messages: { en, da }, storageKey: 'app.ui-locale' })
export const useAppI18n = () => useI18n<AppTranslationParams>() // map from `hanzio-i18n generate`

// Expo / React: initI18next(i18n.use(initReactI18next), { locales, resources, deviceLocales, storageKey, storage: AsyncStorage })
```
`i18n.config.ts` uses `defineI18nConfig({ baseLocale, locales: uiLocales.locales, catalogs: [{ name, dir, runtime: 'vue-i18n' | 'i18next', generatedTypes?, generatedTypeName?, sourceRoots?, dynamicKeyPrefixes? }], disjointNamespaces?, rules? })`; catalogs are `<dir>/<locale>.json`.

### `/api-wrapper`
```ts
import { createApiClient, isHttpResponseError } from 'hanzio/api-wrapper'
const api = createApiClient({
	baseApiUrls: { default: 'https://api.example.com' },
	endpoints: {
		getUser: { method: 'GET', path: '/users/:id', reqParamsSchema: z.object({ id: z.number() }), resSchema: z.object({ id: z.number(), name: z.string() }) }
	}
})
const { data } = await api.getUser({ reqParams: { id: 1 } }) // or api.safe.getUser(...) for a Result
```
Config also takes `defaultHeaders` (function for auth), `checkResponse` (reject 200-with-error envelopes), middleware, `otelMiddleware`, retries with backoff and `Retry-After`, `redact`. Per-tenant clients share logins through `new ConnectionAuthCache().bind({ connectionId, authInputs, exchange })`; prove the races with `connectionAuthContract` from `/testing`. Full docs ship in `node_modules/hanzio/src/api-wrapper/README.md` and `SKILL.md`.

### `/testing` (`bun:test`)
```ts
import { createPrismaMock, installWindowShim, ModuleMocker } from 'hanzio/testing'
const prismaMock = createPrismaMock<typeof prisma>(mock) // beforeEach(() => prismaMock.$reset())
const moduleMocker = new ModuleMocker()
await moduleMocker.mock(path.resolve(import.meta.dir, '../lib/posthog.ts'), () => ({ captureException: mock() }))
afterAll(() => moduleMocker.clear())
afterEach(installWindowShim()) // in a bunfig preload
```

## CLI
`hanzio-i18n` (bin, built on `hanzio/cli`; needs `zod`):
- `hanzio-i18n check`: validates catalogs; exit 1 on catalog problems, 2 on bad arguments. Reports missing/stale keys, placeholder mismatches, untranslated identical values, code-shaped values, NFC/mojibake, banned words, wrong language, unused keys (`sourceRoots`), stale `generatedTypes`, overlapping `disjointNamespaces`, and vue-i18n `strictMessage` errors.
- `hanzio-i18n generate`: writes each catalog's `generatedTypes` key → placeholder map (plural keys take `count`).
- `hanzio-i18n completion <bash|zsh>`.
- Global: `--config <file>` (default `i18n.config.{ts,mts,js,mjs}` in cwd; paths relative to the config). A `.ts` config needs Bun or type-stripping Node.

## Replaces local code like
- `hellu apps/backend/src/lib/redis/{index,concurrency-limit,lua-script}.ts`, `gey-mono apps/backend/src/lib/redis/index.ts` (ioredis singleton class), `budget-app apps/bun-server/src/utils/redis.ts` → `hanzio/redis`. Symptoms: `import Redis from 'ioredis'`, `new Bun.RedisClient`, hand-rolled `retryStrategy`, a `Map` of channel handlers, `EVALSHA` fallback code.
- `hellu apps/backend/src/lib/http/sse-keepalive.ts` → `withSseKeepAlive`. Symptoms: `setInterval` writing `:\n\n`, `X-Accel-Buffering: no`.
- `hellu apps/backend/src/lib/async/task-pool.ts`, `lib/with-abort.ts` → `createTaskPool`, `raceAbort`/`anySignal`/`timeoutSignal`.
- `hellu apps/backend/src/lib/crypto/secret-json.ts` → `createSealer().sealJson/openJson`. `lib/schema/e164.ts` → `zOptionalE164`. `lib/json/prisma-json` → `toJsonValue`/`zJsonValue`.
- `hellu apps/backend/src/lib/api-client/{connection-auth,response-shape-error}.ts` + `test-utils/connection-auth-contract.ts` → `ConnectionAuthCache`, `checkResponse`, `connectionAuthContract`. Any hand-written `fetch` wrapper with zod parsing and retry loops → `createApiClient`.
- `hellu apps/backend/src/test-utils/{prisma,module-mocker,noop-logger,mock-call-arg}.ts` → `hanzio/testing`. Symptom: `mock.module` stubs leaking across test files.
- `hellu scripts/i18n/{catalog-utils,check-parity,content-rules,generate-types}.ts` → `hanzio-i18n check|generate`. `packages/utils/{i18nTypes.ts,mappings/uiLocale.ts}` → `defineLocales`, `typedTranslate`. `apps/platform/src/plugins/i18n.ts` + `lib/useTypedI18n.ts` → `createVueI18n`. `apps/expo/src/lib/{i18n,app-locale}.ts` → `initI18next`. `apps/platform/vite-plugins/locale-catalog-reload.ts` → `localeCatalogReloadPlugin`.
- `hellu packages/utils/{formatDate,formatCurrency,formatPhone,emDash}.ts` → `hanzio/format`, `hanzio/format/phone`. `packages/utils/mappings/{country,currency,language,phoneLanguage}.ts` → `hanzio/iso`.
- A hand-rolled `parseArgs` bin with a `USAGE` string, `switch (positionals[0])`, `console.error(...); process.exit(2)`, or `trpc-cli` → `hanzio/cli` (migration steps in `node_modules/hanzio/src/cli/README.md`). App scripts that call services directly → orpc-fn procedures + `procedureCommands`.
- A per-app `getSecret`/`.env` loader or `infisical run --` wrapper → `defineSecretSet` (gey-mono `apps/backend/src/registries/secrets.ts` already uses it).
- Local `exhaustive`/`assertNever` switch helpers, `Result` types, `groupBy`/`debounce`/`slugify` copies → root `hanzio`.

## Pitfalls
- 3.0 breaking: `typedSwitch<Constraint>(…)` is removed. It switched off inference, so it checked neither exhaustiveness nor return type. Annotate the result instead: `const result: HasId = typedSwitch(status, { … })`. Case keys that are not values of the union are now type errors (typos used to fall through to the default). gey-mono is still on `hanzio ^2.0.0` and has `typedSwitch<` calls (e.g. `apps/backend/src/features/hubspot/api/salesBoard.ts`); fix them when upgrading.
- 2.0 breaking: subpath modules are not re-exported from `hanzio` (`createApiClient` is from `hanzio/api-wrapper`, etc.); `Result` has an `ok` discriminant; `groupBy`/`countBy` return `Partial<Record>`.
- `/cli`: `--json` is not built in. Declare `json: z.boolean()` in `globals` or the command `input`, else `--json` is "Unknown option" (exit 2). `ctx.json` is true when either declares it.
- `/cli`: orpc-fn, better-mastra and expo-release depend on `hanzio ^3.1.0` and website-to-markdown peers on it. Keep the app's own `hanzio` on the same major so `defineCli` and `procedureCommands` share one copy.
- `/cli`: the built-in `completion` command is only added when the root has no `completion` command of its own. `context` is not called for `--help`.
- `/cli` and `hanzio-i18n` throw at import without `zod` installed.
- `/redis` wraps `Bun.RedisClient`; it does not run on Node. The limiter only needs `send(command, args)`, so it can sit on another client.
- `/secrets`: `organizationId` is required alongside `projectId`, even when env overrides supply every key. Use `writeToProcessEnv: false` when loading several sets in one process. Deploys should use `auth: 'http'`; the CLI flow cannot answer MFA/SSO prompts. Vite helpers reject non-`VITE_` keys unless `publicKeys` lists them.
- `/i18n` placeholders are `{word}` only; ICU and plurals are the framework's job. `runtime: 'vue-i18n'` checks need `@intlify/message-compiler`.
- `/testing`: `ModuleMocker` resolves relative specifiers from hanzio's file. Pass absolute paths or a resolver.
- `cacheFunction` external `store` only works for async functions.
- Root `hanzio` never loads Zod; importing `hanzio/zod` etc. uses the app's Zod instance (peer `^4.3.6`, Zod 3 is not supported).
