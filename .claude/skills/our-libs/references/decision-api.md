# decision-api

Written against decision-api@1.2.0 (2026-10-19, today is 2026-10-21). Repo: HansKristoffer/decision-api. Re-read its README and CHANGELOG when it releases.

One typed client for decision models: models that answer typed questions with calibrated probabilities instead of text. It speaks TypeSafe Jev, Cloudflare Clef and Clef-flash, OpenAI gpt-6-luna and the OpenRouter decision models, and returns one answer shape from all of them. It is a thin `fetch` client with `zod` as its only dependency. It is not a chat or generation client and not a Mastra model: it cannot write prose, extract free text or call tools.

## Install
```sh
bun add decision-api
```
Peers: `typescript >=6.0.0`, optional (the `.d.ts` files import siblings with `.ts` extensions). Runtime: Node >=18, Bun, or any runtime with `fetch`, `AbortSignal.timeout` and `Response`.

## Exports
| Subpath | Gives |
| --- | --- |
| `decision-api` | `createDecisionApi`, `DecisionError`, `DECISION_MODELS` (model -> provider and input price), `DECISION_MAX_STATE_CHARS` (90000); types `DecisionApi`, `DecisionErrorKind`, `DecisionFetch`, `DecisionUsage`, `DecisionModel`, `DecisionProvider`, `DecisionProviderKeys`, `ModelsFor`, `DecisionAnswers`, `DecisionQuestion`, `DecisionNoul`, `DecisionChoice`, `DecisionScore` |

Models (`DecisionModel`): `jev` (key `typesafe`), `clef`, `clef-flash` (key `cloudflare: { apiToken, accountId }`), `gpt-6-luna` (key `openai`), `microsoft/microsoft-decision-1`, `typesafe/jev-1.13` (key `openrouter`).

Question types:
- `noul`: `{ type: 'noul', instructions, criteria?: { true, false } }` answers `{ noul: number }` (the probability).
- `choice`: `{ type: 'choice', instructions, criteria: Record<Option, string> }` answers `{ choice: Option, confidence, probabilities }`.
- `score`: `{ type: 'score', instructions, criteria: string[] }` (two or more levels, lowest first) answers `{ score, confidence, probabilities }`.

## Setup
One configured instance per app, in one module (hellu: `apps/backend/src/lib/ai/decision/index.ts`):
```ts
import { createDecisionApi } from 'decision-api'

const decide = createDecisionApi({
	keys: { typesafe: '…', openrouter: '…' }, // only the providers you use
	defaultModel: 'jev',
	registerUsage: (usage, context: { customerId: string }) => {
		// usage: model, provider, inputTokens, outputTokens, costUsd, latencyMs
	},
	onError: (error, context) => console.warn(error.kind, error.message)
})

const answers = await decide({
	state: { message: 'I was charged twice' },
	questions: {
		refund: { type: 'noul', instructions: 'Does the customer want money back?' },
		team: {
			type: 'choice',
			instructions: 'Which team handles this?',
			criteria: { billing: 'Payments and refunds', other: 'Anything else' }
		}
	},
	customerId: 'c_1' // required because registerUsage types its context
}) // second argument: a model, optional only when defaultModel is set

answers?.refund.noul // number
answers?.team.choice // 'billing' | 'other'
```
Other options: `fetch` (a `DecisionFetch` that replaces the transport, for your own budget or proxy), `defaultSignal: () => AbortSignal | undefined`, `timeoutMs` (default 4000), `maxStateChars` (default 90000). Per call: `signal`, `timeoutMs`.

## CLI
None.

## Replaces local code like
- `hellu apps/backend/src/lib/ai/decision/index.ts` before commit `fcfb79b56` (now the configured instance), and the earlier TypeSafe call sites (`judgeTags`, the email-intake gate, the instruction guard; `git -C hellu log --all -S jev-latest`). Symptom: a hand-written `fetch` to `api.typesafe.ai` or a Workers AI endpoint with its own retry and response parsing.
- `budget-app packages/modules/assistant/sessions/sessionTagger.ts` uses it for closed-list session tags through OpenRouter (`typesafe/jev-1.13`).
- Candidates: an LLM structured-output call whose schema is only a boolean or a `z.enum`, used to route, tag, gate or rank. Example: the `tag: z.enum(SupportCaseTag)` field in `gey-mono apps/backend/src/features/support-case/providers/parseInboundSupportEmailWithAi.ts` (via `apps/backend/src/lib/ai/generateStructuredObject.ts`). Grep for `generateObject(` / `response_format` / `json_schema` with `z.enum` or `z.boolean` schemas, and for classifiers named `classify*`, `judge*`, `detect*`.
- Keep the text fields (title, description) on a generation model; only the decision moves.

## Pitfalls
- A call answers `null` instead of throwing. Every call site needs its own fallback (no tags, refuse, default). `onError` gets the `DecisionError` with `kind`, `model`, `provider` and `status`.
- It throws only when a call has no model and there is no `defaultModel`, which TypeScript already rejects. A call with no questions answers `{}` without a request.
- Error kinds: `timeout`, `aborted`, `unauthorized` (401/403), `out-of-credits` (402), `rate-limited`, `request-failed`, `state-too-large`, `unreadable-response`, `answer-mismatch`, `usage-failed` (a throwing `registerUsage`; the call still answers).
- A key typed `string | undefined` (a raw `process.env` read) does not unlock its models. Narrow it first, or load it from a secret getter that returns `string`.
- 429 and 5xx are retried once, after `Retry-After` when it asks for 2 s or less, otherwise not retried.
- The default timeout is 4 s. Long states need a larger `timeoutMs`.
- State over 90000 characters fails as `state-too-large` before any request. Jev rejects roughly 32.5k input tokens; Clef silently truncates long state. Trim the state yourself (budget-app keeps the newest 60000 chars).
- Put every independent question about the same state in ONE call: extra questions are almost free and latency follows the state size. Clef rejects more than 64 questions (hellu note).
- Thresholds on probabilities are calibrated per model. Changing `defaultModel` moves every gate; hellu re-runs `apps/backend/scripts/probe-decision.ts` first.
- Not for numbers or prose: compare numbers in code.
- `jev` calls TypeSafe directly (`api.typesafe.ai`, model `jev-latest`). Jev through OpenRouter (`typesafe/jev-1.13`, its zero-data-retention routing) needs 1.2.0 or later. OpenRouter calls go to its alpha Decisions API (`/api/alpha/decisions`), which may change; upgrade the package rather than patching.
- New OpenRouter models are added to `DECISION_MODELS` in a release; a slug not in the table cannot be named.
