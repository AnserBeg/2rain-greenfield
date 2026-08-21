#!/usr/bin/env bash
# The expected-red gate. Fails when a committed mutation manifest no longer
# names live production text, and — under --run — when a named mutation does not
# reproduce its exact declared red.
#
# WHY THIS EXISTS. AGENTS.md section 6 requires a negative control for each way
# a gate could pass vacuously, and supplies no reusable way to construct one. So
# every packet author invents the control from scratch and a reviewer audits the
# invention by hand. The measurement in the 2026-08-20 program review (R2): the
# one packet that committed its mutation runner — scoped-create-operand-impl,
# apply a named one-property mutation, run the focused suite, require the exact
# expected red, restore — converged in two rounds while its neighbours took four
# to seven. Everywhere else the demanded reds were performed once by hand and
# transcribed into review-log prose, executable never again.
#
# WHAT THIS PROVES, AND WHAT IT DOES NOT.
#
#   Default (validate) proves that every manifest entry still names source text
#   present exactly once in the file it claims, and that its shape cannot pass
#   vacuously — a claim is stated, a kill set is named, and the expected pattern
#   does not match a green transcript. It does NOT run anything, so it cannot
#   prove any mutation still reds. That is the honest split: drift is what goes
#   stale on its own and is cheap enough for every matrix; reproducing the reds
#   costs minutes to tens of minutes and belongs at acceptance.
#
#   --run proves the reds. It does NOT prove the mutations are the right ones.
#   Manifests are self-chosen, and review-tiers is explicit that a self-chosen
#   table measures its author's model and is worth strictly less than an
#   independent replay. Mutation choice and fixture self-correlation stay with a
#   human; nothing here generates a mutation, scores coverage, or reports a
#   survival ratio.
#
#   --self-test runs the negative controls. A gate never observed failing is not
#   evidence, and one red overall is not one red per vacuity vector.
#
# Usage:
#   check-expected-red.sh                 validate every manifest (no execution)
#   check-expected-red.sh --run [name...] reproduce the reds (all, or selected)
#   check-expected-red.sh --list          list entries
#   check-expected-red.sh --self-test     run the negative controls and exit
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 2

RUNNER='test/helpers/expected-red.mjs'
CONTROLS='test/fixtures/expected-red/controls'
SUBJECT='test/fixtures/expected-red/subject.mjs'
JOURNAL='test-results/expected-red/in-flight.json'

if [ ! -f "$RUNNER" ]; then
  echo "check-expected-red: $RUNNER is missing" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Negative controls. Each varies ONE property of an otherwise-correct manifest
# entry, so the red it produces attributes itself. They are grouped by the
# vacuity vector each one closes, because AGENTS.md section 6 asks for one red
# per vector rather than one red overall.
# ---------------------------------------------------------------------------
if [ "${1:-}" = '--self-test' ]; then
  fails=0
  controls=0
  RESTORE_FROM=''
  restore_subject() {
    if [ -n "$RESTORE_FROM" ] && [ -f "$RESTORE_FROM" ]; then
      cp "$RESTORE_FROM" "$SUBJECT"
      rm -f "$RESTORE_FROM"
    fi
    return 0
  }
  trap restore_subject EXIT

  fail() {
    echo "self-test FAIL: $1" >&2
    fails=$((fails + 1))
  }

  # The fixture subject is mutated by every executing control. A control that
  # leaves it changed has not restored what it measured, which is section 6's
  # subject-repaired-before-measured vector read from the other side.
  assert_subject_restored() {
    git diff --quiet -- "$SUBJECT" ||
      fail "$1 — the fixture subject was left mutated"
  }

  # $1 glob, $2 mode, $3 expected token in the refusal, $4 description
  expect_refusal() {
    local output status
    controls=$((controls + 1))
    output="$(EXPECTED_RED_MANIFEST_GLOB="$1" node "$RUNNER" "$2" 2>&1)"
    status=$?
    if [ "$status" -eq 0 ]; then
      fail "$4 — the gate reported OK"
    else
      case "$output" in
      *"$3"*) ;;
      *)
        fail "$4 — refused, but not for '$3'"
        printf '%s\n' "$output" | sed -n '1,6p' >&2
        ;;
      esac
    fi
    assert_subject_restored "$4"
  }

  control() { expect_refusal "$CONTROLS/$1.expected-red.json" "$2" "$3" "$4"; }

  # --- Vector A: the mutation did not apply. -------------------------------
  # A manifest entry whose source text has drifted is the single most likely
  # future failure of this gate, and a runner that read "no match" as "nothing
  # to do" would turn every entry green forever.
  control victim-absent validate EXPECTED_RED_VICTIM_ABSENT \
    'A1 an original absent from its file'
  control victim-ambiguous validate EXPECTED_RED_VICTIM_AMBIGUOUS \
    'A2 an original matching more than once, where String.replace takes the first'
  control no-mutation validate EXPECTED_RED_NO_MUTATION \
    'A3 a replacement identical to the original'

  # --- Vector B: the check read zero input. --------------------------------
  expect_refusal "$CONTROLS/no-such-manifest-*.expected-red.json" validate \
    EXPECTED_RED_NO_MANIFESTS 'B1 a glob that discovers no manifest'
  control zero-tests run 'the baseline executed no test' \
    'B2 a name pattern selecting no test'
  controls=$((controls + 1))
  if node "$RUNNER" run no-such-entry-name >/dev/null 2>&1; then
    fail 'B3 a mistyped entry name ran as if it had selected something'
  fi

  # --- Vector C: the red fired for the wrong reason. -----------------------
  control pattern-not-discriminating validate EXPECTED_RED_PATTERN_NOT_DISCRIMINATING \
    'C1 an expected pattern that also matches a green transcript'
  control survivor run SURVIVOR \
    'C2 a mutation the suite does not notice'
  control wrong-red run 'went red for a different reason' \
    'C3 a red whose text is not the declared one'
  control wrong-kills run 'not attributable' \
    'C4 a red that killed a different test than the one declared'

  # --- The manifest format's own load-bearing fields. ----------------------
  control claim-missing validate EXPECTED_RED_CLAIM_MISSING \
    'F1 an entry naming no production seam'
  control kills-missing validate EXPECTED_RED_KILLS_MISSING \
    'F2 an entry naming no test its mutation must break'

  # --- Vector D: the subject repaired before it is measured. ---------------
  # The runner refuses a dirty tracked tree so that recovering a crashed run
  # with `git checkout -- <file>` is lossless. commit-before-negative-controls
  # is doctrine here: without this refusal that recovery eats uncommitted work.
  controls=$((controls + 1))
  RESTORE_FROM="$(mktemp)"
  cp "$SUBJECT" "$RESTORE_FROM"
  printf '\n// self-test: a deliberately dirty tracked tree\n' >>"$SUBJECT"
  dirty_output="$(EXPECTED_RED_MANIFEST_GLOB="$CONTROLS/admission-twin.expected-red.json" \
    node "$RUNNER" run 2>&1)"
  if [ $? -eq 0 ]; then
    fail 'D1 the runner started against a dirty tracked tree'
  else
    case "$dirty_output" in
    *'clean tracked tree'*) ;;
    *) fail 'D1 refused a dirty tree, but not for the stated reason' ;;
    esac
  fi
  restore_subject
  RESTORE_FROM=''
  assert_subject_restored 'D1'

  # --- Vector G: validating a tree that is deliberately mutated. -----------
  # Validation reads the working tree. Racing a --run run, it would report the
  # live mutation as drift — the right FAIL for the wrong reason. It must say it
  # cannot determine instead.
  controls=$((controls + 1))
  mkdir -p "$(dirname "$JOURNAL")"
  printf '{ "mutated": ["%s"] }\n' "$SUBJECT" >"$JOURNAL"
  journal_output="$(EXPECTED_RED_MANIFEST_GLOB="$CONTROLS/admission-twin.expected-red.json" \
    node "$RUNNER" validate 2>&1)"
  journal_status=$?
  rm -f "$JOURNAL"
  if [ "$journal_status" -eq 0 ]; then
    fail 'G1 validate answered while a mutation run was in flight'
  else
    case "$journal_output" in
    *'CANNOT VALIDATE'*) ;;
    *) fail 'G1 refused an in-flight tree, but not as an undeterminable one' ;;
    esac
  fi

  # --- The admission twin. -------------------------------------------------
  # A gate that only ever refuses is as useless as one that only ever passes.
  controls=$((controls + 1))
  admission="$(EXPECTED_RED_MANIFEST_GLOB="$CONTROLS/admission-twin.expected-red.json" \
    node "$RUNNER" run 2>&1)"
  admission_status=$?
  if [ "$admission_status" -ne 0 ]; then
    fail 'E1 a correct manifest against correct production was refused'
    printf '%s\n' "$admission" | sed -n '1,6p' >&2
  else
    case "$admission" in
    *'MUTATION_RED admission-twin'*) ;;
    *) fail 'E1 the admission run passed without reproducing its red' ;;
    esac
  fi
  assert_subject_restored 'E1'

  trap - EXIT
  if [ "$fails" -eq 0 ]; then
    echo "check-expected-red self-test: OK ($controls controls)"
  fi
  exit "$fails"
fi

case "${1:-}" in
'')
  node "$RUNNER" validate
  exit "$?"
  ;;
--list)
  node "$RUNNER" list
  exit "$?"
  ;;
--run)
  shift
  node "$RUNNER" run "$@"
  exit "$?"
  ;;
*)
  echo "Usage: check-expected-red.sh [--run [name...] | --list | --self-test]" >&2
  exit 2
  ;;
esac
