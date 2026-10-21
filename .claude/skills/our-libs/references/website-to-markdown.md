# website-to-markdown

Written against website-to-markdown@1.0.1 (2026-10-21, today is 2026-10-21). Repo: HansKristoffer/website-to-markdown. Re-read its README and CHANGELOG when it releases.

Turns public URLs, HTML and uploaded files into markdown through Cloudflare's tiers (content negotiation, Workers AI `toMarkdown`, Browser Rendering), with an SSRF guard, per-host politeness limits, `Retry-After` handling, conditional re-reads (`etag`/`lastModified`/`htmlHash`), crawl snapshots for benchmarks, and robots.txt + sitemap discovery. It is a page reader for crawlers and knowledge imports, not a crawler (link-following and job orchestration stay in the app) and not a sitemap generator. Bun only: it uses `HTMLRewriter`.

## Install
```sh
bun add website-to-markdown hanzio zod
```
Peers: `hanzio ^3.1.0` (required: `hanzio/api-wrapper`, `hanzio/cli`, `parseRetryAfter`, `escapeRegExp`), `zod ^4.0.0` (required at runtime). Dependencies: `cloudflare ^5.2.0`, `fflate`. `engines.bun >=1.2.0`. Needs a Cloudflare API token and account id with Workers AI and Browser Rendering.

## Exports
| Subpath | Gives |
| --- | --- |
| `website-to-markdown` | `createWebsiteToMarkdown(options)` -> `{ fetchPageAsMarkdown, convertDocumentBytes, urlToMarkdown, convertFileWithWorkersAi, renderUrlToMarkdown }`; `createMemoryConcurrencyLimit`; `withOperationSignal`, `currentOperationSignal`, `failCurrentOperation`; `withCrawlSnapshot`, `throughCrawlSnapshot`, `currentCrawlSnapshot`, `CRAWL_SNAPSHOT_NAME_PATTERN`; `isHostAllowed`, `isBlockedAddress`, `isLocalhostHostname`; `markdownRefs`, `htmlLinks`, `htmlImages`, `stripFrontMatter`, `stripDocumentPreamble`, `titleFromMarkdown`, `extractHtmlMetadata`, `decodeHtmlEntities`; `classifyContentType`, `convertibleDocumentType`; `CloudflareRateLimitedError`; constants `MAX_MARKDOWN_CHARS` (300000), `URL_TO_MARKDOWN_PAGE_CONCURRENCY` (80), `BROWSER_USER_AGENT`; types `FetchedPage`, `FetchOutcome`, `FetchSource`, `FetchPageInput`, `PageBody`, `PdfParser`, `WebsiteToMarkdown`, `WebsiteToMarkdownOptions`, `ConcurrencyLimit`, `ConcurrencyLimitOptions`, `CreateConcurrencyLimit`, `CloudflareCredentials`, `ConvertFileInput`, `ContentKind`, `CrawlSnapshotInput`, `Logger`, `LogAttributes` |
| `website-to-markdown/sitemap` | `fetchRobots(websiteUrl)` -> `{ sitemaps, rules }`, `parseRobotsRules`, `robotsAllows(rules, url)`, `discoverSitemapUrls(websiteUrl, robotsSitemaps)` -> `{ url, lastmod }[]`, `parseSitemapXml`, `normalizeSitemapUrl`; type `RobotsRule` |

`createWebsiteToMarkdown` options: `cloudflare: { apiToken, accountId }` (required, read on first use so getters work), `createLimit` (default in-memory), `onApiError(error: hanzio ApiError)` (Workers AI errors other than 429), `logger: { info, warn }` (default silent), `parsePdf` (OCR tier for PDFs Workers AI returns nothing for), `isHostAllowed(hostname)` (default: public addresses only, localhost outside production).

`fetchPageAsMarkdown({ url, etag?, lastModified?, htmlHash?, render?, country?, signal? })` returns `FetchedPage`: `outcome` (`ok | unchanged | gone | blocked | transient | unsupported`), `source`, `status`, `url`, `finalUrl`, `markdown` (empty unless `ok`), `title`, `lang`, `canonical`, `alternates`, `metaDescription`, `jsonLd`, `links`, `images`, `etag`, `lastModified`, `htmlHash`, `durationMs`.

## Setup
One converter per process; it owns the Cloudflare pools and per-host limits.
```ts
import { createWebsiteToMarkdown } from 'website-to-markdown'

export const converter = createWebsiteToMarkdown({
	cloudflare: { apiToken: '…', accountId: '…' }
})

const page = await converter.fetchPageAsMarkdown({ url: 'https://example.com' })
if (page.outcome === 'ok') console.log(page.title, page.markdown, page.links)
```
Several processes sharing the Cloudflare quota: share the limiter through Redis with hanzio (typechecked against hanzio 3.1.1):
```ts
import { createRedisConcurrencyLimit } from 'hanzio/redis'
import { createWebsiteToMarkdown, type CreateConcurrencyLimit } from 'website-to-markdown'

const createLimit: CreateConcurrencyLimit = ({ key, max, slotTtlMs, maxStartsPerSecond }) =>
	createRedisConcurrencyLimit({ key, max, slotTtlMs, maxStartsPerSecond, send: (command, args) => redis.getClient().send(command, args) })

export const converter = createWebsiteToMarkdown({ cloudflare, createLimit, onApiError, logger })
```
Discovery:
```ts
import { discoverSitemapUrls, fetchRobots, robotsAllows } from 'website-to-markdown/sitemap'

const robots = await fetchRobots('https://example.com')
const pages = await discoverSitemapUrls('https://example.com', robots.sitemaps)
const readable = pages.filter((page) => robotsAllows(robots.rules, page.url))
```
Cancellation: pass `signal`, or wrap a job in `withOperationSignal(signal, run)` so every read inside inherits it. Uploads: `converter.convertDocumentBytes({ bytes, filename, mimeType, extension, signal })` returns a `PageBody`. Benchmarks: `withCrawlSnapshot({ mode: 'record' | 'replay', name: 'label/host' }, run, { root })` records and replays every page and sitemap read.

## CLI
```sh
CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… bunx website-to-markdown <url> [--no-render]
```
One command (built on `hanzio/cli`). Markdown goes to stdout, a JSON metadata summary (outcome, status, source, urls, title, counts, durationMs) to stderr. Exits 1 when `outcome !== 'ok'` or the env vars are missing. `--[no-]render` toggles the Browser Rendering tier (default on). Without a URL (even with `--help`) it prints help and exits 1.

## Replaces local code like
- hellu `apps/backend/src/lib/url-to-markdown/*` (`index.ts` with module-level `fetchPageAsMarkdown`, `convertDocumentBytes`, `urlToMarkdown`; `client.ts`, `limit.ts`, `net-guard.ts`, `rate-limit-retry.ts`, `retry-after.ts`, `crawl-snapshot.ts`, `html-metadata.ts`, `markdown-refs.ts`, `content-type.ts`, `xlsx-zeros.ts`, `to-markdown.ts`, `cli.ts`) → `createWebsiteToMarkdown(...)` once, then call its methods. hellu's `limit.ts` Redis wiring (`createRedisConcurrencyLimit`) becomes the `createLimit` option.
- hellu `apps/backend/src/lib/sitemap/index.ts` (`fetchRobots`, `parseRobotsRules`, `robotsAllows`, `discoverSitemapUrls`, `normalizeSitemapUrl`, `parseSitemapXml`) → `website-to-markdown/sitemap`, same names.
- hellu `apps/backend/src/lib/operation-signal.ts` (`withOperationSignal`, `currentOperationSignal`, `failCurrentOperation`) → root export. `lib/fetch-request-init.ts` and `lib/hash.ts` (`sha256Hex`) are internal to the package now; delete them only if nothing else imports them.
- Callers to repoint: hellu `features/company-overview-scrape/**` (`website-import/crawl-site.ts`, `page-evidence.ts`, `prepare-pages.ts`, `image-evidence.ts`, `api/run.ts`, `providers/enqueue-*.ts`). Still local on hellu main at time of writing.
- Any app calling Cloudflare `ai.toMarkdown` / Browser Rendering `/markdown` directly, Turndown/Readability HTML-to-markdown pipelines, a hand-rolled robots.txt or `<loc>` regex parser, or a private-IP check before fetching user-supplied URLs.
- Grep: `lib/url-to-markdown`, `lib/sitemap`, `toMarkdown`, `browser-rendering`, `HTMLRewriter`, `robots.txt`, `sitemap.xml`, `isBlockedAddress`, `withOperationSignal`.

## Pitfalls
- Bun only (`HTMLRewriter`); it will not run on Node.
- `fetchPageAsMarkdown` never throws: branch on `outcome`. `urlToMarkdown` is the one-shot form that throws.
- Create the converter once per process. One per request duplicates pools and per-host limiters and defeats the politeness caps.
- The default limiter is in-memory: several processes or pods each get the full Cloudflare quota. Pass a shared `createLimit` (hanzio `createRedisConcurrencyLimit`) in multi-process deployments.
- `markdown` is capped at `MAX_MARKDOWN_CHARS` (300000) and front matter is stripped.
- Store `etag`, `lastModified` and `htmlHash` from each read and pass them back to get `unchanged` without converting again.
- `withCrawlSnapshot` throws when `NODE_ENV === 'production'`, and the name must match `CRAWL_SNAPSHOT_NAME_PATTERN` (lower-case `<label>/<host>`, `[a-z0-9._-]`).
- The default SSRF guard allows localhost unless `NODE_ENV === 'production'`; set `NODE_ENV` in deployed workers.
- `/sitemap` uses plain `fetch` with a 10 s timeout and no SSRF guard; it reads at most 20 sitemap files and 20000 URLs and returns `[]` (never throws) when a site has none. Treat sitemaps as a supplement to link-following discovery.
- `robotsAllows` reads only the `User-agent: *` groups (the library fetches with a browser user agent). `hanzio/sitemap` (`getDomainSitemap`, `parseRobotsTxt` per user agent) is a separate, more general sitemap reader; do not mix the two rule shapes.
- `bunx website-to-markdown --help` exits 1 (kept from 1.0 for scripts); do not treat that as a broken install.
