#!/usr/bin/env bash
# Turn a Postgres URL kept in a private file into a read-only one, without
# printing it, and prove the database refuses writes on it.
#
# Usage: read-only-url.sh <url-file> [--no-probe]
#
# Reads the URL from <url-file>, writes <url-file>.ro (mode 600) with
# default_transaction_read_only=on added through the `options` parameter, which
# libpq (psql) and node-postgres both pass to the server. Prints only the host.
# Then, unless --no-probe, it tries `create temp table` through psql on the new
# URL and fails unless Postgres refuses it.
#
# Exit codes:
#   0  <url-file>.ro is written and, with the probe, Postgres refused the write
#   1  the probe write succeeded: this URL is NOT read-only, do not use it
#   2  usage error, an unreadable file, a URL that is not postgres://, or one that already sets options
#   3  the probe could not connect or psql is missing (the .ro file is written but unproven)
set -uo pipefail

file=${1:?usage: read-only-url.sh <url-file> [--no-probe]}
probe=yes
[ "${2:-}" = --no-probe ] && probe=no

[ -r "$file" ] || { echo "cannot read $file" >&2; exit 2; }
url=$(head -n 1 "$file" | tr -d '\r\n')

case $url in
  postgres://* | postgresql://*) ;;
  *) echo "not a postgres:// URL" >&2; exit 2 ;;
esac
case $url in
  *options=*) echo "the URL already sets options; add default_transaction_read_only=on to them by hand" >&2; exit 2 ;;
esac

case $url in
  *\?*) url="$url&options=-c%20default_transaction_read_only%3Don" ;;
  *) url="$url?options=-c%20default_transaction_read_only%3Don" ;;
esac

umask 077
printf '%s\n' "$url" > "$file.ro"
host=$(printf '%s' "$url" | sed -E 's#^[a-z]+://([^@/]*@)?([^/:?]+).*#\2#')
echo "wrote $file.ro for host $host"

[ "$probe" = yes ] || exit 0
command -v psql > /dev/null || { echo "psql is not installed; the read-only URL is unproven" >&2; exit 3; }

if output=$(psql "$url" -v ON_ERROR_STOP=1 -Atqc 'create temp table _read_only_probe (a int)' 2>&1); then
  echo "the probe write SUCCEEDED: this connection is not read-only" >&2
  exit 1
fi
case $output in
  *read-only*) echo "probe: Postgres refused the write (read-only transaction)" ;;
  *) echo "probe failed for another reason, so read-only is unproven: ${output//$url/<url>}" >&2; exit 3 ;;
esac
