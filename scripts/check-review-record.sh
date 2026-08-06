#!/usr/bin/env bash
# Fails when a packet's executable work has reached main without a review
# verdict recorded in docs/execution/review-log.md against the SHA that landed.
#
# review-tiers says a packet is accepted only after review, and git-workflow says
# any fix after review voids it and needs a fresh one. Both were declared rules
# with no executing gate, and on 2026-08-06 both lapsed twice in a single
# session: U2 and U2-fix were each integrated with no review arm, and each was
# caught by the user asking rather than by the orchestrator noticing. When the
# subsequent reviews ran, both returned BLOCK. A declared rule with no executing
# gate is the pattern AGENTS.md section 6 exists to close, so this is the gate.
#
# WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves a verdict was *recorded* for
# the SHA on main. It cannot prove a review happened, and it does not read the
# verdict — a BLOCK counts as a record, because the failure being closed is
# "forgot the arm entirely", not "reviewed badly". Do not let a green run here be
# read as evidence of review quality.
#
#   --self-test   run the negative controls and exit
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 2

LOG='docs/execution/review-log.md'
BASELINE="${REVIEW_RECORD_BASELINE:-367aebf}"
# Injectable so the fire-control below can run against a scratch branch. The gate
# is about main; nothing else should override this in normal use.
BRANCH="${REVIEW_RECORD_BRANCH:-main}"

# The exclusion list is exactly git-workflow's identical-tree rule, for the same
# stated reason: these paths are never executed, so a packet touching only them
# has no executable content a review would have observed.
readonly -a NON_EXECUTABLE=(':!docs' ':!.agents' ':!CLAUDE.md' ':!AGENTS.md')

record_exists() {
  # $1 = full sha. Matches the sha anywhere in the log, so a short or long form
  # in the table both resolve, but never matches an empty argument.
  [ -n "${1:-}" ] && [ -f "$LOG" ] && grep -qF -- "$1" "$LOG"
}

touches_executable() {
  [ -n "$(git diff --name-only "$1^" "$1" -- . "${NON_EXECUTABLE[@]}" 2>/dev/null)" ]
}

# git-workflow permits repository setup and agent-doctrine housekeeping straight
# to main, outside any packet — those are not packet work and no review arm is
# owed. That cannot be inferred from a path: `scripts/` holds both this file and
# run-matrix.sh, and a packet may legitimately change the latter. So the exemption
# is declared in the commit message and counted in the output, where it can be
# audited, rather than carved out of the exclusion list where it would be silent.
#
# Found when this gate fired on the very commit that introduced it — which is the
# best evidence available that it works.
doctrine_only() {
  git log -1 --format='%B' "$1" | grep -qiE '^Doctrine-only:[[:space:]]*[^[:space:]]'
}

packet_of() {
  git log -1 --format='%B' "$1" | sed -n 's/^Packet:[[:space:]]*\([^[:space:]]*\).*/\1/p' | head -1
}

# A commit is covered when it is an ancestor of, or is, the NEWEST recorded SHA.
#
# The obvious formulation — "some record contains it" — is vacuous here, and the
# gate shipped with that bug until a negative control was pushed far enough back
# to trip it. main is linear, so every commit before any recorded SHA is an
# ancestor of it: a single late record silently covered all of history. Measuring
# against the newest record instead makes the question "is there executable work
# on main newer than the last review?", which is the failure actually being
# closed.
#
# WHAT THIS DOES NOT CATCH, stated rather than papered over: if two packets land
# and only the later is recorded, the earlier passes. Closing that needs
# per-packet grouping, which needs the `Packet:` trailer git-workflow already
# requires and which no lane commit since the baseline carries. Tracked
# separately; do not read a green run as "every packet was reviewed", only as
# "nothing has landed since the last recorded review".
covered_by_record() {
  [ -n "${NEWEST_RECORD:-}" ] || return 1
  git merge-base --is-ancestor "$1" "$NEWEST_RECORD" 2>/dev/null && return 0

  # A --no-ff integration is BY CONSTRUCTION newer than the SHA it integrates,
  # so the ancestor test above can never cover it and the gate fired on the
  # first real merge it saw. Left unfixed it would false-positive on every
  # non-fast-forward integration, which is the "control that fails on correct
  # behaviour" failure this script's own self-test warns about.
  #
  # A merge is covered when its second parent is covered AND the merge changed
  # no executable content relative to that parent. That second clause is
  # git-workflow's identical-tree rule, and it is what makes the reviewed
  # matrix the acceptance matrix: a merge that silently resolved a conflict in
  # executable content is NOT covered by the review of the branch it merged.
  local second
  second="$(git rev-parse --verify --quiet "$1^2" 2>/dev/null)" || return 1
  [ -n "$second" ] || return 1
  git merge-base --is-ancestor "$second" "$NEWEST_RECORD" 2>/dev/null || return 1
  [ -z "$(git diff --name-only "$second" "$1" -- . "${NON_EXECUTABLE[@]}" 2>/dev/null)" ]
}

# Full 40-char SHAs from the log that resolve and are actually on main. A record
# naming a SHA that never landed proves nothing, so it is not allowed to cover.
load_records() {
  RECORDED=()
  NEWEST_RECORD=''
  [ -f "$LOG" ] || return 0
  local sha
  while read -r sha; do
    git rev-parse --verify --quiet "$sha^{commit}" >/dev/null || continue
    git merge-base --is-ancestor "$sha" "$BRANCH" 2>/dev/null || continue
    RECORDED+=("$sha")
    # Newest = the one every other record is an ancestor of.
    if [ -z "$NEWEST_RECORD" ] ||
      git merge-base --is-ancestor "$NEWEST_RECORD" "$sha" 2>/dev/null; then
      NEWEST_RECORD="$sha"
    fi
  done < <(grep -oE '[0-9a-f]{40}' "$LOG" | sort -u)
}

if [ "${1:-}" = '--self-test' ]; then
  fails=0
  # Control 1: a SHA that cannot be in the log must be reported missing.
  if record_exists '0000000000000000000000000000000000000000'; then
    echo 'self-test FAIL: absent sha reported as recorded' >&2
    fails=1
  fi
  # Control 2: an empty argument must not match, or every commit passes.
  if record_exists ''; then
    echo 'self-test FAIL: empty sha matched — the gate would pass on everything' >&2
    fails=1
  fi
  # Control 3: a SHA that is in the log must be found, or the gate never passes
  # and would be silently disabled by anyone who got tired of it.
  if ! record_exists 'd150f80eab2755ebebd3194a39c0734f1b23bee3'; then
    echo 'self-test FAIL: recorded sha reported as missing' >&2
    fails=1
  fi
  # Controls 4-6 cover the load-bearing function. record_exists only answers
  # "is this string in the file"; coverage is what actually gates a commit.
  load_records
  if [ "${#RECORDED[@]}" -eq 0 ]; then
    echo 'self-test FAIL: no records loaded — every commit would be uncovered' >&2
    fails=1
  fi
  # An ancestor of the newest record must be covered, or multi-commit packets
  # break and every lane is told to re-review work that was reviewed.
  if ! covered_by_record 'd150f80eab2755ebebd3194a39c0734f1b23bee3'; then
    echo 'self-test FAIL: ancestor of the newest record reported uncovered' >&2
    fails=1
  fi
  # The regression control. An earlier formulation asked "does ANY record contain
  # this commit"; main being linear, that made one late record cover all history.
  # A commit older than every record must still be covered only via the newest,
  # and a commit NEWER than the newest must not be. Both directions are asserted.
  # Assert the invariant, not a literal. An earlier version pinned the then-newest
  # SHA and broke the moment a record was appended — a control that fails on
  # correct behaviour teaches people to delete controls.
  for _r in "${RECORDED[@]:-}"; do
    [ -n "$_r" ] || continue
    git merge-base --is-ancestor "$_r" "$NEWEST_RECORD" 2>/dev/null && continue
    echo "self-test FAIL: $_r is not an ancestor of the resolved newest record" >&2
    fails=1
  done
  # A commit no record contains must NOT be covered. Without this the gate
  # passes on everything, which is the only failure mode that matters.
  #
  # Probed with a dangling commit built on the tip rather than with the tip
  # itself: after a valid --no-ff integration the tip IS legitimately covered
  # via the merge path, so asserting on it made this control fail on correct
  # behaviour. The probe is newer than every record and is not a merge, so it
  # is uncovered by construction and stays uncovered as history grows.
  _probe="$(git commit-tree "$(git rev-parse "$BRANCH^{tree}")" -p "$BRANCH" \
    -m 'check-review-record self-test probe' 2>/dev/null)"
  if [ -z "$_probe" ]; then
    echo 'self-test FAIL: could not build the uncovered probe' >&2
    fails=1
  elif covered_by_record "$_probe"; then
    echo 'self-test FAIL: an unrecorded commit was covered — the gate would never fire' >&2
    fails=1
  fi
  # Control 8: the exemption must require a non-empty reason, or `Doctrine-only:`
  # with nothing after it would wave any commit through.
  if echo 'Doctrine-only:' | grep -qiE '^Doctrine-only:[[:space:]]*[^[:space:]]'; then
    echo 'self-test FAIL: bare Doctrine-only: accepted — exemption would be free' >&2
    fails=1
  fi
  if ! echo 'Doctrine-only: review gate tooling' | grep -qiE '^Doctrine-only:[[:space:]]*[^[:space:]]'; then
    echo 'self-test FAIL: valid Doctrine-only: rejected' >&2
    fails=1
  fi
  # Control 10: a --no-ff merge of a recorded tip must be covered, or every
  # non-fast-forward integration false-positives.
  _merge="$(git rev-list --merges -1 "$NEWEST_RECORD..$BRANCH" 2>/dev/null)"
  if [ -n "$_merge" ] && ! covered_by_record "$_merge"; then
    echo "self-test FAIL: --no-ff merge of a recorded tip reported uncovered" >&2
    fails=1
  fi
  [ "$fails" -eq 0 ] && echo 'check-review-record self-test: OK (10 controls)'
  exit "$fails"
fi

if ! git rev-parse --verify --quiet "$BASELINE^{commit}" >/dev/null; then
  echo "check-review-record: baseline $BASELINE is not a commit" >&2
  exit 2
fi

# Walk main's own line. For a merge commit, <sha>^ is main's previous tip, so the
# diff is everything the merge brought in — which is what actually landed.
load_records
mapfile -t COMMITS < <(git rev-list --first-parent --reverse "$BASELINE..$BRANCH" 2>/dev/null)

UNCOVERED=()
EXEMPT=()
CHECKED=0

for sha in "${COMMITS[@]:-}"; do
  [ -n "$sha" ] || continue
  touches_executable "$sha" || continue
  if doctrine_only "$sha"; then
    EXEMPT+=("$sha")
    continue
  fi
  CHECKED=$((CHECKED + 1))
  covered_by_record "$sha" || UNCOVERED+=("$sha")
done

if [ "${#UNCOVERED[@]}" -eq 0 ]; then
  echo "review-record: OK ($CHECKED executable commit(s) since ${BASELINE:0:7}, all covered by ${#RECORDED[@]} record(s)${EXEMPT:+, ${#EXEMPT[@]} doctrine-only})"
  exit 0
fi

{
  echo 'review-record: FAIL'
  echo
  for sha in "${UNCOVERED[@]:-}"; do
    [ -n "$sha" ] || continue
    packet="$(packet_of "$sha")"
    echo "  ${sha:0:7} ${packet:+($packet) }changed executable content and no recorded SHA contains it"
  done
  cat <<EOF

  review-tiers requires a review before acceptance, and git-workflow voids a
  prior review once a fix moves the SHA. Integrating without one is how U2 and
  U2-fix each shipped a defect on 2026-08-06.

  Fix: run the review, then append the verdict to $LOG.
       A BLOCK is a valid record — this gate does not read the verdict.
EOF
} >&2
exit 1
