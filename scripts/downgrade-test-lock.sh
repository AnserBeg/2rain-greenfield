#!/usr/bin/env bash
# Convert an inherited matrix lock from exclusive to shared with a bounded wait.
set -uo pipefail

LOCK_PATH="${1:?usage: downgrade-test-lock.sh <lock-path> <timeout-seconds> [fd]}"
TIMEOUT_SECONDS="${2:?usage: downgrade-test-lock.sh <lock-path> <timeout-seconds> [fd]}"
LOCK_FD="${3:-9}"

if ! [[ "$TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Invalid lock-conversion timeout: $TIMEOUT_SECONDS" >&2
  exit 2
fi

flock --shared --conflict-exit-code 75 --timeout "$TIMEOUT_SECONDS" "$LOCK_FD"
LOCK_RC="$?"
if [ "$LOCK_RC" -ne 0 ]; then
  if [ "$LOCK_RC" -eq 75 ]; then
    echo "TEST_GATE_LOCK_BUSY: shared conversion for $LOCK_PATH was unavailable for ${TIMEOUT_SECONDS}s" >&2
  else
    echo "TEST_GATE_LOCK_ERROR: shared conversion failed with exit code $LOCK_RC for $LOCK_PATH" >&2
  fi
  exit "$LOCK_RC"
fi
