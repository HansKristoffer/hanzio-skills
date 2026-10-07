#!/usr/bin/env bash
# Wait until every check on a pull request's head commit has finished, then
# print each check's result and the PR's mergeability. Run it as one
# background command and end the turn; the harness wakes the agent on exit.
#
# Usage: wait-for-checks.sh <pr> [--repo OWNER/REPO] [--sha HEAD_SHA] [--timeout SECONDS]
#
# Pass --sha after a push: GitHub can report the previous head for a few
# seconds, and without it the script would return that head's results.
#
# Exit codes:
#   0  every check finished (failures are listed in the output), or the PR is closed/merged
#   2  the PR head moved to another commit
#   3  timed out with checks still pending
#   4  the GitHub CLI failed three times in a row (often authentication)
#   5  no checks appeared on the head within five minutes
set -uo pipefail

pr=${1:?usage: wait-for-checks.sh <pr> [--repo OWNER/REPO] [--sha HEAD_SHA] [--timeout SECONDS]}
shift
repo=""
head=""
timeout=3600
interval=30

while [ $# -gt 0 ]; do
  case $1 in
    --repo) repo=$2; shift 2 ;;
    --sha) head=$2; shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [ -z "$repo" ]; then
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || exit 4
fi

fields=headRefOid,state,mergeable,mergeStateStatus,statusCheckRollup

# Check runs carry .status; commit statuses carry .state instead.
summary='"\(.headRefOid) \(.state) \(.statusCheckRollup | length) \([.statusCheckRollup[] | select(if .status then .status != "COMPLETED" else (.state == "PENDING" or .state == "EXPECTED") end)] | length)"'

report='"head \(.headRefOid) \(.state) mergeable=\(.mergeable) mergeState=\(.mergeStateStatus)",
  (.statusCheckRollup[] | "\(.conclusion // .state // .status)\t\(.workflowName // "")\t\(.name // .context)\t\(.detailsUrl // .targetUrl // "")")'

start=$SECONDS
failures=0
pending="?"
total="?"

while :; do
  elapsed=$((SECONDS - start))

  if line=$(gh pr view "$pr" --repo "$repo" --json "$fields" --jq "$summary" 2>&1); then
    failures=0
    read -r sha state total pending <<<"$line"

    if [ -z "$head" ]; then
      head=$sha
    fi

    if [ "$state" != OPEN ]; then
      gh pr view "$pr" --repo "$repo" --json "$fields" --jq "$report"
      exit 0
    fi

    if [ "$sha" != "$head" ]; then
      # Right after a push GitHub may still show the old head; give it two minutes.
      if [ "$elapsed" -ge 120 ]; then
        echo "PR head is $sha, expected $head"
        exit 2
      fi
    elif [ "$total" -gt 0 ] && [ "$pending" -eq 0 ]; then
      gh pr view "$pr" --repo "$repo" --json "$fields" --jq "$report"
      exit 0
    elif [ "$total" -eq 0 ] && [ "$elapsed" -ge 300 ]; then
      echo "no checks reported on $head after five minutes"
      exit 5
    fi
  else
    failures=$((failures + 1))
    echo "gh pr view failed ($failures/3): $line" >&2

    if [ "$failures" -ge 3 ]; then
      exit 4
    fi
  fi

  if [ "$elapsed" -ge "$timeout" ]; then
    if [ "${sha:-$head}" != "$head" ]; then
      echo "timed out after ${timeout}s; PR head is still $sha, expected $head"
    else
      echo "timed out after ${timeout}s with $pending of $total checks pending on $head"
    fi
    exit 3
  fi

  sleep "$interval"
done
