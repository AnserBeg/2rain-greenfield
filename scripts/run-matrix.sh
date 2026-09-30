#!/usr/bin/env bash
# Serialized full-matrix runner with an independently reported performance gate.
set -uo pipefail

LABEL="${1:?usage: run-matrix.sh <lane-label> [worktree-dir]}"
WORKTREE="${2:-$PWD}"
LOCK="${NORTH_STAR_TEST_LOCK_PATH:-/tmp/north-star-matrix.lock}"
LOCK_TIMEOUT_SECONDS="${NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS:-300}"
FOREIGN_POLL_SECONDS=1
FOREIGN_PROCESSES=""
cd "$WORKTREE" || exit 2

if ! [[ "$LOCK_TIMEOUT_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "Invalid NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS: $LOCK_TIMEOUT_SECONDS" >&2
  exit 2
fi

SHA="$(git rev-parse HEAD)"
LOG="/tmp/matrix-${LABEL}-${SHA:0:8}.log"

registry() {
  node scripts/test-lock-registry.mjs "$@" --lock "$LOCK" --pid $$
}

# set -uo pipefail is not set -e, so an unchecked registry write fails silently
# and leaves a recorded mode nobody can trust. This script's three record writes
# — waiting, holding, and the shared mode after the downgrade — go through this
# helper, and the release in the EXIT trap reports its own failure. The wrapper
# checks its own writes separately; nothing here speaks for it.
require_registry_write() {
  if ! registry record "$@"; then
    echo "TEST_GATE_REGISTRY_WRITE_FAILED: the matrix could not record its lease for $LOCK; refusing to run." >&2
    exit 77
  fi
}

# The claim a child inherits names this lock, this shell and its start ticks, so
# the child can ask the registry whether the claim is still true. Assigned by
# the caller rather than substituted: an exit inside $( ) leaves only the
# subshell, which would export an empty claim and carry on.
MATRIX_CLAIM=""
mint_claim() {
  if ! MATRIX_CLAIM="$(registry claim --mode "$1")"; then
    echo "TEST_GATE_REGISTRY_WRITE_FAILED: the matrix could not mint a $1 lease claim for $LOCK; refusing to run." >&2
    exit 77
  fi
  if [ -z "$MATRIX_CLAIM" ]; then
    echo "TEST_GATE_REGISTRY_WRITE_FAILED: the matrix minted an empty $1 lease claim for $LOCK; refusing to run." >&2
    exit 77
  fi
}

node scripts/guard-ephemeral-postgres.mjs pre-lock
CONTAINER_GUARD_RC="$?"
if [ "$CONTAINER_GUARD_RC" -ne 0 ]; then
  exit "$CONTAINER_GUARD_RC"
fi

touch "$LOCK"

echo "[$(date +%H:%M:%S)] $LABEL waiting for the matrix slot (sha ${SHA:0:8})..."
# flock is a kernel descriptor lock, so this shell is the only thing that can
# say who holds it. Record before waiting and clear on every exit path.
trap 'registry release || echo "TEST_GATE_REGISTRY_WRITE_FAILED: could not release the matrix record for $LOCK" >&2' EXIT
require_registry_write --mode exclusive --state waiting --label "$LABEL" \
  --command "scripts/run-matrix.sh $LABEL"
registry report
exec 9>"$LOCK"
flock --conflict-exit-code 75 --timeout "$LOCK_TIMEOUT_SECONDS" 9
LOCK_RC="$?"
if [ "$LOCK_RC" -ne 0 ]; then
  if [ "$LOCK_RC" -eq 75 ]; then
    echo "TEST_GATE_LOCK_BUSY: exclusive access to $LOCK was unavailable for ${LOCK_TIMEOUT_SECONDS}s" >&2
    registry report
  else
    echo "TEST_GATE_LOCK_ERROR: flock failed with exit code $LOCK_RC for $LOCK" >&2
  fi
  exit "$LOCK_RC"
fi
require_registry_write --mode exclusive --state holding --label "$LABEL" \
  --command "scripts/run-matrix.sh $LABEL"
# Report before sweeping, from one snapshot, and sweep only because this
# acquisition is exclusive: success here does prove no incompatible inherited
# descriptor survives.
registry report --sweep exclusive
echo "[$(date +%H:%M:%S)] $LABEL ACQUIRED the lock."

node scripts/guard-ephemeral-postgres.mjs post-lock
CONTAINER_GUARD_RC="$?"
if [ "$CONTAINER_GUARD_RC" -ne 0 ]; then
  exit "$CONTAINER_GUARD_RC"
fi

# A test process in a recorded participant's process lineage is queued behind
# this lock, not racing it. Blaming those was how a correctly waiting lane
# starved the lane that legitimately held the slot. Lineage, not process group:
# a shared group only means "launched from the same shell", so exempting on it
# hands a participant's exemption to an unrelated sibling.
foreign_matrix() {
  local coordinated snapshot
  coordinated="$(registry coordinated-pids)"
  snapshot="$(ps -eo pid=,pgid=,args=)"
  FOREIGN_PROCESSES="$(
    printf '%s\n' "$snapshot" \
      | grep -vE "^[[:space:]]*($$|$PPID)[[:space:]]" \
      | grep -E '[c]orepack pnpm (test|check:boundaries|check:schema)|[p]laywright test|[r]un-security-scans\.sh' \
      | awk -v coordinated="$coordinated" '
          BEGIN {
            total = split(coordinated, pids, "\n")
            for (position = 1; position <= total; position++) {
              if (pids[position] != "") coordinated_pid[pids[position]] = 1
            }
          }
          !($1 in coordinated_pid)
        '
  )"
  [ -n "$FOREIGN_PROCESSES" ]
}
foreign_wait_attempts=0
maximum_foreign_wait_attempts=$((
  (LOCK_TIMEOUT_SECONDS + FOREIGN_POLL_SECONDS - 1) / FOREIGN_POLL_SECONDS
))
while foreign_matrix; do
  if [ "$foreign_wait_attempts" -ge "$maximum_foreign_wait_attempts" ]; then
    echo "TEST_GATE_LOCK_BUSY: a lock-unaware test process remained active for ${LOCK_TIMEOUT_SECONDS}s" >&2
    printf '%s\n' "$FOREIGN_PROCESSES" >&2
    exit 75
  fi
  if [ "$foreign_wait_attempts" -eq 0 ]; then
    printf '%s\n' "$FOREIGN_PROCESSES"
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
mint_claim exclusive
export NORTH_STAR_TEST_LOCK_HELD="$MATRIX_CLAIM"
export NORTH_STAR_TEST_LOCK_LABEL="$LABEL"
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
#
# Everything through the browser suites stays under the exclusive lease.
# check:schema, test:architecture, test:postgres, test:locale and both browser
# suites stand up ephemeral PostgreSQL containers, and two container-bearing
# runs on this machine starve each other's readiness deadline rather than
# colliding visibly.
{
  set -x
  corepack pnpm format &&
  corepack pnpm lint &&
  corepack pnpm typecheck &&
  corepack pnpm build &&
  corepack pnpm check:boundaries &&
  corepack pnpm check:expected-red &&
  corepack pnpm check:expected-red-controls &&
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
  corepack pnpm test:postgres:composed &&
  corepack pnpm test:locale &&
  corepack pnpm test:browser &&
  corepack pnpm test:browser:operations
} 2>&1 | tee -a "$LOG"
RC="${PIPESTATUS[0]}"
if [ "$RC" -ne 0 ]; then
  echo "FULL_MATRIX_FAILED rc=$RC sha=$SHA" | tee -a "$LOG"
  echo "[$(date +%H:%M:%S)] $LABEL released the slot." | tee -a "$LOG"
  exit "$RC"
fi

# The genuinely load-tolerant tail: no containers, no wall-clock assertions.
# Other lanes' focused suites and reviewer launches enter here.
bash scripts/downgrade-test-lock.sh "$LOCK" "$LOCK_TIMEOUT_SECONDS" 9
LOCK_RC="$?"
if [ "$LOCK_RC" -ne 0 ]; then
  echo "FULL_MATRIX_FAILED rc=$LOCK_RC sha=$SHA" | tee -a "$LOG"
  echo "[$(date +%H:%M:%S)] $LABEL released the slot." | tee -a "$LOG"
  exit "$LOCK_RC"
fi
# Record the new mode BEFORE minting the claim that advertises it: a child
# validating an inherited claim reads the record, so the record must never lag
# behind what children are told.
require_registry_write --mode shared --state holding --label "$LABEL" \
  --command "scripts/run-matrix.sh $LABEL"
mint_claim shared
export NORTH_STAR_TEST_LOCK_HELD="$MATRIX_CLAIM"
echo "[$(date +%H:%M:%S)] $LABEL downgraded to shared access for the load-tolerant tail." | tee -a "$LOG"
{
  set -x
  node --import tsx test/helpers/run-observability-producer.ts &&
  corepack pnpm check:language-coverage &&
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
