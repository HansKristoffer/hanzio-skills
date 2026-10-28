#!/usr/bin/env bash
# Wait until every deployment that contains a merge commit has finished, then
# print each one's result. Reads GitHub deployments, which Railway, Vercel and
# deploy workflows create. Run it as one background command and end the turn;
# the harness wakes the agent on exit.
#
# Usage: wait-for-deploy.sh <merge-sha> [--repo OWNER/REPO] [--environment REGEX]
#          [--timeout SECONDS] [--appear SECONDS] [--interval SECONDS]
#
# --environment is an extended regex, matched case-insensitively against the
# deployment environment's name (default: production). A deployment counts
# when its commit is the merge commit or comes after it, since providers often
# skip ahead to the newest commit on the branch.
#
# Output, one line per environment: <state> <environment> <commit> <url>, tab-separated.
#
# Exit codes:
#   0  every matching environment deployed a commit containing the merge, successfully
#   1  at least one of them ended in failure, error or inactive (superseded or rolled back)
#   3  timed out with a deployment still running
#   4  the GitHub CLI failed three times in a row (often authentication)
#   5  no matching deployment containing the merge appeared within --appear seconds
set -uo pipefail

merge=${1:?usage: wait-for-deploy.sh <merge-sha> [--repo OWNER/REPO] [--environment REGEX] [--timeout SECONDS] [--appear SECONDS] [--interval SECONDS]}
shift
repo=""
environments=production
timeout=1800
appear=900
interval=30

while [ $# -gt 0 ]; do
  case $1 in
    --repo) repo=$2; shift 2 ;;
    --environment) environments=$2; shift 2 ;;
    --timeout) timeout=$2; shift 2 ;;
    --appear) appear=$2; shift 2 ;;
    --interval) interval=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 64 ;;
  esac
done

if [ -z "$repo" ]; then
  repo=$(gh repo view --json nameWithOwner --jq .nameWithOwner) || exit 4
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
touch "$work/contains"

failures=0
gh_failed() {
  failures=$((failures + 1))
  echo "gh failed ($failures/3): $1" >&2
  [ "$failures" -lt 3 ] || exit 4
}

# Sets answer to yes or no: does commit $1 contain the merge commit? Cached per commit.
contains() {
  local status
  answer=$(awk -v sha="$1" '$1 == sha { print $2 }' "$work/contains")
  [ -z "$answer" ] || return 0
  if [ "$1" = "$merge" ]; then
    answer=yes
  elif status=$(gh api "repos/$repo/compare/$merge...$1" --jq .status < /dev/null 2>&1); then
    case $status in ahead | identical) answer=yes ;; *) answer=no ;; esac
  else
    gh_failed "$status"
    return 1
  fi
  echo "$1 $answer" >> "$work/contains"
}

start=$SECONDS
settled=0
previous=""

while :; do
  elapsed=$((SECONDS - start))

  if gh api "repos/$repo/deployments?per_page=50" \
    --jq '.[] | [.id, .environment, .sha] | @tsv' > "$work/deployments" 2> "$work/error"; then
    failures=0
    : > "$work/results"
    # GitHub lists deployments newest first, so the first containing one per environment is the newest.
    cut -f2 "$work/deployments" | awk '!seen[$0]++' | grep -Ei -- "$environments" > "$work/environments" || true
    while IFS= read -r environment; do
      awk -F'\t' -v env="$environment" '$2 == env { print $1 "\t" $3 }' "$work/deployments" > "$work/candidates"
      while IFS=$'\t' read -r id sha; do
        contains "$sha" || continue 2
        [ "$answer" = yes ] || continue
        if line=$(gh api "repos/$repo/deployments/$id/statuses?per_page=1" \
          --jq '.[0] // {} | "\(.state // "pending")\t\(.environment_url // .log_url // .target_url // "")"' < /dev/null 2>&1); then
          state=${line%%$'\t'*}
          url=${line#*$'\t'}
          printf '%s\t%s\t%s\t%s\n' "$state" "$environment" "${sha:0:9}" "$url" >> "$work/results"
        else
          gh_failed "$line"
        fi
        break
      done < "$work/candidates"
    done < "$work/environments"

    current=$(cat "$work/results")
    if [ -s "$work/results" ] && ! cut -f1 "$work/results" | grep -Eqv '^(success|failure|error|inactive)$'; then
      # Every deployment found has finished. Wait one more round for services that deploy a little later.
      if [ "$current" = "$previous" ]; then
        settled=$((settled + 1))
      else
        settled=0
      fi
      if [ "$settled" -ge 1 ]; then
        cat "$work/results"
        if cut -f1 "$work/results" | grep -qv '^success$'; then
          exit 1
        fi
        exit 0
      fi
    fi
    previous=$current

    if [ ! -s "$work/results" ] && [ "$elapsed" -ge "$appear" ]; then
      echo "no deployment matching /$environments/ contains $merge after ${appear}s"
      exit 5
    fi
  else
    gh_failed "$(cat "$work/error")"
  fi

  if [ "$elapsed" -ge "$timeout" ]; then
    echo "timed out after ${timeout}s; deployments still running:"
    cat "$work/results" 2> /dev/null
    exit 3
  fi

  sleep "$interval"
done
