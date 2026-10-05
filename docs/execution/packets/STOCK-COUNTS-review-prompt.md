# STOCK-COUNTS — review round 1 prompt (ONLINE arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/STOCK-COUNTS` (draft PR #23), frozen executable SHA
`f86bc65e`, base `f148416c` (the merge of `packet/RETURNS`, #15, into this branch, which was cut from
`packet/INVENTORY-PARITY` at `8b4c8290`). Read `docs/architecture/posting-kernel-guarantees.md`, then the diff
`f148416c..f86bc65e` of `packages/postgres-provider/src/inventory-posting-service.ts` and
`packages/postgres-provider/src/inventory-posting-error.ts`, and any other code you need. Not the packet records.
Tests: `test/postgres/inventory-stock-count.test.ts` (kernel), `test/postgres/inventory-stock-counts.test.ts` (the
count commands over the composed application), `test/postgres/inventory-terminal-state.test.ts`; controls:
`test/evidence/STOCK-COUNTS.expected-red.json`.
Question: is there a defect in production code under the claims below? For each, give the code path and the
input or interleaving that reaches it. List evidence, wording and naming points separately.

What changed in the Critical set. `#post` calls a new `assertCountExpectedIsLedger` for stock-count postings, after
`assertStockCountCompensationAvailable`; `validateStockCountCommand` refuses an initial count or a correction that
names an item on two lines; the read-backs after a count's Post (`assertCompanionIdentitiesPersisted`) compare a
count's type and counting mode and each line's physical count with the bytes the evidence lock froze, through a new
`declaredColumns`; a new error code, `INVENTORY_COUNT_EXPECTED_STALE`; comments on digest version 4 and in
`lockAndAssertStockCountEvidence`. Changed in the same range and on the way to the kernel:
`stock-count-route.ts` (new: `executeStockCountChange` runs Start counting, Review, Return to counting and Cancel
count; `stockCountPostingCommand` builds what Post sends to `postStockCount`), `inventory-posting-capability-executor.ts`
(`#prepareCount`, `#executeCount`), `inventory-count-read-model.ts` (new), `module-runtime-interpreter.ts`
(`listReferencePlan`: a reference label over a uuid-stored text field joins as a uuid), and in
`packages/domain/src/inventory/definition.ts` the stock count's update guard and its two companion relations, now
`lifecycle: 'retired'`.

Claims. C1 An initial count or a correction posts only if each line's expected equals the sum of live movements for
its item at the count's location and legal entity, effective at or before the count's instant; otherwise it is
refused with `INVENTORY_COUNT_EXPECTED_STALE` and nothing is written. The sum is read under the locks the posting
takes at BEGIN. An initial count or a correction names each item once. C2 A movement effective after the count's
instant never makes the count stale; one effective at the same instant counts as before it. C3 A correction or a
reversal supersedes exactly one posted count at the same location, and a posted count takes at most one posted
compensation. C4 A reviewed, posted or cancelled count and its lines take no generic create, update, archive or
restore, and no generic input or form names either companion relation. C5 A reviewed count that already names a
companion transaction is refused at Post, by name, before anything is written. C6 A count's Post changes nothing on
the count or its lines beyond its transition, including the columns no posting writes.

Things to try: interleave a count's Post with an adjustment, transfer, receipt, shipment or return of the same item
at the same location, dated before, at or after the count's instant, and consider what each reads before and after
its locks; look for a movement writer that reaches that item and location without the lock the count's Post holds
when it reads; compare the ids in the read (type, case, the `::text` cast) with how movements store them; repeat an
item, or a line id, across the lines of an initial count, a correction and a reversal; correct a count at another
location, correct a correction, reverse a reversal, and correct one count twice, in sequence and in parallel; run
Start counting, Review, Return to counting and Cancel count from every state, twice, and under the same idempotency
key after the count changed; post a count reviewed under another company or an earlier policy; reach a frozen count
or its lines, or either companion relation, through any generic operation or form; post under a release that
declares none of the three new columns, and one that declares a column `declaredColumns` does not name. Does any
change in this range alter the version-4 digest input? Filed in the record, not changed here: a generic create can
still store a draft inventory transaction typed as a companion (release verification samples the type's first
option); a new count opens in the editor with one blank line; a count reviewed on one tenant day and posted on the
next is refused by the 0-day backdate window; per-line approval of a count waits for `APPROVAL-INVENTORY`. Say
plainly if this prompt steers you.
