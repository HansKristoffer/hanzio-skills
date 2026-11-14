#!/usr/bin/env bash
# Tests find-release-pr.sh against a stub `gh` that serves fixture JSON.
#
# Usage:
#   bash .claude/skills/land-pr/scripts/find-release-pr.test.sh
#
# The script reads only the GitHub API (no local git), so the fixtures stand in
# for the release PRs, compare results and workflow runs a real repository
# returns. A fixture file `<name>.<n>` answers the n-th call for that name, and
# the highest one keeps answering after that, so release-please can update its
# PR between polls.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/find-release-pr.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

mkdir -p "$scratch/bin"
cat > "$scratch/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Stub: the last argument is the --jq expression; the fixture is named after the call.
echo "$*" >> "$FIXTURES/calls"
[ ! -e "$FIXTURES/fail" ] || { echo "HTTP 502" >&2; exit 1; }
case "$1 $2" in
  "pr list") name=pr_list ;;
  "run list") name=run_list ;;
  "repo view") name=repo ;;
  api\ *) name=$(printf '%s' "$2" | tr '/?=&.' '_____') ;;
  *) echo "stub gh: unexpected $*" >&2; exit 1 ;;
esac
count_file="$FIXTURES/.count-$name"
count=$(( $(cat "$count_file" 2> /dev/null || echo 0) + 1 ))
echo "$count" > "$count_file"
file=""
for n in $(seq "$count" -1 1); do
  if [ -e "$FIXTURES/$name.$n" ]; then file="$FIXTURES/$name.$n"; break; fi
done
[ -n "$file" ] || file="$FIXTURES/$name"
[ -e "$file" ] || { echo "stub gh: no fixture $name" >&2; exit 1; }
jq -r "${*: -1}" "$file"
EOF
chmod +x "$scratch/bin/gh"
export PATH="$scratch/bin:$PATH"
export FIXTURES="$scratch/fixtures"

repo=acme/app
merge=aaaa1111
compare="repos_acme_app_compare_${merge}___"
failures=0

check() {
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 (expected $3, got $2)" >&2
    failures=1
  fi
}

# Every scenario starts with no release PR, and a release-please run and a CI
# run that finished long ago.
fixtures() {
  rm -rf "$FIXTURES"
  mkdir -p "$FIXTURES"
  echo '{"nameWithOwner": "acme/app", "defaultBranchRef": {"name": "main"}}' > "$FIXTURES/repo"
  echo '[]' > "$FIXTURES/pr_list"
  cat > "$FIXTURES/run_list" <<'JSON'
[
  {"status": "completed", "conclusion": "success", "workflowName": "release-please", "updatedAt": "2020-01-01T00:00:00Z", "url": "https://ci.example/1"},
  {"status": "completed", "conclusion": "failure", "workflowName": "CI", "updatedAt": "2020-01-01T00:05:00Z", "url": "https://ci.example/2"}
]
JSON
}

release_pr() {
  printf '[{"number": %s, "url": "https://github.com/acme/app/pull/%s", "headRefOid": "%s"}]\n' "$1" "$1" "$2"
}

run() {
  set +e
  output=$(bash "$script" "$merge" --repo "$repo" --branch main --interval 0 "$@" 2>&1)
  status=$?
  set -e
}

fixtures
release_pr 17 bbbb2222 > "$FIXTURES/pr_list"
echo '{"status": "ahead"}' > "$FIXTURES/${compare}bbbb2222"
run
check "a release PR that contains the merge exits 0" "$status" 0
check "it prints the number, url and head" "$output" "$(printf '17\thttps://github.com/acme/app/pull/17\tbbbb2222')"

fixtures
release_pr 17 0000old0 > "$FIXTURES/pr_list.1"
release_pr 17 bbbb2222 > "$FIXTURES/pr_list.3"
echo '{"status": "diverged"}' > "$FIXTURES/${compare}0000old0"
echo '{"status": "identical"}' > "$FIXTURES/${compare}bbbb2222"
jq '.[0].status = "in_progress"' "$FIXTURES/run_list" > "$FIXTURES/run_list.1"
run
check "an older release PR is waited on until release-please updates it" "$status" 0
check "it prints the updated head only" "$output" "$(printf '17\thttps://github.com/acme/app/pull/17\tbbbb2222')"

fixtures
cat > "$FIXTURES/pr_list" <<'JSON'
[
  {"number": 17, "url": "https://github.com/acme/app/pull/17", "headRefOid": "bbbb2222"},
  {"number": 18, "url": "https://github.com/acme/app/pull/18", "headRefOid": "cccc3333"},
  {"number": 19, "url": "https://github.com/acme/app/pull/19", "headRefOid": "0000old0"}
]
JSON
echo '{"status": "ahead"}' > "$FIXTURES/${compare}bbbb2222"
echo '{"status": "ahead"}' > "$FIXTURES/${compare}cccc3333"
echo '{"status": "behind"}' > "$FIXTURES/${compare}0000old0"
run
check "a multi-package repository prints each release PR with the merge" "$(wc -l <<< "$output" | tr -d ' ')" 2
check "it leaves out the one without it" "$(grep -c '^19' <<< "$output" || true)" 0

fixtures
run
check "no release PR long after the push runs finished exits 5" "$status" 5
check "it prints the runs with their conclusions" "$(grep -c "$(printf 'failure\tCI\thttps://ci.example/2')" <<< "$output")" 1

fixtures
jq --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '.[1].updatedAt = $now' "$FIXTURES/run_list" > "$FIXTURES/run_list.1"
run --timeout 0
check "runs that only just finished are still waited on" "$status" 3

fixtures
jq '.[0].status = "in_progress" | .[0].conclusion = null' "$FIXTURES/run_list" > "$FIXTURES/run_list.1"
run --timeout 0
check "a run still in progress times out instead of settling" "$status" 3
check "it says to keep waiting" "$(grep -c 'timed out after 0s' <<< "$output")" 1

fixtures
echo '[]' > "$FIXTURES/run_list"
echo '{"commit": {"committer": {"date": "2020-01-01T00:00:00Z"}}}' > "$FIXTURES/repos_acme_app_commits_${merge}"
run
check "a push that started no workflow settles on the commit's age" "$status" 5

fixtures
echo '[]' > "$FIXTURES/run_list"
jq -n --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '{commit: {committer: {date: $now}}}' > "$FIXTURES/repos_acme_app_commits_${merge}"
run --timeout 0
check "a fresh merge with no runs yet is waited on" "$status" 3

fixtures
set +e
output=$(bash "$script" "$merge" --interval 0 2>&1)
status=$?
set -e
check "without --repo and --branch it asks the repository" "$status" 5
check "it lists release PRs on the default branch" "$(grep -c -- '^pr list --repo acme/app --state open --base main ' "$FIXTURES/calls")" 1

fixtures
touch "$FIXTURES/fail"
run
check "three GitHub CLI failures exit 4" "$status" 4
check "it stops after the third" "$(grep -c '^pr list' "$FIXTURES/calls")" 3

if [ "$failures" -ne 0 ]; then
  echo "find-release-pr.test: failed" >&2
  exit 1
fi
echo "find-release-pr.test: passed"
