# buncargo

Written against buncargo@14.2.0 (2026-10-20, today is 2026-10-21). Repo: HansKristoffer/buncargo. Re-read its readme, `docs/reference.md`, `docs/migration.md` and CHANGELOG when it releases.

A Bun-first local development environment defined in one typed `dev.config.ts`: Docker services (generated Compose with `buncargo.*` labels), app dev servers, a unique port block per project and per worktree, env, Infisical secrets, Prisma migrations, seeds, tunnels and named HTTPS hosts. The same config drives `buncargo check` (the change-in-front-of-you check), `buncargo typecheck`, `buncargo ci` and `buncargo predeploy` (migrate + seed before a host deploy). It generates and drives Docker Compose; it does not replace Compose, Prisma, Vite, Next, Expo, Shopify, Supabase or Firebase CLIs, which stay the tools that run.

## Install
```sh
bun add -d buncargo
```
No peer dependencies. Dependencies: `@xterm/headless`, `fast-glob`, `picocolors`.
Runtime: Bun >= 1.4.2 (`engines.bun`), macOS or Linux (Windows via WSL). Docker Compose for Docker services; Apple container (`--runtime=apple`) optional on supported Macs; app-only configs need no container runtime. `buncargo prisma`/`predeploy` run the project's own `prisma` (`bunx --no-install prisma`). Vite and Next are not dependencies; `buncargo/vite` and `buncargo/next` import nothing from them. Integrations need their CLI in the project (`shopify`, `supabase`, `firebase-tools`, Java for some Firebase emulators).

## Exports
| Subpath | Gives |
| --- | --- |
| `buncargo` | `defineDevConfig`, `service` (`postgres`, `redis`, `clickhouse`, `mailpit`, `typesense`, `custom`), `exists`, `mergeConfigs`, `discoverApps`, `validateConfig`, `assertValidConfig`, `createDevEnvironment`, `loadDevEnv`, `getDevEnv`, `clearDevEnvCache`, `runCli`, `runWorkspaceTypecheck`, `buncargoVite`, `isCI`, `isPortInUse`, `killPortOwner`, `getProcessOnPort`, `isProcessAlive`, `getLocalIp`, `waitForServer`, `findMonorepoRoot`, `getProjectName`, `getWorktreeName`, `isWorktree`, `checkoutProjectNames`, `computeDevIdentity`, container helpers (`ensureServicesRunning`, `waitForService`, `waitForAllServices`, `listBuncargoContainers`, `stopBuncargoContainers`, `resolveContainerRuntime`, `ContainerRuntimeUnavailableError`), tunnels (`startPublicTunnels`, `stopPublicTunnels`, `resolveExposeTargets`), `ensureWatchdog`, `assertDockerRunning`, compose (`buildComposeModel`, `composeToYaml`, `writeGeneratedComposeFile`), plus every config type (`DevConfig`, `AppConfig`, `ServiceConfig`, `CheckConfig`, `CheckGateConfig`, `PredeployConfig`, `TypecheckConfig`, `TaskConfig`, `ProfileConfig`, `BuncargoIntegration`, ...) |
| `buncargo/types` | Types only (same config/environment types) |
| `buncargo/config` | `defineDevConfig`, `exists`, `mergeConfigs`, `discoverApps`, `validateConfig`, `assertValidConfig` |
| `buncargo/environment` | `createDevEnvironment` |
| `buncargo/loader` | `loadDevEnv`, `getDevEnv`, `clearDevEnvCache`, `findConfigFile`, `findCheckoutRoot`, `CONFIG_FILES` |
| `buncargo/cli` | `runCli`, type `CliOptions` |
| `buncargo/typecheck` | `runWorkspaceTypecheck`, `selectWorkspaces`, `defaultTypecheckConcurrency`, `typecheckRootConfig`, `readTypecheckTimings`, `writeTypecheckTimings`, `sortWorkspacesByExpectedDuration` |
| `buncargo/core/ports` | `findMonorepoRoot`, `getProjectName`, `getWorktreeName`, `isWorktree`, `checkoutProjectNames`, `computeDevIdentity`, `computeUrls`, `computeLoopbackUrls`, `CI_PROJECT_SUFFIX`, ... |
| `buncargo/core/network` | `getLocalIp`, `isTcpPortOpen`, `waitForServer`, `waitForDevServers` |
| `buncargo/core/process` | `exec`, `execAsync`, `isPortInUse`, `killPortOwner`, `getPortOwner`, `getProcessOnPort`, `isProcessAlive`, `startDevServers`, `stopDevServers`, `stopProcess`, `buildApps`, `signalProcessTree`, ... |
| `buncargo/core/watchdog` | `ensureWatchdog`, `getWatchdogPid`, `getWatchdogLogFile`, `getWatchdogPidFile`, ... |
| `buncargo/core/tunnel` | `startPublicTunnels`, `stopPublicTunnels`, `resolveExposeTargets` |
| `buncargo/core/utils` | `getEnvVar`, `logApiUrl`, `logFrontendPort`, `sleep` |
| `buncargo/container-runtime` | Runtime-neutral container control: `resolveContainerRuntime`, `ensureServicesRunning`, `waitForService`, `sweepOrphanedContainers`, `decideSweep`, `planVolumePrune`, ... |
| `buncargo/docker` | `DockerUnavailableError`, `isDockerDaemonRunning`, `ensureDockerRunning`, `assertDockerRunning`, `dockerRuntimeAdapter`, `startContainers`, `stopContainers`, `runDocker`, ... |
| `buncargo/apple-container` | `appleContainerRuntimeAdapter`, `appleUp`, `appleDown`, `isAppleContainerSupported`, ... |
| `buncargo/docker-compose` | `buildComposeModel`, `composeToYaml`, `writeGeneratedComposeFile`, `getGeneratedComposePath`, `DEFAULT_GENERATED_COMPOSE_FILE` |
| `buncargo/client` | `devCookiePrefix(base, workspaceId?, development?)`: per-worktree cookie names in browsers / React Native (has `browser` and `react-native` conditions) |
| `buncargo/runtime` | `devCookiePrefix(base, env?)`: same for servers, reads the workspace id from env; production and `E2E_TEST=true` keep the base name |
| `buncargo/vite` | `buncargoVite({ app?, host?, proxy? })` Vite plugin: port from `PORT`/`FRONTEND_PORT` with `strictPort`, `127.0.0.1` bind, named-host `allowedHosts`, `/api` proxy to another app |
| `buncargo/next` | `withBuncargo(nextConfig)`, `readBuncargoNextOrigins`, `applyBuncargoNextOrigins`: `allowedDevOrigins` for tailnet/tunnel/named hosts in `next dev` only |
| `buncargo/expo` | `expo({ apps? })` integration (own Metro port per worktree via `RCT_METRO_PORT`, `buncargo expo sim`), `openExpoSimulator`, `isExpoApp`, ... |
| `buncargo/shopify` | `shopify({ config, frontend, backend, store?, extensions?, lease? })` integration, `patchWebDirectories`, `readShopifyAppConfig`, `SHOPIFY_CAPTURES`, ... |
| `buncargo/supabase` | `supabase({ publicEnvPrefix?, types?, functions?, exclude?, siteUrlApp?, migrate? })` integration, `supabaseKeys`, `SUPABASE_SERVICES`, ... |
| `buncargo/firebase` | `firebase({ publicEnvPrefix?, emulators?, projectId?, persist?, stopGraceMs? })` integration, `FIREBASE_EMULATORS`, ... |

## Setup
Real-world example: `gey-mono dev.config.ts`. Minimal shape (readme):
```ts
import { defineDevConfig, service } from "buncargo";
import { expo } from "buncargo/expo";

export default defineDevConfig({
  projectPrefix: "myapp",
  secrets: { projectId: "<infisical-project>", organizationId: "<org>" }, // optional
  services: {
    postgres: service.postgres({ database: "mydb" }),
    redis: service.redis(),
  },
  apps: {
    api: {
      port: 3000, cwd: "apps/backend", devCommand: "bun src/index.ts",
      watch: { paths: ["src"], ignore: ["dist/**"] },   // buncargo restarts instead of bun --watch
      healthEndpoint: "/health", requiredServices: ["postgres", "redis"],
    },
    web: {
      port: 5173, cwd: "apps/web", devCommand: "bun run dev", requiredApps: ["api"],
      envVars: (_ports, urls) => ({ VITE_API_URL: urls.api }),
    },
    expoApp: {
      port: 8081, cwd: "apps/expo", devCommand: "bunx expo start",
      interactive: true, needsPublicUrls: true, healthEndpoint: false, expose: true,
      requiredApps: ["api"],
    },
  },
  env: (ports, urls, { publicUrls, localIp }) => ({ BASE_URL: publicUrls.web ?? urls.web }),
  migrations: [{ name: "search", command: "bun scripts/reindex.ts", requiredServices: ["postgres"] }],
  seed: { command: "bun run seed" },
  prisma: { cwd: "packages/prisma", migrations: "schema/migrations" },
  integrations: [expo()],
  tasks: { seed: { command: "bun run seed", description: "Seed this checkout" } },
  profiles: { default: { apps: ["api", "web"] } },
  options: { hosts: true, primaryApp: "web", envFile: { createFrom: ".env.example" } },
  check: {
    gates: [{ name: "i18n", command: "bun run i18n:check", when: ["**/locales/**"] }],
    testExclude: ["**/e2e/**"],
  },
  predeploy: { afterMigrate: async ({ production, exec }) => { if (!production) await exec("bun scripts/backfill.ts"); } },
  typecheck: { groups: { platform: { only: ["platform"], rootConfig: false }, rest: { exclude: ["platform"] } } },
});
```
Other AppConfig keys: `readyWhen` (regex on output), `essential: false`, `exclusive`, `startAfter`, `restartOn`, `captures`, `staticEnv`, `secrets`, `stopGraceMs`, `buildCommand`, `prodCommand`, `extraPorts`. Checks: `checks: [{ name, check: () => exists("path"), fix: "cmd" }]`.

Scripts:
```json
{ "dev": "bunx buncargo dev", "check": "bunx buncargo check", "lint": "bunx buncargo check --all",
  "typecheck": "bunx buncargo typecheck", "prisma": "bunx buncargo prisma" }
```
Pre-commit hook: `bunx buncargo check --staged`. Railway: `preDeployCommand: bunx buncargo predeploy`. Agents: `bunx buncargo setup --agents` adds an `AGENTS.md` block pointing at `bunx buncargo help agents`. Keep `.buncargo/` in `.gitignore`.

Vite / Next / programmatic:
```ts
import { buncargoVite } from "buncargo/vite";
export default defineConfig({ plugins: [buncargoVite({ proxy: { "/api": "api" } }), vue()] });

import { withBuncargo } from "buncargo/next";
export default withBuncargo({ reactStrictMode: true });

import { loadDevEnv } from "buncargo";
import type devConfig from "./dev.config";
const env = await loadDevEnv<typeof devConfig>();
await env.start({ onlyApps: ["api"] }); /* env.ports, env.urls, env.buildAppEnvVars("web") */ await env.stop();
```

CI: `uses: HansKristoffer/buncargo/actions/setup@main` (Bun from `.bun-version`, cached `bun install --frozen-lockfile`), then `bunx buncargo ci --migrate --seed -- bun test` and `bunx buncargo prisma migrate-check`.

## CLI
Bin `buncargo` (run as `bunx buncargo`). Inside a project it hands over to the project's installed version.

| Command | Does / key flags |
| --- | --- |
| `dev` | Start services + apps. `--apps=a,b`, `--profile=<name>`, `--detach` (returns when apps are up; for agents/scripts), `--no-tui`/`--tui`, `--expose[=targets]`, `--up-only`, `--migrate`, `--seed`, `--down [--all]`, `--reset`, `--yes`, `--attach=<app>`, `--no-watch`, `--takeover`, `--keep-containers`, `--watchdog-timeout=N`, `--no-docker-autostart`, `--no-hosts`, `--runtime=docker\|apple\|auto`, `--timing`, `--timing-json`, `-- <args>` to the attached app |
| `check [docs]` | Biome `--write` on changed files, docs check, `typecheck --changed`, gates, tests beside changed files; `--staged` (pre-commit, no writes/tests), `--all` (lint, no tests), `--base=<ref>`. `check docs` = Markdown links + `bun --cwd` misuse only |
| `predeploy` | `prisma migrate deploy` in `prisma.cwd`, then `migrations`, then `seed.command` unless production |
| `typecheck` | Each workspace's `typecheck` script + root `dev.config.ts`; `--changed[=<ref>]`, `--only=`, `--group=`, `--concurrency=N` |
| `ci [--migrate] [--seed] [--services=a,b] -- <cmd>` | Own `<project>-ci` stack, run command, tear down with volumes |
| `prisma <args>` / `prisma migrate-check` | Prisma with this checkout's `DATABASE_URL`; migrate-check diffs migrations vs schema on a shadow DB (exit 2 = drift) |
| `exec [--app=] [--cwd=] [--slot] -- <cmd>` | Run with the checkout env (no app start) |
| `run [<task>] [-- args]` | Tasks from `tasks`; lists them without a name |
| `slot -- <cmd>` | Take a machine-wide check slot, env untouched |
| `env [--get <path>] [--export]`, `env set K=V`, `env unset K` | Ports/URLs/vars as JSON, one value, shell exports, per-checkout overrides |
| `url [<name>]`, `open [<name>]` | List / open app and captured URLs |
| `status [--json]`, `ls`, `runs [--json]` | This project; every env on the machine; active runs |
| `stop [<name>...] [--all]`, `restart <app>`, `send <app> <keys> [--enter]` | Control a running dev |
| `logs [<app>] [-f] [--since=5m] [--errors]`, `wait --app=<name> [--hold]` | Read output; block until healthy |
| `sql [<service>] [-c <q>] [--json] [--create-scratch=<n>] [--drop-scratch=<n>]` | `psql`/`clickhouse-client`/`redis-cli` in this checkout's container |
| `ports [pin <offset> \| release --root <path>]` | Port block and claims |
| `files <status\|save\|pull\|diff\|merge\|export\|import>` | Gitignored per-machine checkout files (`.env.local`) |
| `secrets ls [--app=] [--env=]` | Infisical key names and sources, never values |
| `setup [--agents] [--yes]`, `doctor [--fix]` | Run every failing check's fix; diagnose |
| `generate`, `build [--discovered]` | Render `generatedFiles`; run `buildCommand`s |
| `prune [--dry-run] [--yes]` | Remove volumes whose project is gone |
| `hosts install\|status\|sync\|prune\|uninstall\|daemon` | Named `https://<app>.<project>.localhost` URLs |
| `bar install\|update\|status\|open\|uninstall\|reset` | BuncargoBar macOS menu bar app |
| `connect status` | Private services through frp |
| `expo sim [<app>]`, `shopify login\|link\|env` | Integration commands |
| `help [agents]`, `version` | Help; guide for AI agents |

## Replaces local code like
- `hellu scripts/check.ts` (201 lines; `--staged`/`--all`, Biome on changed files, gates, nearby tests) → `buncargo check` + `check.gates`. hellu `package.json` `"check": "bun scripts/check.ts"`, `"lint": "bun scripts/check.ts --all"`. Local gate scripts (`scripts/check-package-scripts.ts`, `check-schema-imports.ts`) stay and become `check.gates`.
- `hellu scripts/check-docs.ts` (140 lines; regex `bun --cwd \S+ run `, relative Markdown link check) → `buncargo check docs`.
- `hellu scripts/typecheck-ci.ts` (calls `runWorkspaceTypecheck` with a `platform`/`rest` argv switch) → `typecheck.groups` + `buncargo typecheck --group=<name>`.
- `hellu scripts/pre-deploy.ts` (56 lines, `apps/backend/railway.json` `preDeployCommand: bun run scripts/pre-deploy.ts`; `prisma migrate deploy` then seed unless `SECRETS_ENV`/`NODE_ENV` is production) → `buncargo predeploy` + `predeploy` hooks.
- `hellu scripts/ensure-docker.sh` (`sudo setsid dockerd`, poll `docker info`) → `dev` tries to start Docker when it is down (`--no-docker-autostart` to opt out) and `buncargo doctor` diagnoses it. Whether that covers a `sudo dockerd` sandbox like Conductor is unverified.
- Hand-written `docker-compose.yml` with fixed ports, `.env` port juggling per worktree, `services: postgres` blocks plus hand-written `DATABASE_URL` in CI workflows, per-app `infisical run --` wrappers, `bun --watch` dev commands, `concurrently`/`turbo dev` scripts, `wait-on` scripts → `dev.config.ts` + `buncargo dev` / `buncargo ci`.
- Vite configs that hard-code `server.port`, `host: '127.0.0.1'`, `allowedHosts` or an `/api` proxy to `API_URL` → `buncargoVite`. Next configs listing `allowedDevOrigins` → `withBuncargo`.
- Scripts that read ports from `.buncargo/ports.json` or parse `docker ps` → `buncargo env --get`, `status --json`, `loadDevEnv`.
- Already adopted: hellu and gey-mono use `dev`, `typecheck`, `prisma`, `ci`; budget-app pins `buncargo` 14.0.0 (no `check`/`predeploy`).

## Pitfalls
- `check` and `predeploy` are new in 14.2.0; upgrade from 14.0/14.1 to get them.
- `predeploy` uses the deploy's own environment and does not swap in `DATABASE_URL_DIRECT` (hellu's `pre-deploy.ts` did). Point Prisma's direct URL at it in the schema / `prisma.config.ts`, or set it in `beforeMigrate`. Production = first set of `SECRETS_ENV`, `NODE_ENV` (default `dev`) matching `prod`/`production`; change with `predeploy.environmentVars` / `production`. Migrations hitting "remaining connection slots are reserved" retry 20 x 15 s (`predeploy.retry`).
- `check` runs Biome only when the root has `biome.json`, and `bun install` only when `bun.lock` changed. "Changed" = since the merge base with origin's default branch (`--base` to change). `check --staged` writes nothing; `--all` runs no tests.
- Typecheck discovery keeps only workspaces whose `package.json` has a `typecheck` script; `typecheck.include` entries with neither a script nor `tsconfig.json` fail the run. Typecheck and `slot` share machine-wide slots (`BUNCARGO_CHECK_SLOTS`, default 3); CI takes none.
- 14.0: a run refuses a Compose project name another checkout uses. Self-hosted runners sharing a checkout dir name need a per-runner `projectPrefix` (see gey-mono's `RUNNER_NAME` suffix).
- 13.0: `dev` opens the TUI in a terminal; `interactive: true` owns the real TTY only with `--no-tui`.
- 12.0: Expo needs `integrations: [expo()]`; `options.primaryApp` replaced `options.hosts.primaryApp`; stop runs (`dev --down --all` with the old version) before crossing 12.0.
- Without a terminal, `dev --reset` and `dev --down --all` refuse unless `--yes` (CI exempt). `buncargo send` exits 3 when the app has no terminal.
- `loadDevEnv()` loses inference without `loadDevEnv<typeof devConfig>()`. A library `start()` is not `buncargo dev`: no checks, preflight, named hosts or tunnels unless you call them.
- `buncargo ci` passes no Infisical secrets to the command (migrations and seed keep their scopes).
- Infisical default `siteUrl` is `https://eu.infisical.com`; values never appear in logs or `env` output. Your own exported env wins over Infisical; computed env wins over both.
- `buncargo/client` throws on a workspace id that is not 16 hex chars; Expo apps pass `EXPO_PUBLIC_BUNCARGO_WORKSPACE_ID` so Metro inlines it.
