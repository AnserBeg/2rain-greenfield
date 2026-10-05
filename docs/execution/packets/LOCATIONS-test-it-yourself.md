# LOCATIONS — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-locations`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --verify`,
then open the printed URL. Type `{"phase":"locations"}` and Enter into that terminal to seed the scenario below;
Ctrl-C stops it and removes its container. The demo seed holds 10 **Field notebook** (OFF-100) at **Calgary
warehouse**; the phase adds, through the governed operations: a **Quality hold** location (QA-HOLD, type Quarantine)
put in quarantine with the reason "Water damage on an inbound pallet", a transfer of 4 notebooks into it, and a
confirmed sale of 8 notebooks with nothing reserved yet.

## §1 Every location's type and status

1. More → **Location**: QA-HOLD reads Type **Quarantine**, Inventory status **Quarantine** (an amber pill) and its
   reason; Calgary warehouse and the other demo locations read **Usable** (green).
2. Inventory status filter → **Quarantine** → **Apply**: "1 matching record", QA-HOLD alone.

## §2 Stock in quarantine is on hand, not usable

1. Inventory → **Stock by item**: Field notebook reads On hand **10**, Usable **6**, Reserved **0**, Available **6**,
   Open demand **8**, Projected **-2**, Status **Shortage** — the 4 in quarantine do not hide the shortage.
2. The **Buying worklist** has the same Usable and Available columns (the notebook has no reorder point, so it is
   not listed there until you give it one on its form).
3. More → Catalog → **Item** → **Field notebook**: Stock by location reads Calgary warehouse **Usable** 6 / 0 / **6**
   and QA-HOLD **Quarantine** 4 / 0 / **0** — nothing is available at the hold.
4. Sales → Sales orders → the confirmed order of 8 notebooks: its fulfillment line reads Short **2**, and its
   supporting details Free stock now **6**.

## §3 A status changes only with a reason

1. More → Location → **QA-HOLD**: the header reads **Quarantine**, with the reason and when it changed.
2. Record actions → **Edit**: the form edits Code, Name and Type — no status, reason or time.
3. Back on the page → **Change status**: Inventory status starts at Quarantine. Choose **Usable**; the Reason is
   required. Type "Inspected and released" → **Review** → **Confirm**: "Change status: done".
4. The header reads **Usable** with the new reason. Stock by item now reads Usable **10**, Available **10**,
   Projected **2**; the item page shows QA-HOLD Usable with 4 available; the order line is short **0**.

## §4 The widened types

More → Location → **New**: Type offers Warehouse, Store, Storage, Receiving, Shipping, Quarantine, In transit, Scrap
and Yard, and the form asks for no status: a new location is **Usable** until its page changes it.

## Not in this slice

Warehouses containing locations, a warehouse filter on the stock Lists, transfers between warehouses through
in-transit with "Receive transfer", and receiving into the item's preferred location wait on RELATION-INSTALL. Posting
does not yet refuse to reserve or ship from a quarantined location (ruling L-C): the figures exclude it.
