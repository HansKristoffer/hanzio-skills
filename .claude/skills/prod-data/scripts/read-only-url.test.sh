#!/usr/bin/env bash
# Tests read-only-url.sh.
#
# Usage:
#   bash .claude/skills/prod-data/scripts/read-only-url.test.sh
#   TEST_DATABASE_URL=postgresql://... bash .claude/skills/prod-data/scripts/read-only-url.test.sh
#
# The URL rewriting runs everywhere. The probe cases need a Postgres you can
# write to in TEST_DATABASE_URL (a throwaway one) and psql; without them they
# are skipped. The script uses no git, so there is no scratch repository here.
set -euo pipefail

script="$(cd "$(dirname "$0")" && pwd)/read-only-url.sh"
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

run() {
  set +e
  output=$(bash "$script" "$@" 2>&1)
  status=$?
  set -e
}

printf 'postgresql://app:s3cret@db.internal:5432/app\n' > "$scratch/plain"
run "$scratch/plain" --no-probe
check "a URL without a query exits 0" "$status" 0
check "it gets ?options=" "$(cat "$scratch/plain.ro")" "postgresql://app:s3cret@db.internal:5432/app?options=-c%20default_transaction_read_only%3Don"
check "only the host is printed" "$output" "wrote $scratch/plain.ro for host db.internal"
check "the password never reaches the output" "$(grep -c s3cret <<< "$output" || true)" 0
check "the .ro file is private" "$(stat -c %a "$scratch/plain.ro" 2> /dev/null || stat -f %Lp "$scratch/plain.ro")" 600

printf 'postgres://app:pw@db.internal/app?sslmode=require\n' > "$scratch/query"
run "$scratch/query" --no-probe
check "a URL with a query gets &options=" "$(cat "$scratch/query.ro")" "postgres://app:pw@db.internal/app?sslmode=require&options=-c%20default_transaction_read_only%3Don"

printf 'postgres://app:pw@db/app?options=-c%%20search_path%%3Dx\n' > "$scratch/options"
run "$scratch/options" --no-probe
check "a URL that already sets options exits 2" "$status" 2

printf 'mysql://app:pw@db/app\n' > "$scratch/mysql"
run "$scratch/mysql" --no-probe
check "a non-Postgres URL exits 2" "$status" 2

run "$scratch/missing" --no-probe
check "a missing file exits 2" "$status" 2

if [ -n "${TEST_DATABASE_URL:-}" ] && command -v psql > /dev/null; then
  printf '%s\n' "$TEST_DATABASE_URL" > "$scratch/live"
  run "$scratch/live"
  check "the probe proves a read-only connection" "$status" 0
  check "and says Postgres refused the write" "$(grep -c 'refused the write' <<< "$output")" 1
else
  echo "skip: probe cases (set TEST_DATABASE_URL to a throwaway Postgres and install psql)"
fi

exit "$failures"
