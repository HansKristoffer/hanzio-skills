#!/usr/bin/env bash
# Check a branch's changes for secrets and for moves that lower the quality floor:
# new suppressions, skipped or focused tests, softened CI, removed assertions, deleted tests.
#
# Usage:
#   bash check-diff.sh [--base <ref>]
#
# Compares the merge base with <ref> against the working tree: commits, staged and
# unstaged changes, and untracked files that are not ignored. Without --base it tries
# origin/HEAD, origin/main, origin/master, main and master. A local branch that is
# behind its origin counterpart is replaced by the origin ref, so commits that are
# already upstream are not reported.
#
# Output (stderr): one "[rule] file:line" per finding. The matched text is never
# printed, because it may be a secret.
#
# Rules:
#   secret             a credential-shaped string, or an added .env, key or certificate file
#   suppression        @ts-ignore, @ts-nocheck, bare @ts-expect-error, lint disables, `as any`
#   skip               .skip / .only / .todo / .fixme on tests, xit, fit and friends
#   ci-soften          continue-on-error: true or `|| true` in a workflow or action
#   assertion-removed  a test file loses more assertions than it gains
#   test-deleted       a test file is deleted
#
# Exit codes:
#   0  clean
#   1  at least one finding
#   2  could not run (not a git repository, no base, git failed)
set -uo pipefail

bail() {
  echo "check-diff: $1" >&2
  exit 2
}

usage() {
  sed -n '2,/^set -uo/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//' >&2
  exit 2
}

base=""
while [ $# -gt 0 ]; do
  case "$1" in
    --base)
      [ $# -ge 2 ] || bail "--base needs a ref"
      base=$2
      shift 2
      ;;
    -h | --help) usage ;;
    *) bail "unknown argument: $1" ;;
  esac
done

top=$(git rev-parse --show-toplevel 2> /dev/null) || bail "not a git repository"
cd "$top" || bail "cannot enter $top"

has_commit() {
  git rev-parse --verify --quiet "$1^{commit}" > /dev/null
}

if [ -z "$base" ]; then
  for ref in origin/HEAD origin/main origin/master main master; do
    if has_commit "$ref"; then
      base=$ref
      break
    fi
  done
  [ -n "$base" ] || bail "no base ref found; pass --base <ref>"
else
  has_commit "$base" || bail "unknown base ref: $base"
  # A local base behind its remote would pull upstream commits into the diff.
  if has_commit "origin/$base" && git merge-base --is-ancestor "$base" "origin/$base" 2> /dev/null; then
    base="origin/$base"
  fi
fi

merge_base=$(git merge-base "$base" HEAD 2> /dev/null) || bail "no merge base between $base and HEAD"

git_diff() {
  git -c core.quotePath=false diff --no-color --no-ext-diff -M \
    --src-prefix=a/ --dst-prefix=b/ "$@" "$merge_base" --
}

tmp=$(mktemp -d) || bail "cannot create a temporary directory"
trap 'rm -rf "$tmp"' EXIT
stream=$tmp/stream
: > "$stream"

# File-level records first: "#STATUS<TAB>A|D<TAB>path". A rename counts as an added new path.
names=$tmp/names
git_diff --name-status -z > "$names" || bail "cannot list changes against $merge_base"
while IFS= read -r -d '' status; do
  IFS= read -r -d '' path || break
  case "$status" in
    R* | C*)
      IFS= read -r -d '' path || break
      printf '#STATUS\tA\t%s\n' "$path" >> "$stream"
      ;;
    A*) printf '#STATUS\tA\t%s\n' "$path" >> "$stream" ;;
    D*) printf '#STATUS\tD\t%s\n' "$path" >> "$stream" ;;
  esac
done < "$names"

untracked=$tmp/untracked
git ls-files --others --exclude-standard -z > "$untracked" || bail "cannot list untracked files"
while IFS= read -r -d '' path; do
  printf '#STATUS\tA\t%s\n' "$path" >> "$stream"
done < "$untracked"

git_diff --unified=0 >> "$stream" || bail "cannot diff against $merge_base"

# Untracked files become synthetic all-added diffs. Binary files have no lines to check.
while IFS= read -r -d '' path; do
  [ -f "$path" ] || continue
  if [ -s "$path" ] && ! grep -Iq . "$path"; then
    continue
  fi
  awk -v f="$path" '
    BEGIN { print "diff --git a/" f " b/" f; print "--- /dev/null"; print "+++ b/" f; print "@@ -0,0 +1 @@" }
    { print "+" $0 }
  ' "$path" >> "$stream"
done < "$untracked"

read -r -d '' rules << 'AWK'
function rep(s, n,    r, i) { r = ""; for (i = 0; i < n; i++) r = r s; return r }
function is_code(f) { return f ~ /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts|vue|svelte|astro)$/ }
function is_test(f) {
  return f ~ /(^|\/)(test|tests|__tests__|e2e|spec)\// || f ~ /[._-](test|spec|e2e)\.[A-Za-z0-9]+$/
}
function is_workflow(f) { return f ~ /(^|\/)\.github\/workflows\/[^\/]+\.ya?ml$/ || f ~ /(^|\/)action\.ya?ml$/ }
function basename(f) { sub(/.*\//, "", f); return f }
function flag(rule, f, n) { print "[" rule "] " f ":" n }

function secret_file(f,    b) {
  b = basename(f)
  if (b ~ /^\.env(\..*)?$/ && b !~ /^\.env\.(example|sample|template)$/) return 1
  if (b ~ /\.(pem|key|p12|pfx)$/) return 1
  if (b ~ /^id_(rsa|dsa|ecdsa|ed25519)/ && b !~ /\.pub$/) return 1
  return 0
}

function placeholder(v) {
  v = tolower(v)
  return v ~ /example|placeholder|changeme|dummy|your|redacted|xxxx|\*\*\*\*|\$\{|<[a-z_-]+>/
}

function has_secret(t,    low, i) {
  for (i = 1; i <= nshape; i++) if (t ~ shape[i]) return 1
  low = tolower(t)
  if (match(low, quoted)) {
    if (!placeholder(substr(t, RSTART, RLENGTH))) return 1
  }
  if (match(t, envline)) {
    if (!placeholder(substr(t, RSTART, RLENGTH))) return 1
  }
  return 0
}

function has_suppression(t) {
  if (t ~ /@ts-ignore|@ts-nocheck|eslint-disable|biome-ignore|oxlint-disable/) return 1
  if (t ~ /@ts-expect-error[ \t]*(\*\/[ \t]*\}?[ \t]*)?$/) return 1
  if (t ~ ("(^|" NOT_ID ")as[ \t]+any(" NOT_ID "|$)")) return 1
  return 0
}

function has_skip(t) {
  if (t ~ ("(^|" NOT_ID ")(describe|it|test|suite|context|bench)(\\.[A-Za-z]+)*\\.(skip|only|todo|fixme)(" NOT_ID "|$)")) return 1
  if (t ~ ("(^|" NOT_ID_DOT ")(xit|xdescribe|xtest|xcontext|fit|fdescribe)[ \t]*\\(")) return 1
  return 0
}

function has_ci_soften(t) {
  if (t ~ /continue-on-error:[ \t]*["']?true/) return 1
  if (t ~ /\|\|[ \t]*(true|:)([ \t;)]|$)/) return 1
  return 0
}

function is_assertion(t) { return t ~ ("(^|" NOT_ID ")(expect|assert)[ \t]*[.(]") }

function added(f, n, t) {
  if (has_secret(t)) flag("secret", f, n)
  if (is_code(f)) {
    if (has_suppression(t)) flag("suppression", f, n)
    if (has_skip(t)) flag("skip", f, n)
    if (is_test(f) && is_assertion(t)) gained[f]++
  }
  if (is_workflow(f) && has_ci_soften(t)) flag("ci-soften", f, n)
}

function removed(f, n, t) {
  if (f in deleted) return
  if (is_code(f) && is_test(f) && is_assertion(t)) {
    lost[f]++
    if (!(f in first_lost)) first_lost[f] = n
  }
}

BEGIN {
  NOT_ID = "[^A-Za-z0-9_$]"
  NOT_ID_DOT = "[^A-Za-z0-9_$.]"
  ALNUM = "[A-Za-z0-9]"
  TOK = "[A-Za-z0-9_-]"
  nshape = 0
  shape[++nshape] = "-----BEGIN [A-Z ]*PRIVATE KEY"
  shape[++nshape] = "(AKIA|ASIA)" rep("[0-9A-Z]", 16)
  shape[++nshape] = "gh[pousr]_" rep(ALNUM, 36)
  shape[++nshape] = "github_pat_" rep("[A-Za-z0-9_]", 22)
  shape[++nshape] = "xox[abposr]-" rep("[A-Za-z0-9-]", 10)
  shape[++nshape] = "(sk|rk)_live_" rep(ALNUM, 16)
  shape[++nshape] = "sk-ant-" rep(TOK, 20)
  shape[++nshape] = "(^|[^A-Za-z0-9_-])sk-" rep(TOK, 20)
  VALUE = rep("[^\"' \t]", 16) "[^\"' \t]*"
  quoted = "(api[_-]?key|secret|token|password|passwd)[a-z0-9_-]*[\"']?[ \t]*[:=][ \t]*[\"']" VALUE "[\"']"
  quoted = "(" quoted "|bearer " rep("[a-z0-9._~+/-]", 20) ")"
  envline = "^[ \t]*(export[ \t]+)?[A-Z0-9_]*(KEY|SECRET|TOKEN|PASSWORD)[A-Z0-9_]*[ \t]*=[ \t]*" rep("[^ \t\"'$<{]", 16)
}

/^#STATUS\t/ {
  split($0, s, "\t")
  if (s[2] == "A" && secret_file(s[3])) flag("secret", s[3], 1)
  if (s[2] == "D") { deleted[s[3]] = 1; if (is_test(s[3])) flag("test-deleted", s[3], 1) }
  next
}
/^diff --git / { in_hunk = 0; old = ""; cur = ""; next }
!in_hunk && /^--- / { old = substr($0, 5); sub(/^a\//, "", old); next }
!in_hunk && /^\+\+\+ / {
  cur = substr($0, 5)
  if (cur == "/dev/null") cur = old
  else sub(/^b\//, "", cur)
  next
}
/^@@ / {
  in_hunk = 1
  if (match($0, /\+[0-9]+/)) pos = substr($0, RSTART + 1, RLENGTH - 1) + 0
  if (pos == 0) pos = 1
  next
}
in_hunk && /^\+/ { added(cur, pos, substr($0, 2)); pos++; next }
in_hunk && /^-/ { removed(cur, pos, substr($0, 2)); next }

END {
  for (f in lost) if (lost[f] > gained[f] + 0) flag("assertion-removed", f, first_lost[f])
}
AWK

findings=$tmp/findings
LC_ALL=C awk "$rules" "$stream" > "$findings" || bail "cannot scan the diff"

# gitleaks, when installed, also scans the branch's commits with its own rules.
if command -v gitleaks > /dev/null 2>&1 && [ "$(git rev-list --count "$merge_base..HEAD")" -gt 0 ]; then
  report=$tmp/gitleaks.json
  if gitleaks git --no-banner --log-opts="$merge_base..HEAD" --report-format json \
    --report-path "$report" --exit-code 0 . > /dev/null 2>&1 \
    || gitleaks detect --no-banner --source . --log-opts="$merge_base..HEAD" --report-format json \
      --report-path "$report" --exit-code 0 > /dev/null 2>&1; then
    awk '
      /"StartLine":/ { line = $2; sub(/,$/, "", line) }
      /"File":/ { f = $0; sub(/^[^:]*:[ \t]*"/, "", f); sub(/",?[ \t]*$/, "", f); print "[secret] " f ":" line }
    ' "$report" >> "$findings"
  else
    echo "check-diff: gitleaks failed, so only the built-in secret patterns ran" >&2
  fi
fi

count=$(sort -u "$findings" | tee "$tmp/sorted" | wc -l | tr -d ' ')
if [ "$count" -gt 0 ]; then
  cat "$tmp/sorted" >&2
  echo "check-diff: $count finding(s) against $base" >&2
  exit 1
fi
echo "check-diff: clean against $base" >&2
exit 0
