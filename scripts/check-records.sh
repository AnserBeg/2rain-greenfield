#!/usr/bin/env bash
# Fails when a packet record claims work its frozen commit does not contain, or
# when the narrative record layer has gone stale against the ledger.
#
# WHY THIS EXISTS. Program review R1 (2026-08-20) measured that this programme
# has gated process rules three times — check-review-record.sh, check-origin-sync.sh,
# check-parked-work.sh, each with a hook — and the record layer zero times. Its
# disposition was this script, and that disposition was itself never entered in
# the queue, which is R1 happening to R1.
#
# The claim half comes from `ux-picker` round 3. `56762ce` was frozen with a
# commit message describing an implementation the commit did not contain: a
# one-off drift probe had mutated `surface-contract.ts`, measured 9 reds, and
# reverted with `git checkout -- <path>`, which goes to HEAD and so destroyed the
# round's work along with the mutation. Nothing went red afterwards, because the
# PREVIOUS round's implementation passes the same suites. A reviewer caught it by
# reading `git show --stat`; nothing in this repository could catch it at all.
#
# WHAT THIS PROVES, AND WHAT IT DOES NOT. It proves that what a packet record
# DECLARES is present in the tree it declares: each claimed path really differs
# between the declared base and head, each claimed symbol is really declared
# there, and no executable path changed that the record does not claim. Every one
# of those reads the frozen commits through git plumbing, never the working tree.
#
# It cannot prove the record claims ENOUGH. The declaration block is written by
# the packet author, so a packet that declares nothing is checked against
# nothing. This closes "the commit does not contain what the record claims"; it
# does not close "the record claims too little". Do not let a green run here be
# read as evidence that a packet's claims are complete.
#
#   --self-test   run the negative controls and exit
set -uo pipefail

cd "$(git rev-parse --show-toplevel)" || exit 2

if [ ! -d node_modules/tsx ]; then
  echo 'check-records: node_modules/tsx is absent — run `corepack pnpm install` first' >&2
  exit 2
fi

exec node --import tsx test/architecture/record-claim-fidelity.ts "$@"
