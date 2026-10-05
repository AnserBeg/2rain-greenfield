# REPLENISHMENT — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-replenishment`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --verify`,
then open the printed URL. Type `{"phase":"replenishment"}` and Enter into that terminal to seed the scenario below;
Ctrl-C stops it and removes its container. The demo seed holds 10 **Field notebook** (OFF-100) at **Calgary
warehouse**; the phase adds, through the governed operations: a released purchase order from Alpine Office Supply for
8 notebooks with 3 received, a later released order from Summit Industrial for 4, a draft for 20; a confirmed sale of
6 notebooks with 4 reserved and 1 shipped, a draft sale of 50; a confirmed sale of 3 **Task lamp** (no stock); and
levels for Task lamp (reorder point 5) and **Shipping labels** (reorder point 0, up to 10).

## §1 An item's levels

1. More → Catalog → **Item** → **Field notebook** → Record actions → **Edit**.
2. Reorder point **20**, Reorder up to **30**, Preferred location: a list of the four locations by name — pick
   **Calgary warehouse** — Standard cost (CAD) **4.5** → **Save**: "Update complete".
3. Back on the item page: Reorder point 20, Reorder up to 30, Preferred location **Calgary warehouse** (a name, not an
   id), Standard cost (CAD) **4.50**.

## §2 Stock by item

1. Inventory → **Stock by item**: one row per item in the company the bar names; tabs **All 4**, **Shortage 1**,
   **Reorder 2**.
2. Field notebook reads On hand **12** (10 + 3 received − 1 shipped), Reserved **3**, Available **9**, Incoming **9**
   (5 + 4 still to arrive; the draft adds nothing), Open demand **5** (6 − 1; the draft sale adds nothing), Projected
   **16**, Reorder point 20, Status **Reorder**.
3. **Shortage**: only Task lamp (Projected **-3**). Fine-point pen set, with no reorder point, is **Healthy** and is
   never due.
4. The figure columns offer no sort; **Export CSV** holds the same figures and the status by name.

## §3 Buying worklist

1. Inventory → **Buying worklist**: **To buy 3** — Field notebook, Task lamp, Shipping labels.
2. Field notebook: Suggested **14** (30 − 16), Last supplier **Summit Industrial** (the newest released order, not the
   draft). Task lamp: Suggested **—** (no reorder-up-to level) and Last supplier **—** (never bought).

## §4 A purchase line starts from the standard cost

Purchasing → Purchase orders → **New** → Vendor **Alpine Office Supply** (CAD) → Line 1 product **Field notebook**:
Unit cost reads **4.5**, the notebook's standard cost in CAD; change it if this order costs more.
