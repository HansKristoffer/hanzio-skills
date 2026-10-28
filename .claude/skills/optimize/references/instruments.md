# Instruments

One section per kind of metric: the instrument the agent runs itself, how to hold the noise down, and the ways it most often lies. Swap in the repository's own commands wherever its `AGENTS.md` or `package.json` names them, and run them through the repo's env wrapper when it has one.

## Paired runs on one machine

For anything a command can time: a build, a test suite, a typecheck, a script. Put each arm in its own worktree from the pinned commit, then time them interleaved with [scripts/paired-runs.py](../scripts/paired-runs.py):

```bash
git worktree add /tmp/opt-control <pinned-sha>
git worktree add /tmp/opt-treatment <branch-with-the-change>
(cd /tmp/opt-control && bun install --frozen-lockfile)
(cd /tmp/opt-treatment && bun install --frozen-lockfile)

python3 -I "$SKILL_DIR/scripts/paired-runs.py" --control /tmp/opt-control --treatment /tmp/opt-control --pairs 6 -- bun run build    # A/A: the noise floor
python3 -I "$SKILL_DIR/scripts/paired-runs.py" --control /tmp/opt-control --treatment /tmp/opt-treatment --pairs 10 -- bun run build

git worktree remove /tmp/opt-control
git worktree remove /tmp/opt-treatment
```

`SKILL_DIR` is this skill's directory. The script alternates which arm runs first, prints every pair, and ends with each arm's median, the median paired difference and the sign-test p-value the keep bar reads. It stops with exit 1 when the command fails in either arm: a faster build that fails is not faster.

## CI time to green

- **Instrument:** wall time from the run's creation to its last job finishing, for the workflow that gates PRs. History first, to find the median, the p90 and the slowest required job (the critical path; only changes to it move the metric):

  ```bash
  gh run list --repo "$REPO" --workflow ci.yml --branch main --status success --limit 50 \
    --json databaseId,createdAt,updatedAt \
    --jq '.[] | [.databaseId, (((.updatedAt | fromdate) - (.createdAt | fromdate)) / 60)] | @tsv'
  gh run view "$RUN_ID" --repo "$REPO" --json jobs \
    --jq '.jobs[] | [.name, (((.completedAt | fromdate) - (.startedAt | fromdate)) / 60)] | @tsv'
  ```

- **Paired runs:** push a control branch and a treatment branch from the same base at the same time, as draft PRs, so both meet the same runner queue. Give both the same small nonce change that touches code, so caches and path filters treat them alike. At least 6 pairs, spread over the day.
- **Lies:** an empty commit that hits warm caches or skips jobs through path filters; shaving a job that is not on the critical path; a rerun that hides a flaky failure (count reruns in the metric); a speed-up that comes from running fewer tests (the test count is a guard).

## Test suite, typecheck and build time

- **Instrument:** the repository's own command under `paired-runs.py`: `bun test`, `bunx vitest run`, `bunx tsc --noEmit -p <tsconfig>`, `bun run build`.
- **Noise:** same cache state in both arms. Either both warm (the default warmup run) or both cold, with the cache deletion inside the command (`rm -rf node_modules/.cache .turbo *.tsbuildinfo && bun run build`). Close other heavy processes.
- **Lies:** a Turborepo or Nx cache hit that reports a build in no time (pass `--force`); incremental typecheck state left from an earlier run; fewer test files matched (compare the test count the runner prints).

## Web page speed (Vue, React)

- **Instrument:** a Playwright script against a production build (`bun run build`, then the framework's preview server), timing navigation to the element the user waits for, plus Largest Contentful Paint from a `PerformanceObserver`. For a mid-range phone, slow the CPU through the Chrome DevTools Protocol: `await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: 4 })`. Lighthouse gives the same numbers as JSON: `npx lighthouse <url> --output=json --quiet --chrome-flags=--headless`, read `.audits["largest-contentful-paint"].numericValue`.
- **Noise:** a fresh browser context per run, fixed viewport, seeded data, the same throttling in both arms, at least 5 runs.
- **Lies:** the dev server (unminified, hot reload); the first run warming the browser cache; timing before the UI settles; mocked APIs that answer faster than the real ones.

## Scrolling and interaction jank

- **Instrument:** a Playwright script that performs the scroll or interaction while the page records `requestAnimationFrame` deltas, and prints the p50 and p90 frame time and the count of frames over 50 ms.
- **Localize first:** remove or stub one component and measure again. When the jank goes away, that component is where to optimize.
- **Lies:** a human eyeballing smoothness; a profiler left attached during the measured runs.

## API latency

- **Instrument:** the procedure called in a loop against the dev server (a Bun script timing N calls, or `autocannon` / `oha` when installed), reporting median and p90, with the dev database seeded to production-like row counts. A `Server-Timing` header or timed log lines split the total into parts. A slow query found here goes to the `postgres-tuning` skill.
- **Lies:** a small dev database that makes every query fast; the first call paying for connection setup and JIT; a cache layer answering instead of the code being measured.

## Bundle size

- **Instrument:** the build's output, gzipped, for the JavaScript the measured route loads first, not the total: `for f in dist/assets/*.js; do printf '%s\t%s\n' "$(gzip -c "$f" | wc -c)" "$f"; done | sort -n`. A bundle visualizer (`rollup-plugin-visualizer`) shows what to cut.
- **Noise:** deterministic. Build twice to confirm identical sizes, then one build per arm is enough.
- **Lies:** moving code into a lazy chunk the first screen loads anyway. Guard with the E2E smoke test: the app still works.

## Expo and React Native

- **Instrument:** JS bundle size from `npx expo export --platform ios` (or `android`); startup and render timing from the React Native DevTools profiler or Hermes sampling profile on a release build. A person tapping through the app is the weakest instrument here; when it is the only one, drive them with a numbered script and record each answer, and say on the card that the evidence is weaker.
- **Lies:** debug builds; a simulator standing in for a phone.

## Model cost and prompt or agent quality

- **Instrument:** a fixed set of real inputs with expected outputs or a grader, each case run at least 3 times, reporting the pass rate and the tokens and cost from the provider's usage fields. Keep a held-out set the changes never look at, and keep a change only when the held-out pass rate improves.
- **Noise:** the repeats per case; fixed model, temperature and tool set in both arms.
- **Lies:** a grader bug (read every failure before climbing); a prompt line fitted to one case (it should still make sense with that case removed); an eval run that produced nothing and counted as a pass.

## Flaky test rate

A flake has a cause. Call the Skill tool with `debug`; its loop counts the failure rate and its done check sizes the clean runs a fix needs.
