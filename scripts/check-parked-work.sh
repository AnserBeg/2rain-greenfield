#!/usr/bin/env bash
# Surfaces packet branches that hold unintegrated work, and fails when any has
# been parked longer than the staleness threshold.
#
# WHY THIS EXISTS. current-plan.md tracks what to START. It does not track what
# was left half-done. When a lane parks a packet to take a higher-priority one —
# which the standing prioritisation rule explicitly tells it to do — that packet
# falls out of the tracking system entirely and survives only as a branch nobody
# is looking at.
#
# On 2026-08-02 that was found to have happened five times over eight days:
#   g3-p4b   "PARTIAL stock-count authoring, interrupted mid-run"  253 behind
#   gate-perf                                                      173 behind
#   rowparam  a real unshipped runtime fix                          43 behind
#   txtitle                                                         56 behind
#   g2-p7a                                                         636 behind
# Four had been silently superseded; one held work that was still needed and
# nearly rotted past the point of cheap rescue.
#
# Parked work is legitimate. Parked work that nobody can SEE is the defect.
set -uo pipefail

STALE_DAYS="${PARKED_WORK_STALE_DAYS:-3}"
cd "$(git rev-parse --show-toplevel)" || exit 2

now=$(date +%s)
stale=0
found=0
printf '%-34s %7s %8s %7s  %s\n' BRANCH AHEAD BEHIND AGE LAST
printf '%-34s %7s %8s %7s  %s\n' ---------------------------------- ------- -------- ------- ----

while read -r b; do
  [ -z "$b" ] && continue
  case "$b" in main|preserve-*) continue ;; esac   # archives are kept on purpose
  ahead=$(git rev-list --count "main..$b" 2>/dev/null) || continue
  [ "${ahead:-0}" -eq 0 ] && continue
  found=$((found + 1))
  behind=$(git rev-list --count "$b..main" 2>/dev/null)
  last=$(git log -1 --format=%ct "$b")
  days=$(( (now - last) / 86400 ))
  mark=""
  if [ "$days" -ge "$STALE_DAYS" ]; then mark="  <-- STALE"; stale=$((stale + 1)); fi
  printf '%-34s %7s %8s %6sd  %s%s\n' "$b" "$ahead" "$behind" "$days" \
    "$(git log -1 --format='%s' "$b" | cut -c1-40)" "$mark"
done < <(git branch --format='%(refname:short)')

echo
if [ "$found" -eq 0 ]; then
  echo "parked-work: OK (no branch holds unintegrated work)"
  exit 0
fi

if [ "$stale" -eq 0 ]; then
  echo "parked-work: OK ($found branch(es) in flight, none parked >= ${STALE_DAYS}d)"
  exit 0
fi

cat >&2 <<EOF
parked-work: FAIL

  $stale of $found branch(es) have held unintegrated work for >= ${STALE_DAYS} days.

  Every one is either work that still needs finishing or work that has been
  silently superseded. Both need a decision; neither survives being ignored.
  A branch 250 commits behind costs more to rescue than to rewrite.

  For each: integrate it, rebase and finish it, or delete it deliberately.
EOF
exit 1
