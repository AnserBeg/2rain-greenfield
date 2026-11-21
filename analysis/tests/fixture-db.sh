#!/usr/bin/env bash
# One host-native disposable cluster. It never shares the guest's namespaces or credentials.
set -euo pipefail
umask 077
work=$(mktemp -d)
pgbin=$(pg_config --bindir)
export PGHOST="$work" PGPORT=55551 PGUSER=postgres PGDATABASE=postgres
cleanup() {
  "$pgbin/pg_ctl" -D "$work/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
"$pgbin/initdb" -A trust -U postgres --no-locale -D "$work/data" >/dev/null
"$pgbin/pg_ctl" -D "$work/data" -l "$work/postgres.log" -o "-F -k $work -p $PGPORT -c listen_addresses=''" -w start >/dev/null
node --import tsx analysis/tests/fixture-db.mjs "$@"
