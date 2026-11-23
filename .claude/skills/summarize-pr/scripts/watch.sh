#!/usr/bin/env bash
# Waits until a PR changes in a way that its page shows, then prints what changed and exits.
# Usage: watch.sh <out-dir> [<seconds between checks>]
# <out-dir> is the folder that gather.sh wrote for the current page. Run this script from the repo of the PR, in the
# background: it prints nothing while the PR stays the same, so it wakes the agent only when the page needs an update.
set -uo pipefail

out=${1:?Usage: watch.sh <out-dir> [<seconds between checks>]}
interval=${2:-120}
number=$(jq -r .number "$out/pr.json")
live="$out/.live"

# The parts of the PR that the page shows. AI reviewers start many threads that the page leaves out, so their threads
# do not count.
fingerprint() {
	jq -n --slurpfile pr "$1/pr.json" --slurpfile threads "$1/threads.json" --rawfile linked "$1/linked-prs.txt" \
		--rawfile description "$1/description.md" '{
		"head commit": $pr[0].headRefOid,
		"base branch": $pr[0].baseRefName,
		title: $pr[0].title,
		description: $description,
		"review threads": [$threads[0][] | select(.comments[0].author | endswith("[bot]") | not)
			| {path, line, isResolved, isOutdated, comments: [.comments[].url]}],
		"linked PRs": $linked
	}'
}

old=$(fingerprint "$out") || exit 1
failures=0
while true; do
	sleep "$interval"
	if ! bash "$(dirname "$0")/gather.sh" "$live" "$number" > "$live.log" 2>&1; then
		# One failed request (network, rate limit) must not end the watch, but a lasting failure (expired login) must.
		failures=$((failures + 1))
		if [ "$failures" -ge 5 ]; then
			echo "PR #$number: gather.sh failed $failures times in a row. See $live.log"
			exit 1
		fi
		continue
	fi
	failures=0

	state=$(jq -r .state "$live/pr.json")
	if [ "$state" != OPEN ]; then
		echo "PR #$number is $state. Stop watching."
		exit 0
	fi
	changed=$(jq -rn --argjson old "$old" --argjson new "$(fingerprint "$live")" \
		'[$old | keys_unsorted[] | select($old[.] != $new[.])] | join(", ")')
	if [ -n "$changed" ]; then
		echo "PR #$number changed: $changed. Run gather.sh again and update the page."
		exit 0
	fi
done
