#!/usr/bin/env bash
# Wait until an open release-please PR contains a merge commit, then print it.
# Run it in the foreground with the Bash tool's timeout raised to 600000, and
# hand each PR it prints to the harness's PR watcher.
#
# Usage: find-release-pr.sh <merge-sha> [--repo OWNER/REPO] [--branch RELEASE_BRANCH]
#          [--timeout SECONDS] [--settle SECONDS] [--interval SECONDS]
#
# A release PR counts when it is open against the release branch (default: the
# repository's default branch), carries the "autorelease: pending" label, and
# its head contains the merge commit. An older release PR without the merge is
# waited on, since release-please updates it. A multi-package repository can
# have several.
#
# Output, one line per release PR: <number> <url> <head sha>, tab-separated.
#
# Exit codes:
#   0  at least one release PR contains the merge
#   3  timed out (default 540 s, under the Bash tool's 10-minute limit): run it again
#   4  the GitHub CLI failed three times in a row (often authentication)
#   5  no release PR contains the merge, and the workflow runs its push started
#      finished --settle seconds ago (default 600), or it started none. The runs
#      are printed: <conclusion> <workflow> <url>. All passed means the merge
#      held nothing to release, or its release PR is already merged.
set -uo pipefail

merge=${1:?usage: find-release-pr.sh <merge-sha> [--repo OWNER/REPO] [--branch RELEASE_BRANCH] [--timeout SECONDS] [--settle SECONDS] [--interval SECONDS]}
shift
repo=""
branch=""
timeout=540
settle=600
interval=20

while [ $# -gt 0 ]; do
  case $1 in
    --repo) repo=$2; shift 2 ;;
    --branch) branch=$2; shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    --settle) settle=$2; shift 2 ;;
    --interval) interval=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [ -z "$repo" ]; then
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || exit 4
fi
if [ -z "$branch" ]; then
  branch=$(gh repo view "$repo" --json defaultBranchRef --jq .defaultBranchRef.name) || exit 4
fi

# "running", or the seconds since the push runs settled. With no run at all,
# the commit's own age stands in, so a push that starts no workflow still settles.
runs_age='if length == 0 then "none"
  elif any(.[]; .status != "completed") then "running"
  else (now - (map(.updatedAt | fromdateiso8601) | max) | floor | tostring) end'
runs_report='.[] | [(.conclusion // .status), .workflowName, .url] | @tsv'

start=$SECONDS
failures=0
found=""
age=""

# Counts a failed GitHub CLI call. Three in a row end the wait.
gh_failed() {
  failures=$((failures + 1))
  echo "$1 failed ($failures/3): $2" >&2
  if [ "$failures" -ge 3 ]; then
    exit 4
  fi
}

# Sets $found to the release PRs that contain the merge. Returns 1 when a call failed.
release_prs() {
  local prs number url head status
  found=""
  if ! prs=$(gh pr list --repo "$repo" --state open --base "$branch" --label "autorelease: pending" \
    --json number,url,headRefOid --jq '.[] | [.number, .url, .headRefOid] | @tsv' 2>&1); then
    gh_failed "gh pr list" "$prs"
    return 1
  fi
  while IFS=$'\t' read -r number url head; do
    [ -n "$number" ] || continue
    if ! status=$(gh api "repos/$repo/compare/$merge...$head" --jq .status 2>&1); then
      gh_failed "gh api compare" "$status"
      return 1
    fi
    case $status in
      ahead | identical) found+="$number"$'\t'"$url"$'\t'"$head"$'\n' ;;
    esac
  done <<< "$prs"
}

# Sets $age to "running", or to the seconds since the merge's push runs settled.
# Returns 1 when a call failed.
settled_for() {
  if ! age=$(gh run list --repo "$repo" --commit "$merge" --event push --limit 50 \
    --json status,updatedAt --jq "$runs_age" 2>&1); then
    gh_failed "gh run list" "$age"
    return 1
  fi
  if [ "$age" = none ]; then
    if ! age=$(gh api "repos/$repo/commits/$merge" \
      --jq '(now - (.commit.committer.date | fromdateiso8601)) | floor | tostring' 2>&1); then
      gh_failed "gh api commits" "$age"
      return 1
    fi
  fi
}

while :; do
  if release_prs; then
    if [ -n "$found" ]; then
      printf '%s' "$found"
      exit 0
    fi
    if settled_for; then
      failures=0
      if [ "$age" != running ] && [ "$age" -ge "$settle" ]; then
        echo "no open release PR on $branch contains $merge, ${age}s after its push runs finished:"
        gh run list --repo "$repo" --commit "$merge" --event push --limit 50 \
          --json conclusion,status,workflowName,url --jq "$runs_report"
        exit 5
      fi
    fi
  fi

  if [ $((SECONDS - start)) -ge "$timeout" ]; then
    echo "timed out after ${timeout}s: no open release PR on $branch contains $merge yet"
    exit 3
  fi

  sleep "$interval"
done
