#!/usr/bin/env bash
# Serialized full-matrix runner with an independently reported performance gate.
set -uo pipefail

LABEL="${1:?usage: run-matrix.sh <lane-label> [worktree-dir]}"
WORKTREE="${2:-$PWD}"
LOCK="${NORTH_STAR_TEST_LOCK_PATH:-/tmp/north-star-matrix.lock}"
LOCK_TIMEOUT_SECONDS="${NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS:-300}"
FOREIGN_POLL_SECONDS=1
cd "$WORKTREE" || exit 2

if ! [[ "$LOCK_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Invalid NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS: $LOCK_TIMEOUT_SECONDS" >&2
  exit 2
fi

SHA="$(git rev-parse HEAD)"
LOG="/tmp/matrix-${LABEL}-${SHA:0:8}.log"
touch "$LOCK"

echo "[$(date +%H:%M:%S)] $LABEL waiting for the matrix slot (sha ${SHA:0:8})..."
exec 9>"$LOCK"
flock --conflict-exit-code 75 --timeout "$LOCK_TIMEOUT_SECONDS" 9
LOCK_RC="$?"
if [ "$LOCK_RC" -ne 0 ]; then
  if [ "$LOCK_RC" -eq 75 ]; then
    echo "TEST_GATE_LOCK_BUSY: exclusive access to $LOCK was unavailable for ${LOCK_TIMEOUT_SECONDS}s" >&2
  else
    echo "TEST_GATE_LOCK_ERROR: flock failed with exit code $LOCK_RC for $LOCK" >&2
  fi
  exit "$LOCK_RC"
fi
echo "[$(date +%H:%M:%S)] $LABEL ACQUIRED the lock."

foreign_matrix() {
  local snapshot
  snapshot="$(ps -eo pid=,args=)"
  printf '%s\n' "$snapshot" \
    | grep -vE "^[[:space:]]*($$|$PPID)[[:space:]]" \
    | grep -Eq '[c]orepack pnpm (test|check:boundaries|check:schema)|[p]laywright test|[r]un-security-scans\.sh'
}
foreign_wait_attempts=0
maximum_foreign_wait_attempts=$((
  (LOCK_TIMEOUT_SECONDS + FOREIGN_POLL_SECONDS - 1) / FOREIGN_POLL_SECONDS
))
while foreign_matrix; do
  if [ "$foreign_wait_attempts" -ge "$maximum_foreign_wait_attempts" ]; then
    echo "TEST_GATE_LOCK_BUSY: a lock-unaware test process remained active for ${LOCK_TIMEOUT_SECONDS}s" >&2
    exit 75
  fi
  foreign_wait_attempts=$((foreign_wait_attempts + 1))
  echo "[$(date +%H:%M:%S)] $LABEL: lock held, but a lock-unaware test process is still running. Waiting ${FOREIGN_POLL_SECONDS}s (${foreign_wait_attempts}/${maximum_foreign_wait_attempts})..."
  sleep "$FOREIGN_POLL_SECONDS"
done
echo "[$(date +%H:%M:%S)] $LABEL starting. Log: $LOG"

if [ -n "$(git status --porcelain)" ]; then
  echo "REFUSED: worktree is dirty; a matrix must run on a clean frozen tree." | tee -a "$LOG"
  exit 3
fi
if [ "$(git rev-parse HEAD)" != "$SHA" ]; then
  echo "REFUSED: HEAD moved after queueing." | tee -a "$LOG"
  exit 4
fi

export CI=1
export NORTH_STAR_TEST_LOCK_HELD=exclusive
export REACHABILITY_RUN_ID="${LABEL}-${SHA:0:8}"

PRE="${3:-}"
if [ -n "$PRE" ]; then
  echo "[$(date +%H:%M:%S)] $LABEL pre-command: $PRE" | tee -a "$LOG"
  bash -c "$PRE" 2>&1 | tee -a "$LOG"
  if [ "${PIPESTATUS[0]}" -ne 0 ]; then
    echo "PRE_COMMAND_FAILED — matrix not started." | tee -a "$LOG"
    exit 5
  fi
fi

{
  set -x
  corepack pnpm install --frozen-lockfile --reporter=append-only &&
  node --import tsx test/helpers/begin-reachability-run.ts &&
  corepack pnpm test:performance
} 2>&1 | tee -a "$LOG"
PERFORMANCE_RC="${PIPESTATUS[0]}"
if [ "$PERFORMANCE_RC" -ne 0 ]; then
  echo "PERFORMANCE_GATE_FAILED rc=$PERFORMANCE_RC sha=$SHA" | tee -a "$LOG"
  echo "FULL_MATRIX_FAILED rc=$PERFORMANCE_RC sha=$SHA" | tee -a "$LOG"
  echo "[$(date +%H:%M:%S)] $LABEL released the slot." | tee -a "$LOG"
  exit "$PERFORMANCE_RC"
fi
echo "PERFORMANCE_GATE_PASS_SHA=$SHA" | tee -a "$LOG"

# The main matrix deliberately excludes test:performance. Its evidence was
# produced above under the same run id, so the final reachability aggregation
# proves both the exclusive gate and the load-tolerant matrix executed.
bash scripts/downgrade-test-lock.sh "$LOCK" "$LOCK_TIMEOUT_SECONDS" 9
LOCK_RC="$?"
if [ "$LOCK_RC" -ne 0 ]; then
  echo "FULL_MATRIX_FAILED rc=$LOCK_RC sha=$SHA" | tee -a "$LOG"
  echo "[$(date +%H:%M:%S)] $LABEL released the slot." | tee -a "$LOG"
  exit "$LOCK_RC"
fi
export NORTH_STAR_TEST_LOCK_HELD=shared
echo "[$(date +%H:%M:%S)] $LABEL downgraded to shared access for the load-tolerant matrix." | tee -a "$LOG"
{
  set -x
  corepack pnpm format &&
  corepack pnpm lint &&
  corepack pnpm typecheck &&
  corepack pnpm build &&
  corepack pnpm check:boundaries &&
  corepack pnpm check:schema &&
  corepack pnpm check:demo-release &&
  corepack pnpm check:app-release &&
  corepack pnpm test:unit &&
  corepack pnpm test:compiler &&
  corepack pnpm test:integration &&
  corepack pnpm test:agent &&
  corepack pnpm test:architecture &&
  corepack pnpm test:contracts &&
  corepack pnpm test:postgres &&
  corepack pnpm test:locale &&
  corepack pnpm test:browser &&
  node --import tsx test/helpers/run-observability-producer.ts &&
  corepack pnpm check:reachability &&
  SECURITY_EVIDENCE_DIR=test-results/security .github/scripts/run-security-scans.sh
} 2>&1 | tee -a "$LOG"
RC="${PIPESTATUS[0]}"

if [ "$RC" -eq 0 ] && [ -n "$(git status --porcelain)" ]; then
  RC=6
  echo "REFUSED: matrix changed the frozen worktree." | tee -a "$LOG"
fi
if [ "$RC" -eq 0 ]; then
  echo "FULL_MATRIX_PASS_SHA=$SHA" | tee -a "$LOG"
else
  echo "FULL_MATRIX_FAILED rc=$RC sha=$SHA" | tee -a "$LOG"
fi
echo "[$(date +%H:%M:%S)] $LABEL released the slot." | tee -a "$LOG"
exit "$RC"
