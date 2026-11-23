#!/usr/bin/env bash
# Runs gather.sh against a scratch repository with a deleted test file, a renamed test file and a local base branch
# behind its remote, with a fake gh that answers from that repository.
# Usage: bash gather.test.sh
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

fail() {
	echo "FAIL: $1" >&2
	exit 1
}

git init -q --bare "$scratch/origin.git"
git clone -q "$scratch/origin.git" "$scratch/repo" 2> /dev/null
cd "$scratch/repo"
git config user.email test@example.com
git config user.name Test
git checkout -q -b main
mkdir -p src
cat > src/old.test.ts <<'EOF'
import { it } from "bun:test"

it("keeps the old behavior", () => {})
EOF
cat > src/moved.test.ts <<'EOF'
import { it } from "bun:test"

it("survives a rename", () => {})
EOF
echo 'export const a = 1' > src/a.ts
git add -A
git commit -q -m base
git push -q origin main 2> /dev/null

# The remote's main moves on, and the local main stays behind it.
git checkout -q -b other
echo 'export const b = 2' > src/b.ts
git add -A
git commit -q -m "newer base"
git push -q origin other:main 2> /dev/null
git checkout -q main
git branch -q -D other
git fetch -q origin

git checkout -q -b feature origin/main
git rm -q src/old.test.ts
git mv src/moved.test.ts src/renamed.test.ts
echo 'export const a = 3' > src/a.ts
git add -A
git commit -q -m feature
head_sha=$(git rev-parse HEAD)
[ "$(git rev-list --count main..origin/main)" = 1 ] || fail "the local main is not behind origin/main"

fake="$scratch/fake"
mkdir -p "$fake/bin"
jq -n --arg head "$head_sha" '{
	number: 7, title: "Change a", url: "https://github.com/acme/app/pull/7", state: "OPEN",
	author: { login: "me" }, baseRefName: "main", headRefName: "feature", headRefOid: $head,
	additions: 1, deletions: 4, changedFiles: 3,
	body: "> [!TIP]\n> Review [the summary of this PR](http://factory:4400/overview/abc)\n\nMakes a three. Builds on #3."
}' > "$fake/pr.json"
jq -n '{ files: [{ path: "src/a.ts", additions: 1, deletions: 1 }, { path: "src/old.test.ts", additions: 0, deletions: 3 }] }' \
	> "$fake/files.json"
jq -n '{ data: { repository: { pullRequest: { reviewThreads: { totalCount: 2, nodes: [
	{ path: "src/a.ts", line: 1, startLine: null, diffSide: "RIGHT", isResolved: false, isOutdated: false,
		comments: { nodes: [{ author: { __typename: "User", login: "alice", avatarUrl: null }, body: "Why 3?", url: "https://github.com/acme/app/pull/7#r1" }] } },
	{ path: "src/a.ts", line: 1, startLine: null, diffSide: "RIGHT", isResolved: false, isOutdated: false,
		comments: { nodes: [{ author: { __typename: "Bot", login: "reviewer", avatarUrl: null }, body: "Nit.", url: "https://github.com/acme/app/pull/7#r2" }] } }
] } } } } }' > "$fake/graphql.json"

cat > "$fake/bin/gh" <<EOF
#!/usr/bin/env bash
# Answers the gh calls gather.sh makes, from canned JSON and the scratch repository.
filter=""
args=("\$@")
for i in "\${!args[@]}"; do
	[ "\${args[\$i]}" = --jq ] && filter=\${args[\$((i + 1))]}
done
case "\$1 \$2" in
	"pr view")
		if [[ " \$* " == *" -R "* ]]; then out='{"state":"MERGED","url":"https://github.com/acme/app/pull/3","title":"Earlier"}'
		elif [[ " \$* " == *" files"* ]]; then out=\$(cat "$fake/files.json")
		else out=\$(cat "$fake/pr.json"); fi ;;
	"pr diff") git -C "$scratch/repo" diff -M origin/main...feature; exit ;;
	"api graphql") out=\$(cat "$fake/graphql.json") ;;
	"api user") out='{"login":"me"}' ;;
	*) echo "fake gh: unexpected call: \$*" >&2; exit 1 ;;
esac
if [ -n "\$filter" ]; then jq -r "\$filter" <<< "\$out"; else printf '%s\n' "\$out"; fi
EOF
chmod +x "$fake/bin/gh"

out="$scratch/out"
log=$(PATH="$fake/bin:$PATH" bash "$here/gather.sh" "$out" 7) || fail "gather.sh failed: $log"

[ "$(cat "$out/description.md")" = "Makes a three. Builds on #3." ] || fail "description.md kept the summary link: $(cat "$out/description.md")"
grep -q "Summary link in the description: yes" <<< "$log" || fail "the summary link was not seen: $log"
grep -q $'^src/old.test.ts\t3\tkeeps the old behavior$' "$out/removed-tests.txt" || fail "removed-tests.txt misses the deleted test: $(cat "$out/removed-tests.txt")"
! grep -q "survives a rename" "$out/removed-tests.txt" || fail "a renamed test counts as removed"
[ "$(jq -r '[.[] | select(.startedByHuman)] | length' "$out/threads.json")" = 1 ] || fail "the human thread was not told from the bot thread"
[ "$(jq -r '.[1].comments[0].author' "$out/threads.json")" = "reviewer[bot]" ] || fail "a bot author has no [bot] suffix"
grep -q "MERGED https://github.com/acme/app/pull/3" "$out/linked-prs.txt" || fail "the linked PR's state is missing"
[ ! -s "$out/preview-url.txt" ] || fail "preview-url.txt is not empty"
! grep -q "warning: the local HEAD" <<< "$log" || fail "warned about the HEAD although it is the PR head"
grep -q "src/a.ts" "$out/full.diff" || fail "full.diff is missing the changed file"

echo "gather.test.sh: all passed"
