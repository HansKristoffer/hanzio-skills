#!/usr/bin/env bash
# Tests wait-for-checks.sh against a stub `gh` that serves one PR as fixture JSON.
#
# Usage:
#   bash .claude/skills/land-pr/scripts/wait-for-checks.test.sh
#
# The script reads only the GitHub API (no local git). The stub answers
# `gh pr view` from $FIXTURES/pr, so each case sets the PR's head and checks.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/wait-for-checks.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

mkdir -p "$scratch/bin"
cat > "$scratch/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Stub: gh pr view <pr> --repo <repo> --json <fields> --jq <expr>.
[ "$1 $2" = "pr view" ] || { echo "stub gh: unexpected $*" >&2; exit 1; }
echo "$*" >> "$FIXTURES/calls"
[ ! -e "$FIXTURES/fail" ] || { echo "HTTP 502" >&2; exit 1; }
jq -r "${*: -1}" "$FIXTURES/pr"
EOF
chmod +x "$scratch/bin/gh"
export PATH="$scratch/bin:$PATH"
export FIXTURES="$scratch/fixtures"

head=cc837abe0f1d2c3b4a5968778695a4b3c2d1e0f9
failures=0

check() {
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 (expected $3, got $2)" >&2
    failures=1
  fi
}

# One finished check on $head, unless a case overwrites the fixture.
fixtures() {
  rm -rf "$FIXTURES"
  mkdir -p "$FIXTURES"
  cat > "$FIXTURES/pr" <<JSON
{
  "headRefOid": "$head",
  "state": "OPEN",
  "mergeable": "MERGEABLE",
  "mergeStateStatus": "CLEAN",
  "statusCheckRollup": [
    {"name": "test", "workflowName": "CI", "status": "COMPLETED", "conclusion": "SUCCESS", "detailsUrl": "https://ci.example/1"}
  ]
}
JSON
}

run() {
  set +e
  output=$(bash "$script" 12 --repo acme/app --interval 0 "$@" 2>&1)
  status=$?
  set -e
}

calls() {
  if [ -e "$FIXTURES/calls" ]; then
    wc -l < "$FIXTURES/calls" | tr -d ' '
  else
    echo 0
  fi
}

fixtures
run --sha "$head"
check "the full head SHA exits 0" "$status" 0
check "it prints the check's result" "$(grep -c 'SUCCESS.*CI.*test' <<< "$output")" 1

fixtures
run --sha cc837ab
check "a 7-character prefix of the head exits 0" "$status" 0
check "it reports the full head" "$(grep -c "^head $head OPEN" <<< "$output")" 1

fixtures
run --sha CC837ABE0F
check "an upper-case prefix matches too" "$status" 0

fixtures
run --sha dd00000 --timeout 0
check "a prefix of another commit never returns this head's results" "$status" 3
check "it names both commits" "$(grep -c "PR head is still $head, expected dd00000" <<< "$output")" 1

fixtures
run --sha cc837
check "a prefix shorter than 7 characters is refused" "$status" 64
check "it is refused before any call to GitHub" "$(calls)" 0

fixtures
run --sha HEAD
check "a ref name is refused" "$status" 64
check "it says why" "$(grep -c 'is not a commit SHA' <<< "$output")" 1

fixtures
run --sha "${head}0"
check "more than 40 characters is refused" "$status" 64

fixtures
run
check "without --sha it follows the head it finds" "$status" 0

fixtures
jq '.statusCheckRollup[0].status = "IN_PROGRESS"' "$FIXTURES/pr" > "$FIXTURES/pr.tmp"
mv "$FIXTURES/pr.tmp" "$FIXTURES/pr"
run --sha cc837ab --timeout 0
check "a pending check on the pinned head times out" "$status" 3
check "it counts the pending check" "$(grep -c "1 of 1 checks pending on $head" <<< "$output")" 1

fixtures
touch "$FIXTURES/fail"
run --sha cc837ab
check "three GitHub CLI failures exit 4" "$status" 4

if [ "$failures" -ne 0 ]; then
  echo "wait-for-checks.test: failed" >&2
  exit 1
fi
echo "wait-for-checks.test: passed"
