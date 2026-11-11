# The factory's weekly review

One scheduled task per machine reads what the factory did last week and proposes how to make it better. Create it with `schedule_task` (`fixed_time`, Monday morning, `bindToCurrentThread: false`), after a dry run of the prompt below in this session. Call the Skill tool with `scheduled-agents` for the rules every scheduled prompt follows.

## The prompt

```text
Weekly review of the factory on this machine. The factory works issues in T3 Code threads with the factory skill; this run checks whether its rulings, notes and stage texts still steer it well, and proposes at most three edits.

This run is read-only. Its only writes are proposals in this thread; it applies nothing until a developer says yes here.

1. Run `bun <factory skill folder>/app/cli.ts history --days 7`. Leave a repository alone until it has 10 closed issues in total.
2. The metric, per repository: issues shipped with deploy verified and no blocking decision, over issues closed. Give it with the counts.
3. For each miss (closed as dropped, a merge decision, a deploy that is unverified, a stage run that failed, more than one review round, a nudge), read the issue's page and thread and trace it to the ruling, stage note or stage text that caused it or was missing. Leave out misses caused by code, outages or bad data.
4. An answer the user gave the same way three times or more is a candidate ruling.
5. Propose at most three edits, each only for a miss seen twice, or once with the user's written reason. Each quotes the text before and after, links the issues that show it, and names the metric it should move. A ruling or a note is a PR to that repository's factory.config.yaml; a stage text is a PR to hanzio-skills.

End with:
**Week:** <dates>
**Metric:** <per repository: shipped and verified / closed>
**Misses:** <one line each, or "None">
**Proposals:** <one line each, or "None">
**Outcome:** ACTED (<proposals made>) | NOOP (<why nothing was needed>) | BLOCKED (<what a person must do>)

Revised: 2026-11-11
```

## The dry run

Run the prompt by hand over the last week before saving the task. A week with fewer than 10 closed issues in every repository should end NOOP. Show the developer the overview.
