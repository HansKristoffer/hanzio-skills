#!/usr/bin/env bash
# Tests snapshot.sh in a scratch repository.
#
# Usage:
#   bash .claude/skills/unslop/scripts/snapshot.test.sh
#
# The scratch repository holds uncommitted feature work of every kind: an edited file,
# a deleted file, a renamed file, a staged file, an untracked file with a space and a
# non-ASCII letter in its name, and an ignored file. The script reads no base branch,
# so there is no remote here.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/snapshot.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

failures=0
check() {
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 (expected '$3', got '$2')" >&2
    failures=1
  fi
}

repo="$scratch/repo"
git init -q -b main "$repo"
cd "$repo"
git config user.email test@example.com
git config user.name test
git config core.quotePath false

mkdir src
printf 'kept\n' > src/kept.ts
printf 'gone\n' > src/gone.ts
printf 'renamed\n' > src/old-name.ts
printf '*.log\n' > .gitignore
git add -A
git commit -qm base

# The feature, uncommitted.
printf 'kept, edited by the feature\n' > src/kept.ts
rm src/gone.ts
git mv src/old-name.ts src/new-name.ts
printf 'staged\n' > src/staged.ts
git add src/staged.ts
printf 'untracked\n' > 'src/ny fil å.ts'
printf 'noise\n' > debug.log

index=$(git rev-parse --git-path index)
status_before=$(git status --short)
index_before=$(cksum < "$index")
stash_before=$(git stash list)

before=$(bash "$script")
check "it prints a tree id" "$(git cat-file -t "$before")" tree
check "the status is unchanged" "$(git status --short)" "$status_before"
check "the index is unchanged" "$(cksum < "$index")" "$index_before"
check "the stash is unchanged" "$(git stash list)" "$stash_before"

files=$(git ls-tree -r --name-only "$before")
check "the tree holds tracked, renamed, staged and untracked files, not deleted or ignored ones" "$files" ".gitignore
src/kept.ts
src/new-name.ts
src/ny fil å.ts
src/staged.ts"
check "an edited file is stored as it is on disk" "$(git show "$before:src/kept.ts")" "kept, edited by the feature"

check "a second snapshot of the same files is the same tree" "$(bash "$script")" "$before"
check "it runs from a subdirectory" "$(cd src && bash "$script")" "$before"

# The cleanup pass.
printf 'kept, edited by the pass\n' > src/kept.ts
printf 'untracked, edited by the pass\n' > 'src/ny fil å.ts'
rm src/staged.ts
printf 'new\n' > src/added-by-pass.ts

after=$(bash "$script")
changed=$(git diff --name-status "$before" "$after")
check "the diff of two snapshots holds the pass, not the feature" "$changed" "A	src/added-by-pass.ts
M	src/kept.ts
M	src/ny fil å.ts
D	src/staged.ts"

git restore --source="$before" --worktree -- src/kept.ts 'src/ny fil å.ts' src/staged.ts
check "restore brings back a tracked file" "$(cat src/kept.ts)" "kept, edited by the feature"
check "restore brings back an untracked file" "$(cat 'src/ny fil å.ts')" "untracked"
check "restore brings back a file the pass deleted" "$(cat src/staged.ts)" "staged"
rm src/added-by-pass.ts
check "the working tree is back at the first snapshot" "$(bash "$script")" "$before"

# A linked worktree keeps its own index.
git worktree add -q "$scratch/linked" -b linked HEAD
(
  cd "$scratch/linked"
  printf 'only here\n' > src/linked.ts
  bash "$script" > "$scratch/linked-tree"
)
linked=$(cat "$scratch/linked-tree")
check "a linked worktree snapshots its own files" "$(git ls-tree -r --name-only "$linked" | grep -c linked.ts)" 1
check "the main worktree's snapshot is unaffected" "$(bash "$script")" "$before"

# A repository with no commit has no index file yet.
git init -q -b main "$scratch/fresh"
(
  cd "$scratch/fresh"
  printf 'first\n' > first.ts
  bash "$script" > "$scratch/fresh-tree"
)
check "a repository with no commit snapshots its files" "$(cd "$scratch/fresh" && git ls-tree -r --name-only "$(cat "$scratch/fresh-tree")")" "first.ts"

set +e
(cd "$scratch" && bash "$script" > /dev/null 2>&1)
status=$?
bash "$script" extra > /dev/null 2>&1
argument_status=$?
set -e
check "outside a repository it exits 2" "$status" 2
check "an argument exits 2" "$argument_status" 2

if [ "$failures" -ne 0 ]; then
  echo "snapshot.test: failed" >&2
  exit 1
fi
echo "snapshot.test: all passed"
