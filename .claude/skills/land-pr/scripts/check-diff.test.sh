#!/usr/bin/env bash
# Tests for check-diff.sh. Each case builds a scratch repository.
# Runs the whole suite once per awk found (gawk, mawk, nawk, BSD awk).
#
# Usage:
#   bash check-diff.test.sh
set -uo pipefail

script="$(cd "$(dirname "$0")" && pwd)/check-diff.sh"
root=$(mktemp -d)
trap 'rm -rf "$root"' EXIT

failures=0
cases=0
out=""
code=0

# Secret-shaped values are assembled at runtime so this file never matches them itself.
aws_key="AKIA""Q7L2M4N8P0R3S5T6"
gh_token="ghp_""$(printf 'a%.0s' $(seq 36))"
anthropic_key="sk-ant-""api03-$(printf 'b%.0s' $(seq 24))"
pem_header="-----BEGIN ""RSA PRIVATE KEY-----"
quoted_key="api_""key = \"$(printf 'c%.0s' $(seq 24))\""
env_line="STRIPE_""SECRET_KEY=$(printf 'd%.0s' $(seq 24))"

fail() {
  echo "  FAIL [$awk_name] $current: $1" >&2
  printf '%s\n' "$out" | sed 's/^/    | /' >&2
  failures=$((failures + 1))
}

expect_exit() {
  [ "$code" -eq "$1" ] || fail "expected exit $1, got $code"
}

expect_has() {
  printf '%s\n' "$out" | grep -qF -- "$1" || fail "expected output to contain: $1"
}

expect_lacks() {
  if printf '%s\n' "$out" | grep -qF -- "$1"; then
    fail "expected output not to contain: $1"
  fi
}

run() {
  out=$(cd "$repo" && PATH="$awk_path" bash "$script" "$@" 2>&1)
  code=$?
}

start() {
  current=$1
  cases=$((cases + 1))
  repo="$root/$awk_name-$cases"
  mkdir -p "$repo"
  git -C "$repo" init -q -b main
  git -C "$repo" config user.email test@example.com
  git -C "$repo" config user.name test
  git -C "$repo" config commit.gpgsign false
  mkdir -p "$repo/src"
  printf 'export const one = 1\n' > "$repo/src/base.ts"
  printf 'node_modules\nignored.txt\n' > "$repo/.gitignore"
  git -C "$repo" add -A
  git -C "$repo" commit -qm base
  git -C "$repo" switch -qc feature
}

commit_all() {
  git -C "$repo" add -A
  git -C "$repo" commit -qm change
}

suite() {
  start "clean diff"
  printf 'export const two = 2\nexport function add(a: number, b: number) {\n  return a + b\n}\n' > "$repo/src/add.ts"
  commit_all
  run --base main
  expect_exit 0
  expect_has "check-diff: clean against main"

  start "secret shapes, with line numbers and no matched text"
  printf 'const a = 1\nconst aws = "%s"\n' "$aws_key" > "$repo/src/config.ts"
  printf 'token: %s\n' "$gh_token" > "$repo/notes.md"
  printf '%s\n' "$pem_header" > "$repo/docs.txt"
  printf 'x\ny\nkey = "%s"\n' "$anthropic_key" > "$repo/src/ai.py"
  printf '%s\n' "$quoted_key" > "$repo/src/generic.ts"
  printf '%s\n' "$env_line" > "$repo/deploy.sh"
  commit_all
  run --base main
  expect_exit 1
  expect_has "[secret] src/config.ts:2"
  expect_has "[secret] notes.md:1"
  expect_has "[secret] docs.txt:1"
  expect_has "[secret] src/ai.py:3"
  expect_has "[secret] src/generic.ts:1"
  expect_has "[secret] deploy.sh:1"
  expect_lacks "$aws_key"
  expect_lacks "$gh_token"

  start "placeholders and short values are not secrets"
  printf 'api_key = "your-api-key-goes-here-123"\npassword = "short"\nconst tokenCount = 4\n' > "$repo/src/ok.ts"
  # shellcheck disable=SC2016 # the literal text is the point
  printf 'STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY}\n' > "$repo/env.sh"
  commit_all
  run --base main
  expect_exit 0

  start "secret files"
  printf 'A=1\n' > "$repo/.env"
  printf 'A=\n' > "$repo/.env.example"
  mkdir -p "$repo/certs"
  printf 'x\n' > "$repo/certs/server.pem"
  printf 'ssh-ed25519 AAAA\n' > "$repo/id_ed25519.pub"
  git -C "$repo" add -f .env
  commit_all
  run --base main
  expect_exit 1
  expect_has "[secret] .env:1"
  expect_has "[secret] certs/server.pem:1"
  expect_lacks ".env.example"
  expect_lacks "id_ed25519.pub"

  start "suppressions"
  cat > "$repo/src/types.ts" << 'TS'
// @ts-ignore
const a = b as any
// @ts-expect-error
const c = 1
// @ts-expect-error the vendor types miss this overload
const d = 2
const e = f as anything
// eslint-disable-next-line no-console
/* biome-ignore lint: reason */
// oxlint-disable
TS
  # shellcheck disable=SC2016 # the literal text is the point
  printf 'Never write `as any` or @ts-ignore in code.\n' > "$repo/README.md"
  commit_all
  run --base main
  expect_exit 1
  expect_has "[suppression] src/types.ts:1"
  expect_has "[suppression] src/types.ts:2"
  expect_has "[suppression] src/types.ts:3"
  expect_lacks "[suppression] src/types.ts:5"
  expect_lacks "[suppression] src/types.ts:7"
  expect_has "[suppression] src/types.ts:8"
  expect_has "[suppression] src/types.ts:9"
  expect_has "[suppression] src/types.ts:10"
  expect_lacks "README.md"

  start "skipped and focused tests"
  cat > "$repo/src/a.test.ts" << 'TS'
it.skip('one', () => {})
test.only('two', () => {})
describe.skip('three', () => {})
test.describe.only('four', () => {})
xit('five', () => {})
fit('six', () => {})
it.todo('seven')
test.fixme('eight', () => {})
const rest = items.skipWhile(Boolean)
const parts = value.split(',')
it('nine', () => {})
TS
  commit_all
  run --base main
  expect_exit 1
  for n in 1 2 3 4 5 6 7 8; do expect_has "[skip] src/a.test.ts:$n"; done
  for n in 9 10 11; do expect_lacks "[skip] src/a.test.ts:$n"; done

  start "softened CI"
  mkdir -p "$repo/.github/workflows" "$repo/config"
  cat > "$repo/.github/workflows/ci.yml" << 'YML'
jobs:
  test:
    continue-on-error: true
    steps:
      - run: bun test || true
      - run: bun run lint
YML
  printf 'continue-on-error: true\n' > "$repo/config/other.yml"
  commit_all
  run --base main
  expect_exit 1
  expect_has "[ci-soften] .github/workflows/ci.yml:3"
  expect_has "[ci-soften] .github/workflows/ci.yml:5"
  expect_lacks "[ci-soften] .github/workflows/ci.yml:6"
  expect_lacks "config/other.yml"

  start "removed assertions"
  git -C "$repo" switch -q main
  printf "it('a', () => {\n  expect(a).toBe(1)\n  expect(b).toBe(2)\n  expect(c).toBe(3)\n})\n" > "$repo/src/x.test.ts"
  printf "it('a', () => {\n  expect(a).toBe(1)\n})\n" > "$repo/src/moved.test.ts"
  commit_all
  git -C "$repo" switch -qc feature-assert
  printf "it('a', () => {\n  expect(a).toBe(1)\n})\n" > "$repo/src/x.test.ts"
  printf "it('a', () => {\n  const value = a\n  expect(value).toBe(1)\n})\n" > "$repo/src/moved.test.ts"
  commit_all
  run --base main
  expect_exit 1
  expect_has "[assertion-removed] src/x.test.ts:"
  expect_lacks "moved.test.ts"

  start "deleted files"
  git -C "$repo" switch -q main
  printf "it('a', () => {\n  expect(a).toBe(1)\n})\n" > "$repo/src/gone.test.ts"
  commit_all
  git -C "$repo" switch -qc feature-delete
  git -C "$repo" rm -q src/gone.test.ts src/base.ts
  commit_all
  run --base main
  expect_exit 1
  expect_has "[test-deleted] src/gone.test.ts:1"
  expect_lacks "[assertion-removed]"
  expect_lacks "src/base.ts"

  start "unstaged deletion"
  git -C "$repo" switch -q main
  printf "it('a', () => {})\n" > "$repo/src/later.test.ts"
  commit_all
  git -C "$repo" switch -qc feature-unstaged
  rm "$repo/src/later.test.ts"
  run --base main
  expect_exit 1
  expect_has "[test-deleted] src/later.test.ts:1"

  start "renamed files"
  git -C "$repo" switch -q main
  printf "it('a', () => {\n  expect(a).toBe(1)\n})\n" > "$repo/src/old.test.ts"
  printf 'A=\n' > "$repo/.env.example"
  commit_all
  git -C "$repo" switch -qc feature-rename
  git -C "$repo" mv src/old.test.ts src/new.test.ts
  git -C "$repo" mv .env.example .env
  git -C "$repo" add -f .env
  commit_all
  run --base main
  expect_exit 1
  expect_has "[secret] .env:1"
  expect_lacks "test-deleted"
  expect_lacks "assertion-removed"

  start "untracked, ignored, binary and spaced paths, unstaged edits"
  printf 'const x = y as any\n' > "$repo/src/new file.ts"
  printf '%s\n' "$aws_key" > "$repo/ignored.txt"
  printf '\000\001\002' > "$repo/src/blob.bin"
  printf 'export const one = 1\n// @ts-ignore\n' > "$repo/src/base.ts"
  run --base main
  expect_exit 1
  expect_has "[suppression] src/new file.ts:1"
  expect_has "[suppression] src/base.ts:2"
  expect_lacks "ignored.txt"
  expect_lacks "blob.bin"

  start "local base behind its remote"
  origin="$root/$awk_name-$cases-origin.git"
  other="$root/$awk_name-$cases-other"
  git -C "$repo" switch -q main
  git init -q --bare "$origin"
  git -C "$repo" remote add origin "$origin"
  git -C "$repo" push -q origin main
  git -C "$root" clone -q "$origin" "$other"
  git -C "$other" config user.email test@example.com
  git -C "$other" config user.name test
  git -C "$other" config commit.gpgsign false
  printf 'const upstream = value as any\n' > "$other/src/upstream.ts"
  git -C "$other" add -A
  git -C "$other" commit -qm upstream
  git -C "$other" push -q origin main
  git -C "$repo" fetch -q origin
  git -C "$repo" branch -qD feature
  git -C "$repo" switch -qc feature origin/main
  printf 'export const mine = 1\n' > "$repo/src/mine.ts"
  commit_all
  run --base main
  expect_exit 0
  expect_has "clean against origin/main"
  git -C "$repo" remote set-head origin main > /dev/null
  run
  expect_exit 0
  expect_has "clean against origin/HEAD"

  start "cannot run"
  run --base does-not-exist
  expect_exit 2
  out=$(cd "$root" && PATH="$awk_path" bash "$script" 2>&1)
  code=$?
  expect_exit 2
  expect_has "not a git repository"
}

ran=0
bin="$root/bin"
mkdir -p "$bin"
for candidate in gawk mawk nawk original-awk /usr/bin/awk; do
  impl=$(command -v "$candidate" 2> /dev/null) || continue
  awk_name=$(basename "$candidate")
  [ "$candidate" = /usr/bin/awk ] && awk_name=system-awk
  rm -f "$bin/awk"
  ln -s "$impl" "$bin/awk"
  awk_path="$bin:$PATH"
  suite
  ran=$((ran + 1))
done

if [ "$ran" -eq 0 ]; then
  echo "check-diff.test: no awk found" >&2
  exit 1
fi
if [ "$failures" -gt 0 ]; then
  echo "check-diff.test: $failures failure(s) in $cases cases" >&2
  exit 1
fi
echo "check-diff.test: $cases cases passed across $ran awk implementation(s)"
