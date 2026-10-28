#!/usr/bin/env bash
# Tests paired-runs.py against two worktrees of a scratch repository.
#
# Usage:
#   bash .claude/skills/optimize/scripts/paired-runs.test.sh
#
# The scratch repository has a deleted file, a renamed file and a local base branch
# behind its remote, and the arms are worktrees made the way SKILL.md describes.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/paired-runs.py"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

failures=0
check() {
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 (expected $3, got $2)" >&2
    failures=1
  fi
}

git init -q --bare "$scratch/remote.git"
git clone -q "$scratch/remote.git" "$scratch/repo" 2> /dev/null
cd "$scratch/repo"
git config user.email test@example.com
git config user.name test
git checkout -q -b main
printf 'sleep 0.2\n' > work.sh
printf 'old\n' > old-name.txt
printf 'gone\n' > deleted.txt
git add . && git commit -q -m base
git push -q origin main
base=$(git rev-parse HEAD)

git checkout -q -b faster
printf 'sleep 0.02\n' > work.sh
git mv old-name.txt new-name.txt
git rm -q deleted.txt
git commit -q -am faster

git checkout -q main
printf 'later\n' > later.txt
git add later.txt && git commit -q -m later
git push -q origin main
git reset -q --hard "$base"   # local main is now behind origin/main

git worktree add -q "$scratch/control" "$base"
git worktree add -q "$scratch/treatment" faster

set +e
output=$(python3 -I "$script" --control "$scratch/control" --treatment "$scratch/treatment" --pairs 6 --warmup 0 -- bash work.sh)
status=$?
set -e
check "faster treatment exits 0" "$status" 0
check "faster treatment wins every pair" "$(grep -c 'treatment faster in 6 of 6 pairs' <<< "$output")" 1
check "6 of 6 gives p = 0.016" "$(grep -c 'p = 0.016' <<< "$output")" 1
check "pairs alternate and all print" "$(grep -c '^pair ' <<< "$output")" 6

set +e
output=$(python3 -I "$script" --control "$scratch/control" --treatment "$scratch/control" --pairs 2 --warmup 0 -- bash work.sh)
status=$?
set -e
check "A/A run on one checkout exits 0" "$status" 0
check "A/A run prints a summary" "$(grep -c '^paired diff median' <<< "$output")" 1

set +e
python3 -I "$script" --control "$scratch/control" --treatment "$scratch/treatment" --pairs 1 --warmup 0 -- 'test -f deleted.txt' > /dev/null 2>&1
status=$?
set -e
check "a command failing in the treatment exits 1" "$status" 1

set +e
python3 -I "$script" --control "$scratch/control" --treatment "$scratch/treatment" > /dev/null 2>&1
status=$?
set -e
check "no command is a usage error" "$status" 2

cd /
git -C "$scratch/repo" worktree remove "$scratch/control"
git -C "$scratch/repo" worktree remove "$scratch/treatment"
check "worktrees remove cleanly" "$(git -C "$scratch/repo" worktree list | wc -l | tr -d ' ')" 1

exit "$failures"
