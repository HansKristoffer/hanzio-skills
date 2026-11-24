---
name: agent-browser
description: Drive a browser with the agent-browser CLI. Use when verifying a change in a running app, testing or reproducing a UI flow or bug, or capturing screenshots or video evidence for a PR or issue.
---

# agent-browser

`agent-browser` is the browser for every check an agent makes: a change looked at in the running app, a UI bug reproduced, a flow tested, a before and after captured. It runs over the harness's browser tools (T3 Code's preview tools, the Codex in-app browser), a Playwright MCP and one-off Playwright scripts. Reach for one of those only when the user names it.

Three things keep their own tooling: a repository's committed end-to-end suite (its Playwright specs), `product-video` recordings and `optimize` measurements.

## 1. Have the CLI

`command -v agent-browser`. When it is missing, install it, then a browser:

```bash
bun add -g agent-browser && agent-browser install
```

A repository may run the CLI through its own script (gey-mono's `bun run browser <command>`); its `AGENTS.md` says so, and that script is the CLI there. On Linux, a launch that ends in `No usable sandbox!` (Ubuntu's AppArmor) needs `{ "args": "--no-sandbox" }` in `~/.agent-browser/config.json`, once per machine.

## 2. Load the guide for this version

Before the first command, run `agent-browser skills get core`. It is the source of truth for commands, flags, sessions, refs and waits, and it matches the installed version, so this skill names no command it already covers. Load a reference from its table when the task needs one (video recording, auth).

## 3. Find the app in the repository

The repository's `AGENTS.md`, or its own browser skill, names how to start the app, its address in this checkout and the seeded account to sign in with. Read it first. It decides where to point the browser, never which browser to use.

## 4. Check by reading, capture for people

- **A check is text.** Assert on a snapshot, `get text` or `eval`, and read `console` and `errors --json` after the flow: a page that looks right with an error in the console is red. Plain `errors` prints only `✗` when there are errors.
- **A capture is for a person.** Take a screenshot or a video only when someone will look at it (a PR, an issue, the user). A before and its after share the viewport (1280 by 800 or wider), theme, account and data, so only the change differs. Write captures under `/tmp`, never into the checkout, and publish them the way the repository's `AGENTS.md` says.
- **A loop to rerun** (the `debug` skill) is a shell script of agent-browser commands that ends with `exit 0` for green and `exit 1` for red, so it runs under `git bisect run`.

## 5. Clean up

`close` your session before you end the turn. Another agent's session and the user's own browser are theirs: open your own, never attach to a personal debug port.

When no browser starts, say so in your reply or the PR, and finish the checks that need none. An HTTP response from curl is not a look at the UI.
