# expo-release

Written against expo-release@2.2.1 (2026-10-21, today is 2026-10-21). Repo: HansKristoffer/expo-release. Re-read its README and CHANGELOG when it releases.

Three things in one package. A release CLI and GitHub Action that compare the current EAS fingerprint with existing native builds and then publish an OTA (`eas update`) or queue a native store build (`eas build --auto-submit`). App runtime helpers (`expo-release/runtime`): an OTA "restart" hook, a push-notification service and an error boundary, none of which render UI. Composite GitHub actions for Bun monorepos (workspace setup, Playwright cache, PR preview environments, AI changelog). It shells out to `eas` and `expo`; it is not an EAS replacement and does not deploy anything by being installed.

## Install
```sh
bun add -D expo-release                                  # CLI only
bun add expo-release expo-updates expo-notifications expo-device   # app runtime (not -D)
```
Dependencies: `hanzio` ^3.1.0 (its `/cli` builds the bin), `zod` ^4.3.6.
Optional peers (only `expo-release/runtime` needs them): `expo-updates` >=55, `expo-notifications` >=55, `expo-device` >=55, `react` >=19.
Runtime: the CLI and the action need Bun (`engines.bun >=1.0.0`, CI verifies 1.4.2), `eas-cli` on `PATH` (override with `EAS_BIN`), an authenticated Expo account (`EXPO_TOKEN`). `EXPO_BIN` overrides `bunx expo` for the source-map export.

## Exports
| Subpath | Gives |
| --- | --- |
| `expo-release` | `decideRelease(input, runner?)` → `ReleaseDecision` (`deployType: 'none' \| 'ota' \| 'native'`, `nativeBuildPending`, `changedFiles`, `fingerprint`, `build`), `operateRelease(input, runner?)` → `'skipped' \| 'ota' \| 'native-build' \| 'recovery'`, `DEFAULT_IMPACT_PATHS` (`['apps/expo/']`); types `ReleaseOptions`, `DecisionInput`, `OperationInput`, `EASBuild`, `Operation`, `DeployType`, `ReleasePlatform`, `CommandName` |
| `expo-release/runtime` | `useOTAUpdates(onUpdateReady, { enabled?, onError? })`, `checkForOTAUpdate(onUpdateReady)`, `createPushNotifications(options)`, `usePushNotifications(push, { enabled? })`, `ErrorBoundary` (`fallback`, `onError`); types `ReloadApp`, `PushNotifications`, `PushNotificationsOptions`, `KeyValueStorage`, `NotificationListeners`, `ErrorBoundaryProps`, `ErrorBoundaryFallbackProps` |

GitHub actions (in the repo, not the npm tarball):
| Action | Gives |
| --- | --- |
| `HansKristoffer/expo-release@v2` | decide + operate (the release). Inputs: `command` (`release`/`decide`/`operate`), `profile`, `operation`, `deploy-type`, `base`, `head`, `impact-paths`, `environment`, `channel`, `platform`, `auto-submit`, `working-directory`, `pre-update`, `post-update`, `update-extra-args`, `export-source-maps`, `group`, `runtime-version`, `message`, `dry-run`. Outputs: `deploy_type`, `native_build_pending`, `fingerprint`, `build_id`, `build_url`, `result` |
| `.../.github/actions/setup-workspace@v2` | Bun (from `package.json` `packageManager` by default), optional Node, `bun install --frozen-lockfile` with a cache keyed on `bun.lock`. Inputs `bun-version`, `bun-version-file`, `node-version`, `cache-paths`, `cache-key-files`, `save-cache`; output `cache-hit` |
| `.../.github/actions/playwright-browsers@v2` | Restores or installs Playwright browsers for the installed version. Inputs `working-directory`, `browsers` (default `chromium`), `save-cache` |
| `.../.github/actions/pr-preview@v2` | Railway `pr-<n>` environment + PlanetScale Postgres branch + Cloudflare DNS host; creates on open/sync, deletes on close. Outputs `preview-url`, `environment` |
| `.../.github/actions/ai-changelog@v2` | Changelog of a pushed range written by Claude (`model` default `claude-sonnet-5-5`); outputs `message`, `markdown`; optional `webhook-url`/`webhook-token`/`webhook-payload` POST |

There are no reusable `workflow_call` workflows; these are composite actions.

## Setup

Expo app prerequisites: `runtimeVersion: { policy: 'fingerprint' }`, `expo-updates`, a `channel` on each deployed `eas.json` build profile, `submit.<profile>.ios.ascAppId` / `android.serviceAccountKeyPath` for auto-submit, `EXPO_TOKEN` secret. The first run on a new fingerprint always queues a native build.

Release workflow step (full workflow in the README; caller must checkout with `fetch-depth: 0`, install Bun, run `expo/expo-github-action` with a pinned `eas-version`, and `bun install` first):
```yaml
- uses: HansKristoffer/expo-release@v2
  with:
    command: release
    profile: production
    operation: ${{ github.event.inputs.operation || 'deploy' }}
    environment: production          # required for Expo SDK 55+
    impact-paths: apps/expo/,bun.lock
    working-directory: apps/expo
    group: ${{ github.event.inputs.group }}
    runtime-version: ${{ github.event.inputs.runtime-version }}
  env:
    APP_VARIANT: production          # every key app.config.ts reads
```
PR check: `command: decide`, then gate on `steps.<id>.outputs.deploy_type`. Source maps for PostHog: `export-source-maps: 'true'` plus `post-update: bunx posthog-cli hermes upload --directory dist`.

App runtime:
```tsx
import { ErrorBoundary, useOTAUpdates } from 'expo-release/runtime'

function AppContent() {
  const { toast } = useToast()
  useOTAUpdates((reload) =>
    toast.show({ label: 'Update ready', actionLabel: 'Restart', onActionPress: reload })
  )
  // ...
}

<ErrorBoundary
  fallback={({ error, reset }) => <ErrorScreen message={error.message} onRetry={reset} />}
  onError={(error, info) => posthog.captureException(error, { component_stack: info.componentStack })}
>
  <App />
</ErrorBoundary>
```
```ts
import AsyncStorage from '@react-native-async-storage/async-storage'
import { Platform } from 'react-native'
import { createPushNotifications } from 'expo-release/runtime'

export const push = createPushNotifications({
  storage: AsyncStorage,
  registerDevice: (expoPushToken) =>          // null unregisters
    api.user.registerDevice({ platform: Platform.OS, expoPushToken }),
  confirm: () => askUserFirst(),              // optional soft-ask before the OS dialog
  onUnavailable: (reason) => {},              // 'not-a-device' | 'denied'
  onError: (message, error) => logger.error(message, error)
})
// push.prompt() after sign-in; push.enable()/disable() from settings;
// push.listen({ onReceived, onResponse }) returns an unsubscribe.
// usePushNotifications(push, { enabled }) → { permission, isEnabled, isLoading, prompt, enable, disable, refresh }
```
Other `createPushNotifications` options: `projectId`, `androidChannel`, `foregroundBehavior`, `storageKey`. Members: `getPermissionStatus`, `hasPrompted`, `requestPermissions`, `getPushToken`, `syncToken`.

## CLI
Bin `expo-release`. Commands: `release` (decide then operate), `decide` (prints JSON with `deployType`, `nativeBuildPending`), `operate`, `completion <bash|zsh>`. All flags are global and each also reads `EXPO_RELEASE_<FLAG>` (empty counts as unset):
- `--profile`, `--base`, `--head` (fall back to `GITHUB_EVENT_BEFORE` / `GITHUB_SHA`), `--platform ios|android` (default `ios`)
- `--impact-paths` (comma-separated, default `apps/expo/`), `--ignore-expo-impact true|false`
- `--operation deploy|force-native|retry-ota|republish|rollback-embedded`, `--deploy-type none|ota|native` (operate)
- `--channel` (default: profile), `--environment`, `--auto-submit true|false` (default true)
- `--pre-update`, `--post-update`, `--update-extra-args`, `--export-source-maps true|false` (OTA path only)
- `--group` (republish), `--runtime-version` (rollback-embedded), `--message`, `--fingerprint`, `--dry-run`

With `GITHUB_OUTPUT` set, decide writes `deploy_type`, `native_build_pending`, `changed`, `fingerprint`, `build_id`, `build_url`; operate writes `result`.
```sh
expo-release decide --base HEAD^ --head HEAD --profile production
```

## Replaces local code like
- `hellu apps/expo/src/app/_layout.tsx` inline `useOTAUpdates()` (~lines 66-107), same in `gey-mono apps/expo/src/app/_layout.tsx` → `useOTAUpdates`. Symptom: `Updates.checkForUpdateAsync()` + `fetchUpdateAsync()` + `reloadAsync()` in a `useEffect`.
- `hellu apps/expo/src/utils/notification-service.ts` (250 lines, `class NotificationService`) and `utils/notifications.ts` (`useNotifications`, 188 lines); `gey-mono apps/expo/src/utils/notifications.ts` → `createPushNotifications` + `usePushNotifications`. Symptoms: `Notifications.getExpoPushTokenAsync`, `setNotificationChannelAsync`, `setNotificationHandler`, `Device.isDevice`, an AsyncStorage "has prompted" flag.
- `hellu apps/expo/src/components/ui/ErrorBoundary.tsx`, `gey-mono apps/expo/src/components/ui/ErrorBoundary.tsx` → `ErrorBoundary` (keep the app's screen as `fallback`, PostHog capture in `onError`). Symptom: `class ... extends React.Component` with `componentDidCatch`.
- `hellu .github/actions/setup-workspace/action.yml` → `setup-workspace@v2`. `hellu .github/workflows/cache-warm.yml` → the README's cache-warm recipe.
- `hellu .github/workflows/pr-db-create.yml` + `pr-db-destroy.yml` + `.github/scripts/{railway-preview-branch,cloudflare-preview-dns}.sh` → `pr-preview@v2`. Symptoms: `planetscale/setup-pscale-action`, `pscale branch create`, `railway environment` in shell.
- `gey-mono .github/workflows/changelog.yml` (curl to `api.anthropic.com/v1/messages`, Slack post) → `ai-changelog@v2`.
- Hand-written EAS release jobs: `eas fingerprint:generate`, `eas build:list` parsing, `eas update --branch` in workflow `run:` steps → the `@v2` action. hellu and gey-mono `.github/workflows/expo-release.yml` already use it.
- Not a candidate: `budget-app apps/expo-app/components/updates/ForegroundUpdateChecker` deliberately avoids `checkForUpdateAsync` (tests assert it); keep it.

## Pitfalls
- `expo-release/runtime` is one bundled file that imports `expo-updates`, `expo-notifications`, `expo-device` and `react` at the top. Install all of them even if you only use `ErrorBoundary`, or Metro fails to resolve the import.
- Install as a regular dependency for the runtime; `-D` only for the CLI.
- Expo SDK 55+ OTA needs `environment` / `--environment`; operate refuses without it.
- Set variant env (`APP_VARIANT`, `SECRETS_ENV`, ...) on the action step or job, never only on decide: every EAS command (`fingerprint:generate`, `build:list`, `build`, `update`) must resolve the same project from `app.config.ts`.
- Default `impact-paths` is `apps/expo/`; add `bun.lock` and shared packages, or dependency bumps never trigger a fingerprint check.
- A manual `workflow_dispatch` `deploy` ignores the impact diff by design. `force-native`, `republish`, `rollback-embedded` skip decide.
- Newest matching build errored → decide fails; fix it, then `operation: force-native`.
- Each profile and platform needs its own finished native build before OTAs work. Put the profile in the concurrency group so profiles do not serialize.
- `pre-update`/`post-update`/`update-extra-args`/`export-source-maps` run only on the OTA path; a non-zero hook exit fails operate.
- `--dry-run` still runs `git diff`, `fingerprint:generate` and `build:list`; only mutating commands are printed.
- `useOTAUpdates` is off in development and where expo-updates is disabled (Expo Go). `ErrorBoundary` render errors never reach autocapture; report them in `onError`.
- `push.enable()`: save the user's preference before calling it, so a later grant in device settings registers on the next mount.
- `pr-preview` needs Cloudflare DNS (Railway domains unsupported), a PlanetScale **Postgres** DB with a scoped service token, Cloudflare SSL mode Full. Fork PRs cannot read its secrets; guard the job.
- The action installs its own `hanzio`/`zod` in `github.action_path`; it does not use the caller's `node_modules`.
