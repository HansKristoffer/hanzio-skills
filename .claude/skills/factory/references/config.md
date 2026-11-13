# factory.config.yaml

An optional file in a repository's root that sets the factory's models, notes and rules for that project. A project needs no file: it can keep the same settings in the factory on this machine, where nothing is pushed.

## Where it is read

From the default branch on origin (`git show origin/<default>:factory.config.yaml`, after a fetch), never from a thread's worktree. A change to the file therefore takes effect once it is merged, and an issue's own branch cannot change its rules. An issue keeps the settings it started with; `factory start` run again in its thread picks up a change.

## One store per project

A project keeps its own settings in one **store**: this file (`file`), or the factory on this machine (`machine`), edited on the factory page's Settings. The page chooses the store per project, and the other one is left out whole. With no choice made, a project whose default branch has the file reads it, and any other project keeps its settings on the machine.

The settings come in layers, and a later one wins: built-in defaults, the page's settings for all projects, then the project's store. `factory settings` in a checkout prints what an issue started there would get, with its `store` and the layer each value came from (`file` for this file, `repo` for the machine).

Run `factory settings` before you write this file for a project. With `store: machine` the file is not read: the user changes the settings on the page, or moves the project to its repository there, where the page shows the machine's settings as a file to commit.

## Format

Every key is optional:

```yaml
orchestrator:
  provider: claudeAgent
  model: claude-fable-5-2
  options: { effort: medium }
stages:
  research:
    note: Start the API with `docker compose up` before you reproduce.
  implement:
    note: |
      Run `bun test` in the package you changed before you open the PR.
      Never change files under migrations/.
  review:
    provider: codex
    model: gpt-6-astra
    options: { reasoningEffort: high }
    fallback:
      provider: claudeAgent
      model: claude-opus-5-5
      options: { effort: high }
  land:
    note: |
      Merging to main deploys on Railway. Check /health and the worker's logs.
      Ship the release-please release after the merge.
planApproval: always
reviewRounds: 3
rulings: |
  - Public API responses keep their field names; add fields, never rename them.
  - A fix that changes stored data needs a migration that can run twice.
reviewers: [anna, acme/backend]
bots: ['greptile-apps[bot]']
approval: required
merge: never
ignore: [copilot-pull-request-reviewer]
```

- `orchestrator` is the model of the issue's own thread. `stages.research`, `plan`, `implement` and `review` each run on their own target; a stage without one runs on the orchestrator's. The review target also reviews plans.
- A target is `provider` and `model` together, as T3 Code's `orchestrator_capabilities` lists them, with optional `options` (Claude's `effort`, Codex's `reasoningEffort`). A layer that sets a target replaces the whole target below it.
- `fallback` is the target a stage runs on when its own provider refuses the run (a usage limit, a sign-in, a model that is gone). Without one, such a run stops the issue at a `blocked` decision until the user answers. A layer can set it with or without the stage's own target. For review, pick a provider other than the implementer's when one is offered.
- `note` is added to that stage's brief under "For this project". `implement.note` is the place for the seeded account to sign in with when the implementer captures the change in the running app. `land.note` says how the project deploys, how to check it, and whether to ship its release.
- `planApproval`: `auto` (the default) asks the user to approve the plan of a feature, a large change or a one-way door; `always` and `never` do what they say.
- `reviewRounds`: review rounds on a PR before the merge becomes a decision, 0 to 5, default 2; 0 skips the review.
- `rulings`: standing rules added to every brief.

The review on GitHub (see `review-loop.md`):

- `reviewers`: logins or `org/team` to request once the PR is ready, its checks pass and the bots are done. The PR's author is left out.
- `bots`: bot logins whose review of the current head the merge waits for, such as `greptile-apps[bot]`. Default none.
- `approval`: `auto` (the default) waits for an approval when the branch rules require one, GitHub says one is required, `reviewers` is set, or the rules cannot be read and GitHub blocks the merge with green checks. `required` always waits for one; `off` never does, though requested changes and open conversations still hold the merge.
- `merge`: who merges. `auto` (the default) merges when the gate is ready; `ask` makes every merge a decision on the page; `never` leaves the merge to people, and the factory checks the deploy after. Set in a project's own store, `auto` is the maintainer's standing authorization for the factory to merge and so deploy there. Left at the default in a repository whose `AGENTS.md` asks for authorization before a merge or a deploy, an issue runs on `ask`.
- `trust`: logins outside the repository whose comments count. Members, collaborators, the owner and bots count already; anyone else is stored but hidden from the factory.
- `ignore`: logins never acted on, such as a noisy bot.
- `reviewOverdueHours`: hours a wait for a review lasts before the page marks it overdue, 1 to 720, default 24. Nobody is pinged.

A list replaces the list of the layer below it.

## Who can change settings

Anyone who can reach the factory page (this machine, and the tailnet when the page listens there) can change the settings and rulings that go into every brief, start threads, answer decisions, and ask an issue's thread to start or stop its dev environment. There is no sign-in: keep the tailnet to people you trust. A PR in a private repository links its issue's page, so everyone who can read that repository sees the page's address.

## When it is broken

A file that does not parse, is not a mapping, or has an unknown key is left out whole, never half-applied. The issue runs on the other layers, and its thread asks a `blocked` decision quoting the error, such as `factory.config.yaml: stages.reviw: unknown key`. Fix the file on the default branch and answer the decision. An empty file, or one with only comments, counts as no file. A project whose store is the machine never reads the file, so a broken one there raises nothing.
