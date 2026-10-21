# @hanskristoffer/taurio

Written against @hanskristoffer/taurio@0.1.0 and the Rust crate taurio 0.1.0 (2026-10-01, today is 2026-10-21). Repo: HansKristoffer/taurio. Re-read its README and CHANGELOG when it releases.

The shared kit for Tauri 2 desktop apps built with HeroUI v3 (Agentgate, Wallflower). It covers what HeroUI cannot: the updater lifecycle, native confirm dialogs, following the system dark mode, the frosted vibrancy app shell, a macOS theme for HeroUI, and the native setup in a Rust crate. It is a thin layer over `@tauri-apps/plugin-updater`, `plugin-dialog`, `plugin-process` and `window-vibrancy`. It ships no controls (use HeroUI) and no app config: product names, updater endpoints, public keys, CSP, capabilities and entitlements stay in each app.

## Install
```sh
bun add @hanskristoffer/taurio @tauri-apps/api @tauri-apps/plugin-dialog @tauri-apps/plugin-process @tauri-apps/plugin-updater
bun add react @heroui/react @heroui/styles tailwindcss @tailwindcss/vite   # the HeroUI app around it
```
Peers: `@tauri-apps/api@^2`, `@tauri-apps/plugin-dialog@^2`, `@tauri-apps/plugin-process@^2`, `@tauri-apps/plugin-updater@^2` (required); `react@^19` (optional, only for `/react`); `@heroui/styles@^3.2.0` (optional, only for the CSS theme). Types are checked against TypeScript 5.9, 6.0 and 7.0.

Rust, in `src-tauri/Cargo.toml`:
```toml
taurio = { version = "0.1", features = ["window", "plugins"] }
```
No default features. `window` adds macOS vibrancy (no-op elsewhere); `plugins` registers dialog and opener, plus window-state, updater and process on desktop only. Rust 1.88+.

## Exports
| Subpath | Gives |
| --- | --- |
| `@hanskristoffer/taurio/runtime` | `checkForUpdate()` (`Update \| null`, `update.install()` downloads, installs, relaunches), `watchForUpdates(found, { interval, onError })` (returns stop), `UPDATE_INTERVAL` (4 h), `confirmDialog(message, { title, okLabel, cancelLabel, destructive })`, `followSystemTheme(root?)` (returns stop), `messageOf(e)`; types `Update`, `WatchOptions` |
| `@hanskristoffer/taurio/react` | `useAppUpdate({ enabled, onError })` -> `{ enabled, update, installing, status, check, install, dismiss }`, `useAppVersion()`, `AppShell({ sidebar, titlebar, overlay, collapsed, className, children })`, `useAppShortcuts({ ',': openSettings })`, `useSecretEntry({ load, save, verify, onSaved })`; types `AppUpdate`, `CheckStatus` (`idle` / `checking` / `latest` / `failed`) |
| `@hanskristoffer/taurio/styles.css` | `theme.css` + `shell.css` |
| `@hanskristoffer/taurio/theme.css` | HeroUI variables set to the shared macOS palette, light and dark |
| `@hanskristoffer/taurio/shell.css` | transparent window, shell layout, `--tau-*` tokens, `html.tau-no-vibrancy` |

Crate `taurio`: `apply_window_appearance(&window) -> Result<(), WindowError>` (feature `window`), trait `BuilderExt` with `.shared_plugins()` (feature `plugins`).

## Setup
CSS entry, in this order:
```css
@import "tailwindcss";
@import "@heroui/styles";
@import "@hanskristoffer/taurio/styles.css"; /* after HeroUI */
```
Before the first render (avoids a light flash):
```ts
import { followSystemTheme } from '@hanskristoffer/taurio/runtime'
followSystemTheme() // keeps the `dark` class on <html> in step with macOS
```
Update offer with a HeroUI toast (from the README):
```tsx
const updater = useAppUpdate({ enabled: !IS_IOS })
useEffect(() => {
	if (!updater.update) return
	const id = toast(`App ${updater.update.version} is ready.`, {
		timeout: 0,
		onClose: updater.dismiss,
		actionProps: {
			children: 'Restart to install',
			onPress: () => void updater.install().catch((e) => toast.danger(messageOf(e)))
		}
	})
	return () => toast.close(id)
}, [updater.update, updater.install, updater.dismiss])
```
Rust (`src-tauri/src/lib.rs`):
```rust
use tauri::Manager;
use taurio::BuilderExt;

tauri::Builder::default()
    .shared_plugins()
    .setup(|app| {
        if let Some(window) = app.get_webview_window("main") {
            if let Err(e) = taurio::apply_window_appearance(&window) {
                eprintln!("{e}");
            }
        }
        Ok(())
    })
```
Shell sizes are `--tau-*` variables on `:root` (`--tau-sidebar-width`, `--tau-sidebar-shrink`, `--tau-sidebar-min-width`, `--tau-card-min-width`, `--tau-titlebar-left`, ...). Agentgate's values are the defaults.

## CLI
None.

## Replaces local code like
- `agentgate apps/desktop/src/api.ts` `checkForUpdate()` wrapping `check()` from `@tauri-apps/plugin-updater` and `relaunch()` from `@tauri-apps/plugin-process` (removed in commit `a243d58`) -> `checkForUpdate` / `useAppUpdate`.
- `agentgate apps/desktop/src-tauri/src/lib.rs`: five `.plugin(tauri_plugin_*::init())` lines -> `.shared_plugins()`; `#[cfg(target_os = "macos")]` `set_background_color(Color(0, 0, 0, 0))` + `window_vibrancy::apply_vibrancy(... UnderWindowBackground ...)` -> `taurio::apply_window_appearance`; a direct `window-vibrancy` dependency.
- hellu, gey-mono and budget-app have no Tauri app, so nothing to replace there. In another Tauri app grep for: `@tauri-apps/plugin-updater` `check(`, `downloadAndInstall`, `relaunch`, `setInterval` update polling, `ask(` from `plugin-dialog` or `window.confirm`, `matchMedia('(prefers-color-scheme: dark)')` toggling a `dark` class, `data-tauri-drag-region` sidebar/titlebar markup, hand-written Cmd/Ctrl `keydown` handlers, and an API-key field with saved/change/verify state.

## Pitfalls
- Keep the plugin crates (`tauri-plugin-dialog`, `-opener`, `-window-state`, `-updater`, `-process`) as direct dependencies of the app even with `plugins`: tauri-build reads capability permissions from direct dependencies only.
- `window` needs tauri's `macos-private-api` feature and `macOSPrivateApi` in `tauri.conf.json`, kept in the app. Off macOS, add `html.tau-no-vibrancy` so the window paints a background.
- `confirmDialog` needs the `dialog:allow-ask` capability. Outside Tauri it falls back to `window.confirm`.
- The updater has no mobile plugin: pass `useAppUpdate({ enabled: false })` on iOS and Android; `plugins` already skips the desktop-only crates there. The endpoint and public key live in `tauri.conf.json`.
- `useAppVersion()` returns `""` until known and outside Tauri.
- Import `styles.css` after `@heroui/styles`, or HeroUI overrides the theme.
- Pin HeroUI to an exact version in apps: it ships monthly minors, and 3.2.5 renamed `Text` to `Typography` in a patch.
- The npm package and the crate release together at the same version; bump both when upgrading.
- Pre-1.0: `feat:` bumps the minor, so 0.x minors may break.
