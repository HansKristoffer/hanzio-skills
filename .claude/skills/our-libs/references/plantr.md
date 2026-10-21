# plantr

Written against plantr@1.0.1 (2026-02-09, today is 2026-10-21). Repo: HansKristoffer/plantr. Re-read its readme.md and AGENTS.md when it releases.

A Bun-only database seeder runner. You define seeders with typed `dependsOn`; plantr sorts them topologically, runs them with `faker`, `step` and `expect` in the context, prints progress and a results table, and exits with a status code. It does not know your database: you inject the client (Prisma, oRPC `call`, helpers) through the context factory. It has no fixtures, factories or truncation.

## Install
```sh
bun add plantr
```
No peers. `@faker-js/faker@^9` is a dependency and re-exported. Runtime: Bun >=1.0 only. The package imports `bun:test` for `expect`, and its `bun` export condition points at raw `index.ts`.

## Exports
| Subpath | Gives |
| --- | --- |
| `plantr` | `createSeederInstance` (main entry), `isSeedingActive`, `faker`, `expect` (from `bun:test`), `CircularDependencyError`, `MissingDependencyError`, `resolveDependencyOrder`, lower-level `createDefineSeeder`, `runSeedersCore`, `createStepRunner`, `colorize`, `formatDuration`; types `BaseSeederContext`, `SeederAny`, `Seeder`, `SeederConfig`, `SeederResult`, `SeederStatus`, `RunSeedersOptions`, `DepsFromSeeders`, `SeederCache`, `StepFn`, `StepOptions`, `SeederInstance`, `SeederInstanceConfig` |

`createSeederInstance(config)` returns `{ defineSeeder, runSeeders, runSeedersCli, isSeedingActive }`.

## Setup
One instance module (gey-mono and hellu: `apps/backend/src/utils/define-seeder.ts`):
```ts
import { createSeederInstance } from 'plantr'
import { prisma } from '../lib/prisma'

export const seederInstance = createSeederInstance({
	context: (base) => ({ ...base, prisma }), // base = { faker, step, expect }
	cache: {
		// optional, enables step(..., { useCache: true })
		get: async <T>(key: string) =>
			(await prisma.seedCache.findUnique({ where: { key } }))?.output as T | undefined,
		set: async <T>(key: string, value: T) => {
			await prisma.seedCache.upsert({
				where: { key },
				create: { key, output: (value ?? {}) as object },
				update: { output: (value ?? {}) as object }
			})
		}
	},
	onBeforeAll: async () => {},
	onAfterAll: async () => {} // runs after success or failure
})
export const { defineSeeder, isSeedingActive } = seederInstance
```
One seeder per feature (`features/<feature>/seed/<feature>Seeder.ts`):
```ts
export default defineSeeder({
	name: 'postSeeder',
	description: 'Creates posts for users',
	dependsOn: [userSeeder],
	run: async ({ prisma, faker, step, expect }, deps) => {
		const { userId } = deps.userSeeder // typed from userSeeder's return
		const post = await step('Create post', () =>
			prisma.post.create({ data: { title: faker.lorem.sentence(), authorId: userId } })
		)
		expect(post.id).toBeDefined()
		return { postId: post.id }
	}
})
```
A registry entry file (`apps/backend/src/registries/seed.ts`):
```ts
export const seeders = [userSeeder, postSeeder] as const satisfies SeederAny[]
if (import.meta.main) seederInstance.runSeedersCli(seeders) // runSeedersCli(seeders, { name })
```
`runSeeders(seeders, { printResults, verbose, continueOnFailure })` returns `{ results, success }` without exiting, for tests and scripts. `continueOnFailure` skips dependents of a failed seeder and runs the rest.

## CLI
No `bin`. The entry file you write is the CLI through `runSeedersCli`: `bun run src/registries/seed.ts`, plus `--help` / `-h` and `--dry-run` (prints the execution order and exits). Package script in hellu: `"run:seeder": "bun run apps/backend/src/registries/seed.ts"`. hellu's buncargo `dev.config.ts` runs it as `seed: { command: 'bun run run:seeder' }`, and gey-mono seeds through `bunx buncargo run seed`.

## Replaces local code like
- Already adopted in `gey-mono apps/backend/src/utils/define-seeder.ts` + `registries/seed.ts` and `hellu apps/backend/src/utils/define-seeder.ts` + `registries/seed.ts` / `registries/e2e-seed.ts`. Copy their layout; gey-mono's `.agents/skills/create-seeder/SKILL.md` describes the conventions (seeders call oRPC routes through `createCall` from the context so business logic runs).
- Hand-rolled seed scripts: `budget-app packages/prisma/seed.ts` (a `--profile` parser in `resolveSeedProfile`), `seed/*Seed.ts` profile files of 800 to 2200 lines, and `seed/seedProgress.ts` (a manual `SeedPhase` union for progress reporting). With plantr each phase becomes a seeder or a `step`, and each profile its own seeder array and entry file.
- Grep for: `prisma/seed.ts`, `"prisma": { "seed"`, `seed:` package scripts, `@faker-js/faker` imports in scripts, manual "seed order" comments or numbered phase lists, `console.log('Seeding ...')` progress, and `process.env.SEEDING` style flags used to suppress side effects (use `isSeedingActive()`).

## Pitfalls
- Bun only. It will not run under Node or `tsx`; `expect` comes from `bun:test`.
- `runSeeders` does not throw on a circular or missing dependency: it logs, calls `onAfterAll` and returns `{ results: [], success: false }`. The README's `try/catch` for `CircularDependencyError` only applies to `resolveDependencyOrder` called directly.
- `runSeedersCli` always ends with `process.exit` (0 or 1). Put nothing after it.
- There is no flag to run one seeder. Pass a smaller array, or write a second entry file (hellu `e2e-seed.ts`).
- The step cache key is `<seederName>:<slug(description)>`. Renaming a seeder or step misses the cache; two steps with the same description in one seeder share an entry. `useCache` without a configured `cache` only warns.
- The context factory runs once per `runSeeders` call, not per seeder.
- Every seeder a `run` reads from `deps` must be listed in `dependsOn`, or the type and the order are wrong.
- `isSeedingActive()` is module state set during `runSeeders`. Guard app side effects with it (gey-mono skips HubSpot sync and outbound messages in `features/order/providers/action/orderConfirm.ts`).
- Use the re-exported `faker` or the context one; a second `@faker-js/faker` install can differ in version.
- Guard against seeding a remote database in the entry file. gey-mono refuses a non-localhost `DATABASE_URL` unless `SEED_ALLOW_REMOTE=1`.
