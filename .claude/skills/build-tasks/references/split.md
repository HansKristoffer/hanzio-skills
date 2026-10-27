# Split the build into task documents

The agreed document becomes the **master document**: the single source of truth for the build. It is a plan written with the `plan` skill, or a `technical.md` from `scope-new-project`. This step splits the work into self-contained task documents. Each one is handed to a separate AI agent, so it must contain everything that agent needs. Assume the agent has never seen the master document, the source material or this conversation.

## Where the tasks go

Split only what has been approved to build. Write the set to a `tasks/<slug>/` folder beside the master document: `tasks/<plan-slug>/` for a plan, `tasks/<scope-phase-slug>/` for a scope phase, for example `tasks/phase-1-book-and-follow/`. When a later scope phase is approved, it gets its own folder, and its numbering starts again at 1.x, because the earlier set is merged by then.

Run the split in the repository the work will be built in, so the file paths in the tasks are real. If a template has not been copied yet, use the paths the files will have once the template is stripped, and say so in the index.

## Numbering = execution order

Name each document `<phase>.<track> – <short-name>.md`, for example `1.2 – auth-api.md`. These phases are execution order, not the commercial phases in a `scope.md`.

- Same phase number → runs in parallel: 1.1, 1.2 and 1.3 run at the same time.
- A phase starts only when every task in the previous phase is merged. All of 1.x finishes before 2.x starts.
- Shared foundations go in the earliest phase, so later parallel tasks build on fixed interfaces instead of guessing them. Foundations are:
  - repo scaffolding and stripping the template;
  - the database schema and shared types;
  - API contracts;
  - environment and config.
- Two tasks share a phase only if they edit none of the same files. If they would, merge them or move one to a later phase. Shared registries count: a route index, a schema file, a translation catalog, a navigation config. The one exception is `0.0 – index.md`, which holds every task's status row.
- A wide mechanical change (renaming a column, retyping a shared symbol) cannot be split by files, because one edit breaks every caller. Sequence it as expand (the new form beside the old), migrate (callers in batches, one task per package or folder), contract (delete the old form, last).
- Maximise parallelism, but don't split work so small that coordinating it costs more than the task.

## Each task document contains

1. **Goal**: one or two sentences on what this delivers and why. Name the task by what can be shown when it is done; an "and" in the name means two tasks.
2. **Context**: the parts of the master document this task needs, copied in, not referenced. Include:
   - the business rules and the decisions that bind this task;
   - the integration findings: auth, endpoints, data shapes, limits;
   - the repository conventions it must follow, with the paths of the files to copy patterns from.
3. **Depends on**: the task IDs that must be done first, and what each provides (types, endpoints, tables) that this task uses.
4. **Scope**: exactly what to build.
5. **Out of scope**: what to leave alone, especially work owned by parallel tasks, named by task ID.
6. **Files owned**: the files and directories this task creates or modifies. No overlap with any other task in the same phase.
7. **Interfaces**: the exact contracts this task exposes or consumes:
   - function signatures and TypeScript types;
   - API routes, with request and response shapes;
   - database tables;
   - events and queues.

   A consumed interface must match, character for character, the one its providing task exposes.
8. **Acceptance criteria**: a checklist where each item names a test, a command, or a file and its content. Trace each item back to a line in the master document. A task with more than five criteria is two tasks.
9. **Proof**: how to show it works, taken from the plan's proof for this slice when there is one.
10. **Tests**: what must be tested, and the exact commands to run them in this repository.
11. **Labels**: `hitl` when a person must act partway (credentials, a design call, manual setup, access to an external service). Omit otherwise.
12. **Definition of done**:
    - it builds, type-checks and passes lint;
    - its tests pass;
    - no TODOs are left in owned files;
    - its status row in `0.0 – index.md` says Done, with a link to its PR or merge commit.

    Add the repository's own required checks from its `AGENTS.md`.

    Every task document ends with a **Status** section. When the task runs in its own thread, it tells the agent to update its own row in `0.0 – index.md`, and no other row:
    - set it to In progress when it starts;
    - set it to Blocked, with the reason, when it cannot go on;
    - set it to Done, with its PR link, as the last step.

    In an orchestrated run, the orchestrator updates the rows and the agent reports instead.

Write for a capable engineer with zero context: specific, no hand-waving, no "as discussed above".

## Also write `0.0 – index.md`

- A table of all tasks with these columns: ID, name, phase, depends on, files owned, labels, rough size (S/M/L), status, PR.
  - Status is Not started, In progress, Blocked (with the reason) or Done. Every task starts as Not started.
  - The rows always show where the build stands.
  - A phase may start only when every row in the previous phase says Done.
  - If two tasks' status edits conflict in a merge, keep both rows' values.
- A Mermaid diagram of the dependencies, grouped by phase.
- The open questions or ambiguities in the master document that block a task. Flag each one with the tasks it blocks; never invent an answer.

## Rules

- Don't change the architecture or stack in the master document. If something is missing or contradictory, list it in the index under open questions.
- Every feature entry or slice in the approved work lands in exactly one task. Check the coverage both ways.
- Before handing off, read the index table phase by phase and confirm that no file or directory is owned by two tasks in the same phase.
- Output each document as a separate file.
- If the scope changes after the split, rewrite the tasks it touches that have not started yet, and update the index.
