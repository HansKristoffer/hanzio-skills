# Loop recipes

One recipe per kind of loop from phase 1, for our stack. Swap in the repository's own commands wherever its `AGENTS.md` or `package.json` names them: run commands through the repo's env wrapper (for hellu-style apps, `bunx buncargo exec --app=api -- <command>`), not with exported secrets.

## Focused test

The fastest loop when a test can reach the bug.

```bash
bun test apps/backend/src/orders/totals.test.ts -t 'applies the discount once'
bun test apps/backend/src/orders/totals.test.ts -t 'applies the discount once' --rerun-each 100   # flaky: counts pass/fail
bunx vitest run src/orders/totals.test.ts -t 'applies the discount once'                          # vitest repos
```

`-t` is a regex over the test name. `--rerun-each 100` reports how many of the 100 runs failed, which is the reproduction rate for a flaky bug. Pin time with the runner's fake timers (`setSystemTime` from `bun:test`, `vi.useFakeTimers()`) and seeds with `--seed` when the test order matters.

## Calling the procedure

Three ways in, fastest first:

- **The app's CLI.** In repos that expose procedures as CLI commands (`meta: { cli: true }` with `procedureCommands`), the command runs through oRPC with the same guards and logs as HTTP: `bunx buncargo exec --app=api -- bun apps/backend/src/entry/cli.ts <command> --<arg> <value>`.
- **In process.** A scratch script or test that calls the procedure with `call(procedure, input, { context })` from `@orpc/server`, with the context the failing request had (user, organization).
- **Over HTTP** against the running dev server. The RPC protocol takes a `POST` to the procedure's path with the input under `json`:

```bash
curl -s -X POST "http://localhost:3000/rpc/orders/applyDiscount" \
  -H 'content-type: application/json' \
  -H "cookie: $DEV_SESSION_COOKIE" \
  -d '{"json":{"orderId":"ord_123","code":"SUMMER"}}' | jq .
```

Check the server's mount prefix (`/rpc`, `/api/rpc`) first. Assert on the field that is wrong, not the status code: `| jq -e '.json.total == 900'` exits non-zero when the value is wrong, which turns the call into a red/green loop.

## Database script

For a bug in a query or a service function, run it alone against the **dev** database with the input that fails. Never point a loop at production data, and never reset or truncate a database to make a loop pass.

```ts
// scratch/repro-totals.ts (delete when done)
import { prisma } from '@app/prisma'
import { computeTotals } from '../apps/backend/src/orders/totals'

const order = await prisma.order.findUniqueOrThrow({ where: { id: 'ord_123' }, include: { lines: true } })
const totals = computeTotals(order)
console.log('[DEBUG-a4f2]', totals)
process.exit(totals.total === 900 ? 0 : 1)
```

Exit 0 for green and 1 for red, so the same script works under `git bisect run`. To see the SQL Prisma sends, turn on query logging for the script's client (`log: ['query']`).

## Playwright script

For a bug that only shows in the browser. Write a one-off script, not a new spec in the suite:

```ts
// scratch/repro-checkout.ts (delete when done)
import { chromium } from 'playwright'

const browser = await chromium.launch()
const page = await browser.newPage()
const errors: string[] = []
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(error.message))

await page.goto('http://localhost:5173/checkout')
await page.getByRole('button', { name: 'Apply code' }).click()
const total = await page.getByTestId('order-total').textContent()

await browser.close()
console.log({ total, errors })
process.exit(total === '900 kr' && errors.length === 0 ? 0 : 1)
```

Log in through the app's dev login or a stored `storageState` file, never by typing a real password into the script. When the repo already has Playwright fixtures for login, run a single spec with `bunx playwright test path/to/spec.ts -g '<name>'` instead.

## Replaying a webhook or job

When the failure starts from an event, capture the real payload once and replay it.

- **Webhooks.** Save the failing request body and headers to a file (redact the signature secret and tokens). With hono-webhooks, its `testWebhook` helper or CLI `test` command signs and sends a payload; see the package README. Otherwise post the saved body to the dev endpoint with curl.
- **Graphile Worker jobs.** A job that failed for good keeps its payload and `last_error`:

  ```sql
  select id, task_identifier, payload, last_error from graphile_worker.jobs
  where task_identifier = 'orders.sync' order by id desc limit 5;
  ```

  Replay it on the dev database with `select graphile_worker.add_job('orders.sync', '<payload>'::json);`, or better, call the task handler directly in a test with that payload, using better-graphile-worker's `/testing` helpers when the repo has them. The direct call is faster and does not need a running worker.

## git bisect run

When the bug appeared between a known good commit and a bad one, let git find the commit. Any loop that exits 0 on good and 1 on bad works:

```bash
cat > /tmp/bisect-loop.sh <<'EOF'
#!/usr/bin/env bash
# 0 = good, 1 = bad, 125 = cannot test this commit (skip it)
bun install --frozen-lockfile > /dev/null 2>&1 || exit 125
bun test apps/backend/src/orders/totals.test.ts -t 'applies the discount once'
EOF
chmod +x /tmp/bisect-loop.sh

git bisect start <bad-sha> <good-sha>
git bisect run /tmp/bisect-loop.sh
git bisect reset
```

Keep the loop script outside the repository, so checking out older commits does not change or delete it. When the test file itself is new, copy it to `/tmp` and point the loop at the copy. Exit 125 for commits that do not build, so they are skipped instead of counted as bad.

## Differential run

When old and new versions disagree on the same input, run both and diff:

```bash
git worktree add /tmp/old <good-sha>
(cd /tmp/old && bun install --frozen-lockfile && bun scratch/repro-totals.ts) > /tmp/old.out
bun scratch/repro-totals.ts > /tmp/new.out
diff /tmp/old.out /tmp/new.out
git worktree remove /tmp/old
```

The same works for two configurations or two environments: same input, outputs diffed.

## Expo and React Native

Move the logic under suspicion into a plain module and loop on it with `bun test`; most bugs on the phone are bugs in that logic. For bugs that only happen on a device or simulator, read the Metro and device logs (`npx expo start`, then the device log), and use the React Native DevTools debugger. When a person must tap through the app, drive them with a numbered script: one instruction at a time, wait for their answer, and record it, so the loop stays the same every run.
