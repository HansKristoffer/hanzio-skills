#!/usr/bin/env bash
# Record the working tree as a git tree object, so a cleanup pass can be told apart
# from the uncommitted feature work it started from.
#
# Usage:
#   bash snapshot.sh
#
# Prints the id of a tree holding every file as it is on disk now: tracked files with
# their uncommitted changes, and untracked files that are not ignored. It changes no
# file, and leaves the index, the stash and every branch as they were. Take one before
# the pass and one after, then:
#
#   git diff <before> <after>                            what the pass changed, nothing else
#   git restore --source=<before> --worktree -- <path>   put one file back as it was
#
# A file the pass created is not in <before>, so restore cannot remove it: delete it.
#
# Exit codes:
#   0  printed a tree id
#   2  could not run (not a git repository, git failed)
set -uo pipefail

bail() {
  echo "snapshot: $1" >&2
  exit 2
}

[ $# -eq 0 ] || bail "takes no arguments"

top=$(git rev-parse --show-toplevel 2> /dev/null) || bail "not a git repository"
cd "$top" || bail "cannot enter $top"

scratch=$(mktemp -d) || bail "cannot make a temporary directory"
trap 'rm -rf "$scratch"' EXIT

# Start from a copy of the real index: its stat cache lets git skip unchanged files.
# A repository with no commit and nothing staged has no index yet, and git creates one.
index=$(git rev-parse --git-path index) || bail "cannot find the index"
if [ -f "$index" ]; then
  cp "$index" "$scratch/index" || bail "cannot copy the index"
fi

GIT_INDEX_FILE="$scratch/index" git add -A > /dev/null || bail "git add failed"
GIT_INDEX_FILE="$scratch/index" git write-tree || bail "git write-tree failed"
