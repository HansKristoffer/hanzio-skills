#!/usr/bin/env bash
# Every check CI runs. Run it before opening a PR.
#
# Usage:
#   bash scripts/check.sh
#
# Needs python3, shellcheck and bun on PATH. Runs every check, then exits 1 if any failed.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 2

failed=0

step() {
  echo "==> $1"
}

fail() {
  echo "FAIL: $1" >&2
  failed=1
}

step "skill structure, links, em dashes, README rows"
python3 -I scripts/check-skills.py || fail "check-skills.py"

shell_files=()
while IFS= read -r -d '' file; do
  shell_files+=("$file")
done < <(find .claude/skills scripts -name node_modules -prune -o -name '*.sh' -type f -print0 | sort -z)

step "shellcheck (${#shell_files[@]} files)"
if command -v shellcheck > /dev/null 2>&1; then
  shellcheck "${shell_files[@]}" || fail "shellcheck"
else
  fail "shellcheck is not installed"
fi

for test in "${shell_files[@]}"; do
  case "$test" in
    *.test.sh)
      step "$test"
      bash "$test" || fail "$test"
      ;;
  esac
done

test_dirs=()
while IFS= read -r -d '' file; do
  dir=$(dirname "$file")
  if [ "${#test_dirs[@]}" -eq 0 ] || [ "${test_dirs[${#test_dirs[@]}-1]}" != "$dir" ]; then
    test_dirs+=("$dir")
  fi
done < <(find .claude/skills -name node_modules -prune -o -name '*.test.ts' -type f -print0 | sort -z)

if [ "${#test_dirs[@]}" -gt 0 ]; then
  if command -v bun > /dev/null 2>&1; then
    for dir in "${test_dirs[@]}"; do
      step "bun test $dir"
      (cd "$dir" && bun test) || fail "bun test $dir"
    done
  else
    fail "bun is not installed, and ${#test_dirs[@]} folders have Bun tests"
  fi
fi

if [ "$failed" -ne 0 ]; then
  echo "check: failed" >&2
  exit 1
fi
echo "check: all passed"
