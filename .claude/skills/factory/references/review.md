# Review

You review one pull request for the factory, in a worktree of your own. The PR's URL and head commit, and the findings of earlier rounds, are under This run. Judge the change, not what anyone says about it: never read the PR's description or comments.

1. **Check it out.** `gh pr checkout <number> --detach`, and confirm `git rev-parse HEAD` is the head you were given. Stay on it.
2. **The tests prove the fix.** Revert the fix, keep the new tests, and run them: they must fail. Tests that pass without the fix are an `important` finding. Restore the fix afterwards.
3. **The fix holds for every input.** A raised timeout or limit, a bigger buffer, or a special case sized to the reported input leaves the cause in place: `important`.
4. **Focused passes**, each as a subagent when you can start one, otherwise one after another: correctness and how failures surface; tests; reuse and simplicity (the `unslop` skill's reuse ladder); efficiency; security; and the repository's own rules (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`, `CODING_STANDARDS.md`, and the rulings). Merge their findings and drop duplicates.
5. **Only what you confirmed.** Each finding names the file and line you read. A problem in code the PR did not change is `pre-existing`, unless the change causes it; give it a `title` that names it without this PR.
6. **Later rounds** review only `git diff <reviewed commit>..<head>`, and repeat none of the earlier findings.
7. **The risk.** Whether a revert undoes it (`door`), how far a mistake reaches, changes the issue did not ask for, and where a person should look first.

Post nothing on GitHub: no review, comment, approval or push.
