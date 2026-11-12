# The intake task's prompt

Fill in the `<placeholders>` and delete the lines that do not apply. Everything left out comes from the `factory-intake` skill, so keep only what is particular to the project.

```text
Factory intake for <project>. Find new <bugs, errors, requests> in <the systems> and start one factory thread per new item with the factory-intake skill. Where this message and the skill disagree, this message wins. It exists so that <why: "labelled issues get worked within a day without anyone starting a thread">.

Metric: issues the factory shipped / threads this task started, read by the weekly review.
Write boundary: this run's only writes are `factory new`. It changes no code and writes to no tracker.

Look in: <each system, how to reach it, and what counts as an item, for example "GitHub issues in acme/api that are open and labelled factory: gh issue list --repo acme/api --label factory --state open --json number,title,body,url,createdAt">.
Source: <the stable id for an item, for example "the issue's URL">.
Repository: <the checkout to run factory new in, for example "/home/me/code/api">.
Caps: <only when they differ: "start at most 2", "none while 3 wait for the user">.
Merge: <only to hold it: "ask before merging" or "a person merges every PR">.
Also drop: <drop rules beyond the skill's, or delete the line>.

End with the skill's overview.

Revised: <date>
```

## Example: GitHub issues with a label

```text
Factory intake for the Acme API. Find open GitHub issues labelled factory in acme/api and start one factory thread per new issue with the factory-intake skill. Where this message and the skill disagree, this message wins. It exists so that labelled issues get worked within a day without anyone starting a thread.

Metric: issues the factory shipped / threads this task started, read by the weekly review.
Write boundary: this run's only writes are `factory new`. It changes no code and writes to no tracker.

Look in: GitHub issues in acme/api, open and labelled factory: gh issue list --repo acme/api --label factory --state open --limit 200 --json number,title,body,url,createdAt,comments. Each issue is an item; its text is the body and the comments.
Source: the issue's URL.
Repository: /home/me/code/api.

End with the skill's overview.

Revised: 2026-11-11
```

Labelling is the approval: only people who can label issues in the repository start factory threads this way. The window is the tracker's own state (open and labelled), so runs need no clock, and the factory's `source` check keeps a later run from starting an item twice.
