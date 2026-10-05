# STOCK-COUNTS — review round 2 prompt (ONLINE arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/STOCK-COUNTS` (draft PR #23), frozen executable SHA
`e138a486`. Round 1 reviewed `f148416c..f86bc65e`. This round's range is `f86bc65e..e138a486`; it includes the merge
`6b6d7a6e` of `packet/RETURNS` at `1420350b` (#15's own round-1 fix: `persistAdditionalReceipt`,
`digestCoversAuthorization`, `withRecordedAuthorization`, and a variable rename in `#post`). Read
`docs/architecture/posting-kernel-guarantees.md`, then that diff, and any other code you need. Not the packet records.
Tests: `test/postgres/inventory-stock-count.test.ts` (kernel), `test/postgres/inventory-stock-counts.test.ts` (the
count commands over the composed application), `test/unit/inventory-definition.test.ts`; controls:
`test/evidence/STOCK-COUNTS.expected-red.json`.

Round 1's findings, as reported:
1. A count lifecycle command that had committed was refused when retried unchanged under its key after another
   transition of the count: `#prepareCount` treated a request as a possible replay only when the count's revision was
   exactly one after the request's, and refused any other revision before the receipt lookup.
2. A reviewed reversal could be returned to counting, keeping its derived lines, and could then not be reviewed
   again: `deriveReversalLines` refuses a reversal that already has lines.
3. An unchanged Post retried after the authorization policy version changed conflicted: the route builds the kernel
   command with the current policy version, digest version 4 covers authorization evidence, and
   `validateReceiptReplay` reconstructed the recorded evidence only for versions 5, 7 and 8.
Also reported: C6's preservation compared rows read through `to_jsonb` as JavaScript values, so two numeric(38,18)
values differing in the eighteenth decimal compared equal.

What changed, by function:
- `inventory-posting-capability-executor.ts`, `#prepareCount`: refuses a shown revision greater than the count's
  current revision; it no longer evaluates the precondition, except for Post when the shown revision equals the
  current one.
- `stock-count-route.ts`, `executeStockCountChange` (runs inside the trust service's
  `executeIdempotentAcceptedMutation`, under the count's row lock): requires the shown revision to equal the current
  one, then refuses Return to counting on a reversal by name, then evaluates the operation's declared precondition,
  then the state transition. Comments on the function and on `deriveReversalLines` reworded.
- `packages/domain/src/inventory/definition.ts`, `countOperations`: Return to counting's precondition is
  `all(state = reviewed, not(kind = reversal))`. Release lineage entry 7 rebuilt with it (still seven entries).
- `inventory-posting-service.ts`: `digestCoversAuthorization` includes digest version 4 for stock-count postings, so
  `validateReceiptReplay` and `persistAdditionalReceipt` digest a version-4 receipt with the authorization evidence of
  the invocation it records. New `exactRowSql` reads a row as each column's jsonb text; `lockAndAssertStockCountEvidence`
  and `assertCompanionIdentitiesPersisted` use it for the count and line rows that the preservation proofs compare.
  The comment on `assertCountExpectedIsLedger` reworded.

Claims, as reworded. C1 An initial count or a correction posts only if each line's expected equals the sum of live
movements for its item at the count's location and legal entity, effective at or before the count's instant, read
under the locks the posting takes at BEGIN; otherwise `INVENTORY_COUNT_EXPECTED_STALE`, and the posting rolls back (no
movement, transition or accepted receipt commits). Each item once. A reversal is outside both rules; the kernel
checks each of its lines against the one movement it names. C2 A movement effective after the count's instant never
makes the count stale; one effective at the same instant is included in the sum. C3 A correction or a reversal
supersedes exactly one posted count at the same location; a posted count takes at most one posted compensation.
C4 A reviewed, posted or cancelled count and its lines take no generic create, update, archive or restore; no generic
input or form names either companion relation. C5 A reviewed count that already names a companion transaction is
refused at Post, by name, before the posting writes. C6 A count's Post changes nothing on the count or its lines
beyond its transition; the columns it does not write are compared as exact column text with what the evidence lock
read. C7 A version-4 receipt is digested with the authorization evidence of the invocation it records, on replay and
when a new-key natural replay stores its receipt; the version-4 preimage is unchanged and no stored receipt is
rewritten. Outside the kernel: a count command that committed replays under its key after later transitions; a new
execution is held to the shown revision, the reversal rule and the declared precondition; a reversal is never
returned to counting (ruling SC-6: a reviewed reversal is posted or cancelled).

Questions. Answer each from the code. Report production defects separately from evidence, wording and naming points,
which are filed, not fixed:
1. Does each count command (Start counting, Review, Return to counting, Cancel count, Post), retried unchanged under
   its key after other transitions of the count, replay? Can a new execution run on a revision or state other than
   the one it was shown, and does a changed input under an existing key replay?
2. Can a reversal be returned to counting, or its lines derived more than once, through any route, release or
   interleaving?
3. After the policy version changes, what does an unchanged Post retried under its key do, and a Post under a new key
   followed by that key again? Is the version-4 preimage, or any stored receipt, different from before?
4. Are the count's and lines' preservation comparisons exact for every column type they read, and do the coverage
   equality's inputs change with `exactRowSql`?
5. Did these commits break anything else?
Say plainly if this prompt steers you.
