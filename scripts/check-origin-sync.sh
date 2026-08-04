#!/usr/bin/env bash
# Fails when local main holds accepted work that is not on origin.
#
# git-workflow says "push main to origin after every accepted packet" so each
# checkpoint doubles as an off-machine backup. On 2026-08-02 that rule was found
# to have lapsed for eight days and 637 commits — merging kept working, pushing
# did not, and the only copy of a week's work was one laptop. A declared rule
# with no executing gate is the pattern AGENTS.md section 6 exists to close, so
# this is the gate.
#
# Uses only the local remote-tracking ref, so it needs no network and is honest
# offline: it reports drift from the last known origin/main, which is exactly
# the question. Pass --fetch to refresh that ref first.
set -uo pipefail

THRESHOLD="${ORIGIN_SYNC_THRESHOLD:-0}"

cd "$(git rev-parse --show-toplevel)" || exit 2

if [ "${1:-}" = "--fetch" ]; then
  git fetch --quiet origin main 2>/dev/null || {
    echo "check-origin-sync: could not reach origin; reporting against the last known ref" >&2
  }
fi

if ! git rev-parse --verify --quiet origin/main >/dev/null; then
  echo "check-origin-sync: no origin/main ref — run 'git fetch origin' once" >&2
  exit 2
fi

AHEAD="$(git rev-list --count origin/main..main)"
BEHIND="$(git rev-list --count main..origin/main)"

if [ "$AHEAD" -le "$THRESHOLD" ]; then
  echo "origin-sync: OK (main is $AHEAD ahead, $BEHIND behind origin/main)"
  exit 0
fi

OLDEST="$(git log --format='%cd' --date=short "origin/main..main" | tail -1)"
cat >&2 <<EOF
origin-sync: FAIL

  main is $AHEAD commit(s) ahead of origin/main.
  Oldest unpushed commit dates from: ${OLDEST:-unknown}

  That work exists only on this machine. git-workflow requires main to be
  pushed after every accepted packet, so each checkpoint is also a backup.

  Fix:  git push origin main
EOF
exit 1
