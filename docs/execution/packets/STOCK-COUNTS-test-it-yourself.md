# STOCK-COUNTS — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-stock-counts`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve`,
then open the printed URL. Ctrl-C stops it and removes its container. The demo seed holds 10 **Field notebook**
(OFF-100) at **Calgary warehouse** and nothing elsewhere. Take the sections in order; each takes a few minutes.

## §1 Count a location

1. Inventory → **Stock counts** → **New**. **Location** Calgary warehouse, **Reason** Physical count, **Narrative**
   "October cycle count". **Count type** reads Cycle count and **Counting mode** Open; there is no number, state or
   date to type. Click **Remove line 1** (a new count opens with one blank line, filed) → **Save draft**: the page
   opens **CNT-000001**, Draft.
2. **Start counting**: **Counted lines** lists Field notebook, **Expected 10**, Physical count and Variance —.
3. **Edit** → line 1 **Physical count** 9; **Add line** → Product **Task lamp**, Physical count **2** (found on a
   shelf, not on the books) → **Save draft**. The page reads Field notebook Variance **-1**; Task lamp Expected **0**,
   Variance **2**.
4. **Review**: **Counted at** is now the review's time, the figures are the ones that will post, and Edit is gone.
   A count with a line not yet counted is refused at Review.
5. **Post** → **Confirm Post**: **Posted movements** list Field notebook -1 and Task lamp 2, role `count`. Catalog →
   Item list → Field notebook reads Calgary warehouse 9; Task lamp reads 2.

## §2 A count that went stale is refused

1. Count Calgary again as in §1, everything as booked (Field notebook 9, Task lamp 2) → Review. Note its
   **Counted at**.
2. Inventory → **Inventory transactions** → **New**: Adjustment, Reason Damaged, a narrative, **Effective date**
   today a few minutes BEFORE that Counted at (both read in UTC); line Field notebook, From Calgary warehouse,
   **-1** → Save → Post.
3. Back on the count → **Post** → refused `INVENTORY_COUNT_EXPECTED_STALE`: the line expects 9, the ledger holds 8 at
   Calgary as of the count's instant. The count stays Reviewed and nothing posts.
4. **Return to counting**: Expected reads 8, Variance 1. Edit → Physical count 8 → Save → Review → Post: stock stays 8.
5. Repeat 1-3 with the adjustment's Effective date left at now (after the Counted at): the count posts. A count
   speaks for its own instant, and a later movement does not make it stale.

## §3 Correct and reverse a posted count

1. Open CNT-000001 → **Correct**: Reason Counting error confirmed, a narrative → Review → Confirm. **Corrections and
   reversals** lists a correction, Counting; **Open** it: it lists the products CNT-000001 counted, Expected what is
   posted now.
2. Edit → Field notebook **10**, Task lamp **2** → Save → Review → Post: Calgary reads Field notebook 10. A
   correction posts what you count less what is posted then.
3. **Correct** CNT-000001 a second time: that correction's Post is refused `INVENTORY_COUNT_COMPENSATION_CONFLICT`
   (one posted count takes one correction); **Cancel count** it.
4. Open the correction → **Reverse**, Reason "Counted the wrong bay" → Review → Confirm: each of the correction's
   movements is undone exactly, and Calgary reads what it held before the correction.

## §4 Blind counts, quick corrections and cancelling

1. **New**, Calgary warehouse, **Counting mode** Blind → Remove line 1 → Save → Start counting: Expected and Variance
   stay empty while counting; Review shows them.
2. **Cancel count** on a count that has not posted (Draft, Counting or Reviewed) → Confirm: State Cancelled, nothing
   posts, and it offers no further command.
3. **Count type** Quick correction (or Opening inventory): Start counting adds no lines; add only the products you
   counted.

## §5 The Lists

1. Inventory → **Stock counts**: views All, Counting, Reviewed, Posted, Cancelled; each row's Number is CNT-…, with
   Location, Kind, Counted date and State.
2. Inventory → **Inventory transactions** lists only adjustments and transfers: the transaction a count, receipt,
   shipment or return posts is not listed there; a count shows what it posted under **Posted movements**.
3. Neither the count editor nor the count line form offers a transaction or transaction-line picker: only Post writes
   those links.
