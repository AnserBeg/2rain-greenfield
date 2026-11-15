# WAREHOUSE-MODE — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-warehouse`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve`,
then open the printed URL. Ctrl-C stops it and removes its container. The demo seed holds 10 **Field notebook**
(OFF-100) at **Calgary warehouse**, put there by the opening stock document **STK-000001**.

## §1 The Warehouse

1. Inventory → **Warehouse**. The company bar names the company (the only one is picked for you). Three large
   tiles: **Receive** 0 *To receive*, **Put away** 0 *Transfers*, **Pick and ship** 0 *To ship*. There is no Count
   tile: counting waits for STOCK-COUNTS. The cursor is already in **Scan or type a SKU or document number**.
2. Type **OFF-100** and press Enter: the Field notebook item page opens, **Stock by location** reads Calgary
   warehouse 10.
3. Back to the Warehouse, type **stk-000001** (any case) and Enter: the opening stock document opens.
4. Type **Field notebook** and Enter: *Code is not exact* (a name never opens anything). Type **NOPE-1**: *Nothing
   matches that code*. Either way the code stays in the box and nothing else changes.
5. Purchasing → Purchase orders → **New**: any vendor, a line of 5 Field notebook → Save → **Release**. The
   Warehouse now reads **Receive 1**; the tile opens Expected receipts on its *To receive* tab, whose count is the
   same 1. Scan the order's number (**PO-000001**): the order opens, with its Receive task on its lines.
6. Inventory → Inventory transactions → **New** → Type **Transfer**, Reason Relocation, Calgary warehouse → Edmonton
   store, 2 → **Save draft**. The Warehouse reads **Put away 1**; the tile opens the *Transfers* tab.
7. Narrow the window to a phone (about 390 px): one tile per row, the page scrolls down and never sideways, and
   **Open** stays at the bottom of the screen.

## §2 The period lock

1. Inventory → **Inventory period lock** → the company's row. The page reads *Posting period*; with nothing closed
   it offers only **Close period through**.
2. **Close period through** → *Close through (UTC)*: today's UTC date, 23:59:59 → **Review Close period through** (it shows
   the instant as stored, `…T23:59:59.000Z`) → **Confirm Close period through**: *Close period through: done*.
   Reopen the lock page: its title is that instant, and **Reopen to** is now offered.
3. Post a stock document dated now: Inventory transactions → New → Adjustment, Reason **Found**, To **Calgary
   warehouse**, 1 → Save draft → **Post** → **Confirm Post**: refused, `INVENTORY_PERIOD_CLOSED`. Nothing moves.
4. **Close period through** yesterday at 00:00 → Review → Confirm: refused, `MODULE_PERIOD_LOCK_DIRECTION_INVALID`.
   Closing never moves the date back; only Reopen does, under its own permission and confirmation.
5. **Reopen to** → yesterday at 00:00 → Review → **Confirm Reopen to**: *Reopen to: done*. Open the stock document
   from step 3 again → **Post** → **Confirm Post**: *Post complete*.
