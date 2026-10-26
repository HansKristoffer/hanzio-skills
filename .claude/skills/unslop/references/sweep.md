# Sweeping a whole codebase

A sweep applies the checklist to every file in a scope, not to a diff. Every finished slice of a sweep has a **manifest** (the files in scope) and a **done list** (one line per file read). The work is done when the two match, line for line. Without that bar, a delegated agent greps for a few patterns, fixes the hits, and reports a "light pass" that never opened most of its files.

## Steps

1. **Write the manifests.** List the scope with `git ls-files`, drop generated files (the repo's formatter ignore file and `.gitignore` name them), and split it into slices by area: one folder tree per slice, a few hundred files each, no file in two slices. Save each slice as `/tmp/<sweep>-<slice>.txt`, one path per line. Done when every file in scope appears in exactly one manifest.
2. **Give each slice its own checkout.** Cut a branch per slice from the sweep branch and dispatch each agent into its own worktree. Agents sharing one checkout share one git index: their commits queue behind `index.lock` and the pre-commit hook, and an agent can finish with its work still uncommitted.
3. **Brief each agent with the done-list rule.** The brief names its manifest, its done list (`/tmp/<sweep>-<slice>-done.txt`) and this skill. The agent opens and reads each file in full, applies the checklist, then appends `<path> changed` or `<path> clean` to the done list before moving to the next file. It commits per folder, so a stopped run keeps its work. The slice is done when the done list holds every manifest line.
4. **Check each report against its lists.** Compare the paths in the done list with the manifest (`comm -3 <(sort manifest) <(cut -d' ' -f1 done | sort)`). A report that says it scanned, sampled or did a light pass is not done, whatever its commits contain. Dispatch a follow-up agent with only the missing lines as its manifest.
5. **Check the layout.** Compare `git diff --stat` with `git diff -w --stat` against the base for every slice. A file whose diff shrinks to almost nothing under `-w` was re-indented, not cleaned: restore the original layout and keep only the real change. Leave the layout of file types the repo's formatter does not own exactly as the file had it.
6. **Merge the slices.** Merge each slice branch into the sweep branch, run the repo's full lint, typecheck and tests once, and open the one PR.
