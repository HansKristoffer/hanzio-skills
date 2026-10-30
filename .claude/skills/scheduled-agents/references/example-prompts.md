# Example prompts

Two prompts that run in production, with the project's names replaced by `<placeholders>`. Copy the shape; replace the data sources, commands and rules with the repository's own.

## Daily production check (fixed time, weekdays 09:00)

```
Daily production check for <project>. For every PR merged to main in this run's window, find out whether it did in production what it set out to do, and whether anything got worse after it went live. The error webhook already handles new exceptions; this run catches what does not throw: a job that stopped running, an integration that went quiet, a flow that stopped completing.

This run is read-only for code and data: do not edit files, create branches, start the stack, or call any write tool on <production MCP>, <analytics> or <host>. Its only writes are GitHub issues and issue comments in <owner/repo>.

1. Runs have no memory, so the window is fixed: PRs merged from 30 hours ago up to 6 hours ago (on a Monday, from 78 hours ago). Consecutive runs cover each PR exactly once, and every PR has had at least six hours in production. List them: `gh pr list --repo <owner/repo> --state merged --base main --search "merged:<start>..<end>" --limit 50 --json number,title,body,mergedAt,mergeCommit,files`. None: say so in the overview and stop.
2. Skip PRs that change nothing running in production: only docs, tests, CI workflows, lint or formatting config. List what you skipped in the overview.
3. Find when each remaining PR went live: <host>'s deployments for <service> in production, matched on commit (`git merge-base --is-ancestor <merge commit> <deployed commit>`). If no successful deployment contains it, it never reached production: report it under "Be aware of" and do not measure it.
4. For each live PR, read its body and diff and write down two things before you look at any data. Expected: what should be different in production. At risk: what nearby behaviour it could break.
5. Measure both, comparing the same span of time before and after the deploy (up to 24 hours each, the same hours of the day when you can):
   - Errors: <analytics> exceptions grouped by issue and by our stack frames in the files the PR touched.
   - Logs and HTTP: <host> logs for the touched module, errors and 5xx responses on the touched routes.
   - Domain activity: counts of the things the PR touches (<orders, shipments, invoices, webhooks, job failures>). A count that drops to zero or halves after the deploy over a normal working day is a finding, even with no error.
   Write down every query you ran, so the evidence can be checked.
6. Give each PR one verdict: Held (the expected change is visible), Fine (nothing expected to show, nothing at risk got worse), Worse (measurably worse after the deploy, and the timing points at this PR), or Can't tell (say what would show it). Do not call anything Worse without numbers before and after and a reason in the diff.
7. For each Worse PR, search for an open issue titled "Production check: … #<PR>" and comment on it, or open one with the numbers, the queries, the suspected diff with file and line, and a note that the daily production check filed it. At most two new issues per run. Never revert, roll back or redeploy anything.
8. End your last message with this overview, in English, readable in a minute:

   **Production check, <date>:** <N> PRs merged in the window, <M> live and checked.
   **Worse:** each one: PR, what got worse, the issue. "None" if none.
   **Held:** each PR whose fix is visible in production, with one line of evidence.
   **Fine / Can't tell:** the rest, a few words each.
   **Skipped:** PRs with nothing running in production.
   **Be aware of:** PRs that never reached production, odd traffic. Write "Nothing" if there is nothing.
   **Outcome:** ACTED (the issues opened or commented), NOOP (why nothing needed filing) or BLOCKED (what a person must fix for this check to run).

Revised: 2026-10-28
```

## Daily flaky test report (fixed time, weekdays 07:30)

```
Daily flaky E2E report for <project>. Playwright retries every failing E2E test in CI (`retries` in <playwright config>), so a flaky test turns the checks green and nobody sees it. Find the tests that failed and then passed on a retry, diagnose the worst ones, and keep one GitHub issue per flaky test up to date, so whoever picks one up starts from a diagnosis.

This run is read-only for code: do not edit files, create branches, start the stack or run tests. Its only writes are GitHub issues and issue comments in <owner/repo>. Stop at the issue: never open a PR.

1. Runs have no memory, so the window is fixed: <workflow> runs created from 25 hours ago up to 1 hour ago (on a Monday, from 73 hours ago).
2. Collect the E2E jobs of every attempt (`gh api "repos/<owner/repo>/actions/runs/<id>/attempts/<n>/jobs"`) and read their logs with colour codes stripped (`gh api --allow-escape-sequences "repos/<owner/repo>/actions/jobs/<job>/logs" | sed 's/\x1b\[[0-9;]*m//g'`).
3. Playwright's summary prints `N flaky` followed by one line per test, and above it a numbered block per failed or flaky test with the error and each retry. Also count a test that failed in one attempt and passed in a later attempt of the same run. A test that fails every attempt on one branch is that branch's bug, not a flake. Identify a test by its file and full title, never the line number.
4. Count jobs and branches per flaky test, keep up to three job links, and rank.
5. Diagnose the top three from at least two error blocks, the spec, and the code and fixtures it drives. Name a cause only when the source or the log shows it, with file and line; otherwise say "cause not confirmed" and list what you ruled out.
6. One issue per test, searched open and closed by title "Flaky E2E: <file> › <test title>": comment on an open one, reopen a closed one that flakes again, or open one with the counts, the trimmed error, the diagnosis, a suggested fix and how to confirm it (`--repeat-each=20`). At most three new issues per run.
7. End your last message with this overview, in English, readable in a minute:

   **Flaky E2E, <date>:** <N> runs, <M> E2E jobs read, <K> flaked.
   **Worst:** each of the top three: test, how often, cause in a few words, issue and whether you opened, updated or reopened it.
   **Also flaky:** the rest, one line each with its count.
   **Be aware of:** unreadable logs, infrastructure failures, a test that flakes on almost every run. Write "Nothing" if there is nothing.
   **Outcome:** ACTED (the issues opened, updated or reopened), NOOP (no flakes in the window) or BLOCKED (what a person must fix for this report to run).

Revised: 2026-10-28
```
