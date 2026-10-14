#!/usr/bin/env bash
# Runs one CI suite as a single leased unit: evidence preparation, the suite
# itself, and any evidence normalization.
#
# Preparation deletes this suite's evidence files and normalization rewrites
# them, so neither may run outside the lock. Before this script existed they sat
# on either side of the wrapper in package.json, which meant a script that was
# refused the lock had already destroyed the evidence of the last run.
set -uo pipefail

# Resolved from this script's location, not the caller's cwd: workspace-local
# entry points run from apps/web, and the helpers live at the repository root.
SCRIPT_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPOSITORY_ROOT="$(dirname -- "$SCRIPT_DIRECTORY")"

usage() {
  echo "usage: run-suite.sh <suite-id> [--normalize-playwright] -- <command> [args...]" >&2
  exit 2
}

SUITE="${1:-}"
[ -n "$SUITE" ] || usage
shift

NORMALIZE_PLAYWRIGHT=""
if [ "${1:-}" = "--normalize-playwright" ]; then
  NORMALIZE_PLAYWRIGHT=1
  shift
fi

[ "${1:-}" = "--" ] || usage
shift
[ "$#" -gt 0 ] || usage

node --import tsx "$REPOSITORY_ROOT/test/helpers/prepare-reachability-evidence.ts" "$SUITE"
PREPARE_RC="$?"
if [ "$PREPARE_RC" -ne 0 ]; then
  exit "$PREPARE_RC"
fi

"$@"
SUITE_RC="$?"
if [ "$SUITE_RC" -ne 0 ]; then
  exit "$SUITE_RC"
fi

if [ -n "$NORMALIZE_PLAYWRIGHT" ]; then
  node --import tsx "$REPOSITORY_ROOT/test/helpers/normalize-playwright-evidence.ts" "$SUITE"
  exit "$?"
fi
