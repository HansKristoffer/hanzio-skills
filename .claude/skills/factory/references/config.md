# factory.config.yaml

An optional file in a repository's root that sets the factory's models, notes and rules for that project. A project needs no file: the defaults and the factory page's settings cover it.

## Where it is read

From the default branch on origin (`git show origin/<default>:factory.config.yaml`, after a fetch), never from a thread's worktree. A change to the file therefore takes effect once it is merged, and an issue's own branch cannot change its rules. An issue keeps the settings it started with; `factory start` run again in its thread picks up a change.

The settings come in layers, and a later one wins: built-in defaults, the page's settings for all repositories, this file, then the page's settings for this repository on this machine. `factory settings` in a checkout prints what an issue started there would get, with the layer each value came from.

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
  land:
    note: |
      Merging to main deploys on Railway. Check /health and the worker's logs.
      Ship the release-please release after the merge.
planApproval: always
reviewRounds: 3
rulings: |
  - Public API responses keep their field names; add fields, never rename them.
  - A fix that changes stored data needs a migration that can run twice.
```

- `orchestrator` is the model of the issue's own thread. `stages.research`, `plan`, `implement` and `review` each run on their own target; a stage without one runs on the orchestrator's. The review target also reviews plans.
- A target is `provider` and `model` together, as T3 Code's `orchestrator_capabilities` lists them, with optional `options` (Claude's `effort`, Codex's `reasoningEffort`). A layer that sets a target replaces the whole target below it.
- `note` is added to that stage's brief under "For this project". `land.note` says how the project deploys, how to check it, and whether to ship its release.
- `planApproval`: `auto` (the default) asks the user to approve the plan of a feature, a large change or a one-way door; `always` and `never` do what they say.
- `reviewRounds`: review rounds on a PR before the merge becomes a decision, 0 to 5, default 2; 0 skips the review.
- `rulings`: standing rules added to every brief.

## When it is broken

A file that does not parse, is not a mapping, or has an unknown key is left out whole, never half-applied. The issue runs on the other layers, and its thread asks a `blocked` decision quoting the error, such as `factory.config.yaml: stages.reviw: unknown key`. Fix the file on the default branch and answer the decision. An empty file, or one with only comments, counts as no file.
