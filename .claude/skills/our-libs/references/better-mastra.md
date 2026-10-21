# better-mastra

Written against better-mastra@0.1.1 (2026-10-21, today is 2026-10-21). Repo: HansKristoffer/better-mastra. Re-read its README and CHANGELOG when it releases.

A small layer on Mastra 1.x and AI SDK 7 for an app with a chat assistant: a model registry with one id format, storage and memory presets, usage metering, a chat turn with fixed refusal codes, a Hono chat route, agent tool definitions, opt-in resumable streams, chat clients for React (and React Native) and Vue, Soniox dictation, and an eval harness. It is not an agent framework: agents, memory, storage and streaming stay Mastra's and the AI SDK's; this ships presets and the glue every app rewrote. The README says "Work in progress" and only documents `/resumable`; the `.d.ts` files carry the real docs (JSDoc on every export).

## Install
```sh
bun add better-mastra @mastra/core @mastra/memory @mastra/ai-sdk ai @ai-sdk/provider zod
```
Required peers: `@mastra/core ^1.76.0`, `@mastra/memory ^1.37.0`, `@mastra/ai-sdk ^1.11.1`, `ai ^7.0.143`, `@ai-sdk/provider ^4.0.0` (LanguageModelV4), `zod ^4.4.3`.
Optional peers, by subpath:
- root (storage): `@mastra/pg ^1.31.0` + `pg ^8.16.0` for `pgStorage`; `@mastra/libsql ^1.26.0` for `libsqlStorage`.
- `/models` routes: `@ai-sdk/google-vertex ^5` (vertex-eu), `@openrouter/ai-sdk-provider ^3.1` (openrouter), `@ai-sdk/openai ^4` (openai-direct), `@ai-sdk/anthropic ^4` (anthropic-direct), `@ai-sdk/openai-compatible ^3` (requesty, inception). A route loads its SDK only when its key is set.
- `/hono`: `hono ^4.12.32`; `mountStudio` also needs `@mastra/hono ^1.7.18`.
- `/evals`: `@mastra/evals ^1.10.7`.
- `/react`, `/dictation/react`: `react >=18`; `/react/markdown`: `react-native` + `react-native-markdown-display ^7`.
- `/vue`, `/dictation/vue`: `vue >=3.3`.
Dependency: `hanzio ^3.1.0` (the CLIs are built on `hanzio/cli`). ESM only. `engines.node >=20`; works on Bun.

## Exports
| Subpath | Gives |
| --- | --- |
| `better-mastra` | The runtime presets (there is no `/runtime` subpath; the root re-exports `src/runtime`): `pgStorage`, `libsqlStorage` (return `{ store, init, ping, close }`), `createMemory` (thread-scoped memory, optional observational memory with no retries), `listExtractor`, `OBSERVATION_MESSAGE_TOKENS` (15000), `checkHealth`, `shutdown` (memory, then Mastra, then storage). |
| `/models` | `createLlmRegistry({ keys, routes?, pricing?, openRouterRouting?, defaultRoute?, logger? })` returning `parseModelId`, `resolveLlm`, `resolveMastraLlm`, `resolveBatchLlm`, `cost`. `BUILT_IN_ROUTES`: `vertex-eu`, `openrouter`, `openai-direct`, `anthropic-direct`, `requesty`, `inception`. Also `capOutputTokens`, `reportedCost`, `splitModelEffort`, `ESTIMATED_MODEL_PRICING`, `estimateModelCostUsd`, prompt cache (`promptCacheMiddleware`, `withPromptCache`, `markConversationForCache`, `perTurnSystemMessage`, `movePerTurnContext`), OpenRouter helpers (`defaultOpenRouterRouting`, `openRouterPrivacyRouting`, `openRouterReasoningOptions`, `extractOpenRouterCostUsd`, `openRouterAnthropicCompatMiddleware`, `thoughtSignatureRecovery`, `dropTrailingAssistantPrefill`), batching (`withModelBatching`, `withLlmMode`, `BatchUnanswered`), `anthropicSafeZodSchema`, `AiBillingError`/`toAiBillingError`. |
| `/usage` | `withUsage({ llms, sink, budget?, onBillingError? })` returning metered `generateText`, `generateObject`, `meterStream`; `createModelBudget` / `localConcurrencyLimit` (per-provider admission, retries, metrics); `readStreamTextUsage`; `readUsageBreakdown`, `averageCostPerGroup`, `medianCostPerGroup`. |
| `/embeddings` | `createEmbedder({ model, cache?, usage?, dimensions?, batchSize?, concurrency? })` with `embedQuery` / `embedMany` / `prewarm`; `BoundedPromiseCache`; `queryEmbeddingCacheKey`. |
| `/turn` | `runChatTurn(request, deps)` (scope, gate, thread lock, usage limit, prepare, pending changes, stream, sinks; returns `{ kind: 'stream' }` or `{ kind: 'refused' }`); `createChatAgent` (Mastra `Agent` that reads the per-turn `ChatTurnPlan`), `asAgentModel`; `defineRequestContext`, `defineRequestContextHolder`; `toChatStreamResponse` (SSE + heartbeat, `SSE_HEARTBEAT_MS` 15000); processors `ToolCallBudgetStop`, `RetryBeforeAnswerText`, `TurnSignals`; `createThreadHandlers`, `deleteThreadEverywhere`, `sweepOldThreads`, `sweepAbandonedRuns`; reply suggestions; `defineModelArms` / `threadBucket`; `promptVersion`; `measurePromptBudget`; `chatErrorCodes`. |
| `/hono` | `createChatRoute({ path, auth, parseBody, runTurn, resumable?, ownsThread?, heartbeatMs? })` (a `Hono` app: `POST {path}`, and with `resumable` also `GET {path}/:threadId/stream` and `POST {path}/:threadId/stop`); `mountStudio(app, { mastra, prepareRequestContext, path?, studioPort?, enabled? })` (dev-only, localhost-only Mastra Studio API). |
| `/tools` | `defineTool({ tool, tier, card?, invalidates?, hiddenInputs?, maxArrayItems?, toModelOutput?, manifest? })`, `toToolSet` (tools + tiers for a turn plan), `toToolName` (`.` to `_`), `buildToolManifest`, `renderToolManifestSource`, `buildClientActionTools`, `deferredTool` / `deferredToolSearch` (Anthropic defer_loading), `toolInputSchema`, `withHiddenInputs`, `coerceDateStrings`, `toJsonProjection`, dry run (`markDryRun`, `isDryRun`, `dryRunResult`). |
| `/resumable` | `createResumableStreams({ redis, graceMs?, maxBufferBytes?, locatorTtlMs?, spillFlushMs?, idleTimeoutMs?, drainTimeoutMs?, replicaId?, keyPrefix?, logger? })` with `start` / `reconnect` / `stop` / `close`; Redis adapters `bunRedis`, `ioRedis`; `ResumableRedis` interface for others. |
| `/client` | Framework-free chat: `createChatSession({ threadId, transport: { api, fetch? }, resume?, clientActions?, onToolResult?, ... })`, `createChatSessions`, `createChatFetch({ headers?, retry?, onUnauthorized? })`, `createCardRegistry`, `defineClientAction`, `createScreenContextStack`, `toMessageBlocks`, `rebuildPendingApprovals`, `createOptimisticRatings`, word reveal helpers, `classifyChatError`. |
| `/react` | `useChatSession`, `useScreenContext` (takes expo-router's `useFocusEffect`), `useWordReveal`, `ToolParts`. No DOM use; works in React Native. |
| `/react/markdown` | `StreamingMarkdown` (react-native-markdown-display), `withAlpha`. |
| `/vue` | `useChatSession`, `useScreenContext`, `useWordReveal`, `ToolParts`. |
| `/dictation` | `startDictation({ locale, requestKey, microphone, socket?, lifecycle?, onTranscript?, onEnd? })`, microphones `mediaRecorderMicrophone`, `audioApiMicrophone`; `webSocketFactory`, `appStateLifecycle`; Soniox protocol helpers. |
| `/dictation/react`, `/dictation/vue` | `useDictation(options)` (phases `idle`/`starting`/`listening`/`finishing`, `onDictated`); React also `useDictationText`. |
| `/dictation/server` | `issueSonioxTemporaryKey({ apiKey, region?, model?, onUsage?, ... })`, `sonioxEndpoints`, `SonioxKeyError`, `SONIOX_DEFAULT_MODEL` (`stt-rt-v5`). |
| `/evals` | `defineEvalConfig`, `defineEvalCase`, `runEvalCase`, `runEvalSuite`, `selectCases`, `checkTrace`, `defineJudge`, `compareReports`, `formatReport`, Mastra dataset sync (`syncDataset`, `findOrCreateDataset`, `threadTurnsToDatasetItems`), live scoring (`createChecksScorer`, `shouldScore`), `withEvalDryRun`. |

## Setup
Runtime and models (root + `/models`):
```ts
import { createMemory, pgStorage, shutdown } from 'better-mastra'
import { createLlmRegistry } from 'better-mastra/models'

const storage = await pgStorage({ connectionString: process.env.DATABASE_URL!, schema: 'mastra' })
await storage.init() // once, in the process that migrates; the preset never creates tables itself
const llms = await createLlmRegistry({ keys: { openrouter: process.env.OPENROUTER_API_KEY } })
const chat = llms.resolveMastraLlm('anthropic-direct/claude-sonnet-5-5@medium') // route/model@effort
const memory = createMemory({ storage: storage.store, observer: llms.resolveLlm('google/gemini-3.8-flash').model })
// on SIGTERM:
await shutdown({ mastra, memory, storage })
```
Chat route (`/hono` + `/turn` + `/resumable`), as budget-app wires it:
```ts
import { createChatRoute } from 'better-mastra/hono'
import { createResumableStreams, ioRedis } from 'better-mastra/resumable'
import { runChatTurn } from 'better-mastra/turn'

const resumable = createResumableStreams({ redis: ioRedis(redis) })
app.route('/', createChatRoute({
	path: '/chat',
	auth: async (c) => getSession(c.req.raw.headers), // null -> 401
	parseBody: (json) => parseChatBody(json),         // undefined -> 400
	runTurn: (request) => runChatTurn(request, { mastra, agentId: 'assistant', memory, resolveScope, deriveThreadKey, prepare }),
	resumable,
	ownsThread: (threadId, auth) => threadBelongsTo(threadId, auth)
}))
```
`prepare` returns `{ requestContext, plan }`, where `plan` is a `ChatTurnPlan` (`instructions`, `model`, `tools`, `clientTools`, `toolTiers`, `maxSteps`, ...). Register the agent with `createChatAgent({ id: 'assistant', memory, stopAfterTools })`.

Resumable streams without the route (README):
```ts
const abort = new AbortController() // do not tie the run to request.signal
const stream = await resumable.start({ threadKey: threadId, stream: uiMessageStream, abort })
const resumed = await resumable.reconnect(threadId, request.signal) // null -> 204
await resumable.stop(threadId) // works from any replica
await resumable.close()        // shutdown: waits for active turns
```
Tools:
```ts
import { defineTool, toToolSet } from 'better-mastra/tools'
const tools = [defineTool({ tool: createTool({ id: 'budget_get', ... }), tier: 'read' }),
	defineTool({ tool: writeTool, tier: 'approval', invalidates: ['budget'], card: 'budgetChange' })]
const { tools: toolMap, toolTiers } = toToolSet(tools) // into the turn plan
```
Client (React or React Native):
```ts
import { createChatFetch, createChatSession } from 'better-mastra/client'
import { useChatSession } from 'better-mastra/react'
const session = createChatSession({ threadId, transport: { api: `${API}/chat`, fetch: createChatFetch({ onUnauthorized: signOut }) }, resume: true })
const { messages, send, stop } = useChatSession(session)
```
Dictation key endpoint: `issueSonioxTemporaryKey({ apiKey: env.SONIOX_API_KEY, region: 'eu' })`; the client passes it as `requestKey` to `useDictation`.

## CLI
- `better-mastra-tool-manifest <module> <out> [export]`: imports `module`, reads the export (default `tools`, an array of `defineTool` results) and writes a manifest module the client imports without server code. Run it after changing tools, e.g. as a `generate` script.
- `better-mastra-evals [run]` (default command): loads `evals.config.ts` (default export from `defineEvalConfig`). Flags: `--config` (default `evals.config.ts`), `--suite` (default `smoke`), `--case <prefix>` (repeatable), `--tag`, `--repeats` (3), `--concurrency` (3), `--model <id>` (repeatable; several print a model comparison), `--no-judge` (judging is on by default), `--compare <baseline.json>`, `--verbose`. Reports go to `outputDir` (default `.evals`, gitignored). Exits 1 when any run fails.
- `better-mastra-evals inspect <report> [--case <prefix>]`: failed checks and transcripts.
- `better-mastra-evals compare <baseline> <candidate>`.
Run evals with Bun (`bunx --bun better-mastra-evals`) or Node 22.18+ so the TypeScript config loads.

## Relation to orpc-fn
`orpc-fn/mastra` `createMastraTool(procedure, { requireApproval?, id?, ... })` turns an oRPC `fn()` procedure into a Mastra `Tool`. Pass that tool to `defineTool({ tool, tier })` to add tier, card, invalidation, hidden inputs and the client manifest; `defineTool` sets `requireApproval` itself for tier `approval`. The packages do not depend on each other. orpc-fn peers on `@mastra/core ^1.51.0`, better-mastra on `^1.76.0`; install the higher one.

## Replaces local code like
- hellu `apps/backend/src/lib/ai/*` (except `models.ts`, `decision/`): `llm-routes.ts`, `llm-providers.ts`, `anthropic-direct.ts`, `openai-direct.ts`, `openrouter*.ts`, `requesty.ts`, `inception.ts`, `vertex-eu-gemini.ts`, `vertex-thinking-options.ts`, `model-effort.ts`, `llm-mode.ts`, `anthropic-safe-schema.ts`, `billing-error.ts`, `estimated-model-pricing.ts` → `/models`; `generate.ts`, `import-model-budget.ts` → `/usage`; `openai-embedding.ts` → `/embeddings`. Symptom: `createOpenRouter`, `createGoogleVertex` with an `eu` base URL fix, hand-written price tables.
- hellu `apps/backend/src/lib/mastra/*` (`init-mastra-storage.ts` DDL retry, `utils/mastra-postgres-storage.ts`, `create-agent-memory.ts`, `resolve-mastra-model.ts`, `type-bridge.ts`), `apps/whatsapp-bot/src/mastra/*` → root presets + `resolveMastraLlm`. Symptom: `new PostgresStore(` with `disableInit`, a retry on `23505` during table creation.
- hellu `apps/backend/src/lib/http/sse-keepalive.ts` → `toChatStreamResponse` / `createChatRoute`. Symptom: `setInterval` writing `: keepalive` comments into an SSE stream.
- hellu `features/platform-buddy/` (`run-platform-buddy-chat-turn.ts`, `use-platform-buddy-chat-route.ts`, `platform-buddy-agent.ts`, `persist-thread-title.ts`, `model-arm.ts`, `api/*` thread list/get/delete/rate, `queues/sweep-old-buddy-threads.ts`, `tools/client-actions/*`, `evals/*`) → `/turn`, `/hono`, `/tools`, `/evals`. `features/organization-usage/ai/*`, `usage-from-stream-text.ts` → `/usage`.
- budget-app (branch `t3/assistant-better-mastra`, worktree `~/.t3/worktrees/budget-app/t3-assistant-better-mastra`, adopting 0.1.0) deleted about 10,000 lines: `packages/modules/assistant/agent/{promptCache,turnProcessors}.ts`, `analytics/usage.ts`, `client/{turnStore,requestMessages,pendingChanges,replySuggestions}.ts`, `contracts/turnRequest.ts`, `tools/toolInputSchema.ts`, `turn/{appTurnStream,turnChanges,turnListener,turnRequestBody,turnTally}.ts`, `voice/sonioxKeys.ts`; `apps/expo-app/lib/{assistantTransport,dictation,sonioxStream}.ts`, `apps/expo-app/components/assistant/messages/{AssistantMarkdown.tsx,streamingMarkdown.ts}`, `components/assistant/screenActions.ts`; and shrank `turn/runAssistantTurn.ts`, `agent/assistantAgent.ts`, `components/assistant/assistantSession.ts`, `apps/bun-server/src/utils/{assistantChatRoute,assistantStudio}.ts` to thin adapters.
- Any app whose chat run uses `request.signal` as its abort (a dropped connection kills the turn) → `/resumable`.

## Pitfalls
- AI SDK 7 only: models are `LanguageModelV4`. `createChatAgent` refuses model strings and older specs; wrap with `asAgentModel`.
- `pgStorage` / `libsqlStorage` never create tables. Call `init()` once at startup in the migrating process; it retries once on a concurrent-DDL race.
- `createChatRoute` with `resumable` requires `ownsThread`; otherwise any caller could reconnect to or stop another thread. Keep the run off `request.signal` when resumable.
- `/hono` declares its own `ResumableStreams` type ("until /resumable ships it"); the shapes match, so pass the `/resumable` object directly.
- Resumable cross-replica reconnect needs blocking `XREAD`. Upstash has none: budget-app writes its own `ResumableRedis` that polls (200 ms). With TCP Redis use `bunRedis` or `ioRedis`; both open extra connections via `duplicate()`.
- A buffer over `maxBufferBytes` (2 MB) or Redis being down gives 204 on reconnect; the client must then reload the thread from Mastra memory.
- `/react/markdown` is React Native only (react-native-markdown-display). The other React exports are DOM-free.
- Model ids: keep the full `route/model@effort` id in config and metrics; a bare Gemini id routes to Vertex EU, `vendor/model` to OpenRouter unless `defaultRoute` says otherwise.
- `LlmCost.usd` and `UsageRecord.costUsd` are `null` when unknown, never `0`. Sinks' errors are swallowed.
- Tool names differ between packages: better-mastra `toToolName('budget.getBudget')` is `budget_getBudget`; orpc-fn's `toToolName` lowercases and turns other characters into `-`. `defineTool` keeps the tool's own `id`, so a `createMastraTool` tool keeps orpc-fn's naming. Do not mix the two for the same tool.
- 0.1.x is pre-1.0 and changes fast; budget-app pins `0.1.0` exactly. 0.1.1 only moved the CLIs onto `hanzio/cli`.
