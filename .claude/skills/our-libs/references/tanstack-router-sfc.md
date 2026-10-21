# tanstack-router-sfc

Written against tanstack-router-sfc@1.1.0 (2026-10-20, today is 2026-10-21). Repo: HansKristoffer/tanstack-router-vue-sfc. Re-read its README and CHANGELOG when it releases.

TanStack Router for Vue where one `.vue` file is the whole route: the route definition lives in a `<router lang="ts">` block next to the component that renders it. The Vite plugin composes the official `tanstackRouter` plugin from `@tanstack/router-plugin` (generation, watching, code splitting and HMR stay upstream) and a Volar plugin typechecks the block in place. `/app` is a runtime kit for Vue apps on TanStack Router with Nuxt UI (URL search state, URL-driven dialogs, route loading, maintenance mode, forms); it ships no components. It is not a router of its own and not a vue-router replacement.

## Install
```sh
bun add tanstack-router-sfc @tanstack/vue-router @tanstack/router-plugin vue
bun add -d vite @vitejs/plugin-vue
bun add vue-router zod   # only for the /app kit pieces that need them
```
Peers: `@tanstack/router-plugin >=1.140.0`, `@tanstack/vue-router >=1.140.0`, `vite >=6.3.0`, `vue ^3.3.0`; optional `vue-router ^4.5.0` (only `vueRouterShimOptions` types) and `zod ^4.0.0` (only `formStateFromSchema` types). The kit imports neither at runtime. No dependencies. `engines.node >=20`.

## Exports
| Subpath | Gives |
| --- | --- |
| `tanstack-router-sfc` | `tanstackRouterSfc(options?)` (also the default export) returning a Vite plugin array; `ROUTER_MODULE_SUFFIX` (`'.tsr-router.ts'`); type `TanstackRouterSfcOptions` |
| `tanstack-router-sfc/app` | URL/router: `vueRouterShimOptions`, `useQueryParam`, `useRouteSearchModels`, `useRouteSearchSync`, `useRouterPush`, `searchFlag`, `defineStaticData`, type `AppPath`. Loading: `routeLoadingMode`, `trackRouteLoading`. Dialogs: `createDialogs` (-> `useOpenDialog`, `useConfirmAction`, `useDialogDeepLink`), `useDialogHost`, `formatDialogParam`, `parseDialogParam`. Maintenance: `createMaintenanceMode`, `parseApiError`. Forms: `formStateFromSchema`, `assignFormState`, `isFormStateEqual`, `getAtPath`, `setAtPath`, `useEntityForm`, `useFormSubmit`, `useSettingsFormSection`, `createSaveScope`, `provideSaveScope`, `useSaveScopeController`, `useOptionalSaveScopeController`, `useSaveSection`, `useFormFieldModel`, `useResolvedFormId`, `useFieldHighlight`, `formStateKey`, `formIdKey`, `formFeedbackKey` |
| `tanstack-router-sfc/volar` | CommonJS `@vue/language-core` plugin for `vueCompilerOptions.plugins` (option `blockType`) |

`TanstackRouterSfcOptions` = every `tanstackRouter` option (`routesDirectory`, `generatedRouteTree`, `autoCodeSplitting`, `codeSplittingOptions`, `plugins`, ...) except `target` and `addExtensions`, plus `blockType` (default `'router'`).

## Setup
```ts
// vite.config.ts
import { tanstackRouterSfc } from 'tanstack-router-sfc'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
	plugins: [...tanstackRouterSfc(), vue()] // replaces tanstackRouter({ target: 'vue' })
})
```
```jsonc
// tsconfig.json
{ "vueCompilerOptions": { "plugins": ["tanstack-router-sfc/volar"] } }
// custom block name: [{ "name": "tanstack-router-sfc/volar", "blockType": "route" }]
```
A route file:
```vue
<template>
	<article>{{ post.title }}</article>
</template>

<script setup lang="ts">
// `Route` is in scope here - no import.
const post = Route.useLoaderData()
</script>

<router lang="ts">
import { createFileRoute, notFound } from '@tanstack/vue-router'
import { getPost } from '@/lib/posts'

export default createFileRoute('/posts/$postId')({
	loader: async ({ params }) => {
		const post = await getPost(params.postId)
		if (!post) throw notFound()
		return post
	}
})
</router>
```

App kit wiring (types checked against 1.1.0):
```ts
import { createRouter, createWebHistory } from 'vue-router'
import {
	createDialogs, createMaintenanceMode, formFeedbackKey, trackRouteLoading, vueRouterShimOptions
} from 'tanstack-router-sfc/app'

// Nuxt UI needs a vue-router; navigation stays TanStack's
app.use(createRouter(vueRouterShimOptions(createWebHistory()))) // createMemoryHistory() when embedded

// toasts and i18n are the app's, provided once
app.provide(formFeedbackKey, () => {
	const toast = useToast()
	const { t } = useI18n()
	return {
		success: (title) => toast.add({ color: 'success', title }),
		error: (error, title) => toast.add({ color: 'error', title: title ?? t('saveFailed') })
	}
})

// dialogs opened by name, mirrored into ?openDialog=name::{json}
export const { useOpenDialog, useConfirmAction, useDialogDeepLink } = createDialogs({
	dialogs, // [{ name, component, hostProps?, data: {} as Props, result: {} as Result }] as const
	host: DialogSlideoverHost, // app shell; uses useDialogHost(props, emit)
	useOverlay, // Nuxt UI
	confirm: 'confirmAction'
})

export const maintenance = createMaintenanceMode({ probe: () => fetch('/api/health') })
const { state: routeLoading } = trackRouteLoading(router) // 'full' | 'child' | null
```
Search params: `const { searchModel, textModel } = useRouteSearchModels(Route.useSearch(), Route.useNavigate())`; flags in a validator: `create: z.unknown().optional().transform(searchFlag)`. Forms: `useFormSubmit({ initialState: formStateFromSchema(schema), submit, success, onDone })` resolves `true` on success; `useSettingsFormSection` adds entity hydration and dirty tracking; `provideSaveScope({ confirmLeave })` + `useSaveSection` saves several sections together.

## Replaces local code like
- hellu `patches/tanstack-router-sfc@1.0.1.patch` + `"tanstack-router-sfc@1.0.1"` in root `package.json` `patchedDependencies` (the volar scoping fix) → released as 1.0.2; bump to `^1.1.0` and delete both. Still present on hellu main at time of writing.
- hellu `apps/platform/src/lib/vue-router-shim.ts` (`createVueRouterShim(history)` with a `/:pathMatch(.*)*` catch-all) → `createRouter(vueRouterShimOptions(history))`.
- hellu `apps/platform/src/composables/useRouteSearch.ts` (`useQueryParam`, `useRouteSearchModels`, `useRouteSearchSync`, `useRouterPush`) and `lib/route-search.ts` → `/app` equivalents (same names; `useRouterPush` now takes an optional `router`).
- hellu `apps/platform/src/lib/route-static-data.ts` (`appStaticData`, `readAppStaticData`) → `defineStaticData<T>()` with `.define`, `.read`, `.inherited(matches, key)`. App-specific types (`CanvasSurface`) stay local.
- hellu `apps/platform/src/route-loading.ts` (`routeLoadingState`, `routeLoadingHeuristics`) → `trackRouteLoading` + `routeLoadingMode`. `components/ui/feedback/RouteLoadingFullOverlay.vue` stays (shell).
- hellu `apps/platform/src/composables/useDialog.ts` (`DialogDefinition`, `useOpenDialog`) → `createDialogs`; `components/ui/dialog/DialogSlideoverHost.vue` keeps its markup and uses `useDialogHost` for the logic.
- hellu `apps/platform/src/composables/useMaintenanceMode.ts` → `createMaintenanceMode` + `parseApiError`.
- hellu `apps/platform/src/composables/{formStateFromSchema,useEntityForm,useFormFieldModel,useFormSubmit}.ts` and `composables/form/{useFieldHighlight,useSaveScope,useSettingsFormSection}.ts` → the `/app` form exports.
- Any Vue + TanStack Router app with `x.ts` + `x.component.vue` route pairs, or `tanstackRouter({ target: 'vue' })` in `vite.config.ts` → single-file routes (both conventions work side by side during migration).
- Grep: `createVueRouterShim`, `nuxt-shim`, `openDialog`, `useRouteSearchModels`, `routeLoadingHeuristics`, `useMaintenanceMode`, `formStateFromSchema`, `patches/tanstack-router-sfc`, `.component.vue`.

## Pitfalls
- The block must be `<router lang="ts">` with exactly one `export default createFileRoute('<literal path>')({...})`. `__root.vue` uses `createRootRoute*`.
- Every non-piece `.vue` under the routes directory must have a block. Prefix helper files with `-` (`routeFileIgnorePrefix`).
- `Route` is in scope in `<script setup>` but not in `<template>`; assign what the template needs to a `const`.
- Editing the `<router>` block triggers a full page reload; template/setup/style edits hot-update as usual.
- Do not pass `target` or `addExtensions`; the plugin owns them (`addExtensions: true` makes the tree import `./routes/x.vue`). Spread the returned array (`...tanstackRouterSfc()`) before `vue()`.
- A renamed file gets its `createFileRoute` path fixed in place by the generator, so expect the plugin to edit route files.
- Without the volar plugin in `tsconfig.json`, `vue-tsc` and the IDE do not see the block or `Route`.
- The vue-router shim is for Nuxt UI only: never use `RouterLink`, `RouterView` or vue-router's `useRoute` in app code.
- `useQueryParam` reads through `useRouterState`; a `computed` over `router.state` does not follow the URL.
- Kit functions that navigate use `useRouter()` from the calling component; outside setup pass `router` explicitly. `trackRouteLoading` state can be kept on `import.meta.hot.data` so HMR does not reset it.
- `createDialogs` `trackInUrl: false` (per open) when a page already encodes the dialog in its own param, or a deep link opens it twice.
- 1.0.2 changed the volar codegen: the block is wrapped in braces, so its declarations no longer leak into `<script setup>` scope; only `Route` and imports are shared.
