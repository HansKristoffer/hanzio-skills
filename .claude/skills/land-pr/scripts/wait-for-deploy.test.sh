#!/usr/bin/env bash
# Tests wait-for-deploy.sh against a stub `gh` that serves fixture JSON.
#
# Usage:
#   bash .claude/skills/land-pr/scripts/wait-for-deploy.test.sh
#
# The script reads only the GitHub API (no local git), so the fixtures stand in
# for the deployments, statuses and compare results a real repository returns.
# A fixture file `<name>.<n>` answers the n-th call for that path, and the
# highest one keeps answering after that, so a deployment can move from
# in_progress to success between polls.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/wait-for-deploy.sh"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

mkdir -p "$scratch/bin"
cat > "$scratch/bin/gh" <<'EOF'
#!/usr/bin/env bash
# Stub: gh api <path> --jq <expr>. Fixtures live in $FIXTURES, named after the path.
[ "$1" = api ] || { echo "stub gh: unexpected $*" >&2; exit 1; }
[ ! -e "$FIXTURES/fail" ] || { echo "HTTP 502" >&2; exit 1; }
name=$(printf '%s' "$2" | tr '/?=&.' '_____')
count_file="$FIXTURES/.count-$name"
count=$(( $(cat "$count_file" 2> /dev/null || echo 0) + 1 ))
echo "$count" > "$count_file"
file=""
for n in $(seq "$count" -1 1); do
  if [ -e "$FIXTURES/$name.$n" ]; then file="$FIXTURES/$name.$n"; break; fi
done
[ -n "$file" ] || file="$FIXTURES/$name"
[ -e "$file" ] || { echo "stub gh: no fixture $name" >&2; exit 1; }
jq -r "$4" "$file"
EOF
chmod +x "$scratch/bin/gh"
export PATH="$scratch/bin:$PATH"

repo=acme/app
merge=aaaa1111
prefix="repos_acme_app"
failures=0

check() {
  if [ "$2" = "$3" ]; then
    echo "ok: $1"
  else
    echo "FAIL: $1 (expected $3, got $2)" >&2
    failures=1
  fi
}

# Every scenario: a preview environment that must be ignored, an older production
# deployment from before the merge, and the newest production deployment after it.
fixtures() {
  rm -rf "$scratch/fixtures"
  mkdir -p "$scratch/fixtures"
  export FIXTURES="$scratch/fixtures"
  cat > "$FIXTURES/${prefix}_deployments_per_page_50" <<'JSON'
[
  {"id": 3, "environment": "Preview - web", "sha": "cccc3333"},
  {"id": 2, "environment": "app / production", "sha": "bbbb2222"},
  {"id": 1, "environment": "app / production", "sha": "0000old0"}
]
JSON
  echo '{"status": "ahead"}' > "$FIXTURES/${prefix}_compare_${merge}___bbbb2222"
  echo '{"status": "behind"}' > "$FIXTURES/${prefix}_compare_${merge}___0000old0"
  echo '{"status": "ahead"}' > "$FIXTURES/${prefix}_compare_${merge}___cccc3333"
  echo '[{"state": "success", "environment_url": "https://old.example"}]' > "$FIXTURES/${prefix}_deployments_1_statuses_per_page_1"
}

run() {
  set +e
  output=$(bash "$script" "$merge" --repo "$repo" --interval 0 "$@" 2>&1)
  status=$?
  set -e
}

fixtures
echo '[{"state": "in_progress"}]' > "$FIXTURES/${prefix}_deployments_2_statuses_per_page_1.1"
echo '[{"state": "success", "environment_url": "https://app.example"}]' > "$FIXTURES/${prefix}_deployments_2_statuses_per_page_1.3"
run
check "a deployment that goes from in progress to success exits 0" "$status" 0
check "it reports the newer deployment, not the older one" "$output" "$(printf 'success\tapp / production\tbbbb2222\thttps://app.example')"

fixtures
echo '[{"state": "failure", "log_url": "https://logs.example"}]' > "$FIXTURES/${prefix}_deployments_2_statuses_per_page_1"
run
check "a failed deployment exits 1" "$status" 1
check "it prints the log url" "$(grep -c 'failure.*https://logs.example' <<< "$output")" 1

fixtures
echo '[{"state": "success", "environment_url": "https://preview.example"}]' > "$FIXTURES/${prefix}_deployments_3_statuses_per_page_1"
run --environment 'preview'
check "--environment picks the preview environment instead" "$status" 0
check "and reports only that environment" "$(cut -f2 <<< "$output")" "Preview - web"

fixtures
echo '{"status": "behind"}' > "$FIXTURES/${prefix}_compare_${merge}___bbbb2222"
run --appear 0
check "no deployment containing the merge exits 5" "$status" 5

fixtures
echo '[]' > "$FIXTURES/${prefix}_deployments_2_statuses_per_page_1"
run --timeout 0
check "a deployment with no status yet times out with exit 3" "$status" 3
check "the timeout lists it as pending" "$(grep -c '^pending' <<< "$output")" 1

fixtures
touch "$FIXTURES/fail"
run
check "three failed gh calls in a row exit 4" "$status" 4

exit "$failures"
