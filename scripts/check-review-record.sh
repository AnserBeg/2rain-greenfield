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

# Coverage follows how packets actually reach `main`: by --no-ff merge.
#
#   - A MERGE commit is covered when its second parent — the packet tip — is an
#     ancestor of, or is, some recorded SHA. That parent is what the review read.
#   - A NON-MERGE commit touching executable content is a direct commit to main,
#     which git-workflow permits only for doctrine housekeeping. It is covered
#     only by being recorded itself, or by carrying a `Doctrine-only:` trailer.
#
# TWO EARLIER MODELS WERE WRONG, and each was found by running this, not by
# reasoning about it. "Does ANY record contain this commit" was vacuous: main was
# linear, so one late record covered all history. "Is it an ancestor of the NEWEST
# record" fixed that but assumed the records are totally ordered — and the first
# time two packets ran in parallel, `proj-disc-impl` and `U1` sat on divergent
# branches with neither an ancestor of the other, so the gate failed on two
# correctly-reviewed merges.
#
# This model needs no ordering. It asks of each arrival exactly what git-workflow
# asks: the tip that was reviewed is the tip that landed.
#
# The merge case does NOT require the merge tree to equal the parent tree. A merge
# that also brings in another packet's accepted work legitimately differs from
# both parents; git-workflow's identical-tree rule governs whether the reviewed
# MATRIX still counts, which is a separate question decided at integration and
# recorded in the ledger.
covered_by_record() {
  local commit="$1" second recorded
  # --no-ff arrival: the packet tip is the second parent, and that tip is what
  # the review read.
  second="$(git rev-parse --verify --quiet "$commit^2" 2>/dev/null || true)"
  if [ -n "$second" ]; then
    for recorded in "${RECORDED[@]:-}"; do
      [ -n "$recorded" ] || continue
      git merge-base --is-ancestor "$second" "$recorded" 2>/dev/null && return 0
    done
  fi
  # Fast-forward arrival: the packet's commits sit on the branch's own line and
  # only its tip is recorded, so each is an ancestor of that record.
  for recorded in "${RECORDED[@]:-}"; do
    [ -n "$recorded" ] || continue
    git merge-base --is-ancestor "$commit" "$recorded" 2>/dev/null && return 0
  done
  return 1
}

# Full 40-char SHAs from the log that resolve and are reachable from the branch.
# No ordering is computed — see covered_by_record for why that was a mistake.
load_records() {
  RECORDED=()
  [ -f "$LOG" ] || return 0
  local sha
  while read -r sha; do
    git rev-parse --verify --quiet "$sha^{commit}" >/dev/null || continue
    git merge-base --is-ancestor "$sha" "$BRANCH" 2>/dev/null || continue
    RECORDED+=("$sha")
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
  # A recorded non-merge commit is covered by being recorded.
  if ! covered_by_record 'd150f80eab2755ebebd3194a39c0734f1b23bee3'; then
    echo 'self-test FAIL: a recorded commit reported uncovered' >&2
    fails=1
  fi
  # The regression control. An earlier formulation asked "does ANY record contain
  # this commit"; main being linear, that made one late record cover all history.
  # A commit older than every record must still be covered only via the newest,
  # and a commit NEWER than the newest must not be. Both directions are asserted.
  # Records need no ordering under this model. Assert only that they loaded and
  # resolve; an earlier version required a total order and broke on parallel
  # branches, which is the defect this model exists to remove.
  for _r in "${RECORDED[@]:-}"; do
    [ -n "$_r" ] || continue
    git rev-parse --verify --quiet "$_r^{commit}" >/dev/null && continue
    echo "self-test FAIL: record $_r does not resolve" >&2
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
  _merge="$(git rev-list --merges -1 "$BASELINE..$BRANCH" 2>/dev/null)"
  if [ -n "$_merge" ] && ! covered_by_record "$_merge"; then
    echo 'self-test FAIL: --no-ff merge of a recorded tip reported uncovered' >&2
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
