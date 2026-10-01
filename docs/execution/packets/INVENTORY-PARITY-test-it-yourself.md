# INVENTORY-PARITY — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-inventory`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve`,
then open the printed URL. Ctrl-C stops it and removes its container. The demo seed holds 10 **Field notebook**
(OFF-100) at **Calgary warehouse**.

## §1 Stock on the item page

1. More → Catalog → **Item list** → **Field notebook**. The company bar names the company: with one company it is
   picked for you; with several, the one you chose last.
2. **Stock by location** reads Calgary warehouse: On hand 10, Reserved 0, Available 10. **Recent movements** lists
   the opening adjustment, newest first, with its location, change, unit, source and reason.
3. On a confirmed sales order for Field notebook, select its line → **Reserve stock** at Calgary warehouse: back on the
   item page Reserved rises and Available drops by the same amount; On hand moves only when a shipment posts.

## §2 An adjustment entered like a document

1. Inventory → **Inventory transactions** → **New**. The editor opens as an **Adjustment** whose **Effective date**
   is now — today's date and the current time (UTC), not midnight (ruling INV-A). There is no number, state or
   source to type.
2. Reason **Damaged**, a narrative, line: Product **Field notebook**, From **Calgary warehouse**, Quantity **-2**
   (Unit reads EA) → **Save draft**: the page opens **STK-000002** (the seed's opening stock is STK-000001).
3. **Post** → **Confirm Post**: "Post complete". Open the document again (Inventory transactions → STK-000002):
   its **Posted movements** read Calgary warehouse, -2, DAMAGED, and the item page shows 8. The stock you took
   arrived today, and the Post is not refused.
4. A **Found** line of 3 entered under From saves as a draft; its Post is refused
   (`INVENTORY_POSTING_INPUT_INVALID`: a positive adjustment adds at its To location). A line of **-999** is refused
   as `INVENTORY_STOCK_NEGATIVE`. Neither changes stock: open either document again and it is still a draft.

## §3 Transfers and opening stock through the same Post

1. **New** → **Transfer**, Reason **Relocation**, From **Calgary warehouse** To **Edmonton store**, **5** → Save →
   Post; reopened, the document lists two transfer movements, -5 and +5; the item page shows Calgary 3 and Edmonton 5.
2. With some of Calgary's stock reserved (§1.3), try to move all of Calgary's on hand: refused
   (`FULFILLMENT_RESERVATION_SHORTAGE`); nothing moves.
3. **New** → Adjustment, Reason **Opening stock**, To **Beltline store**, **20** → Post: Beltline reads 20.
   The same into Calgary warehouse, which holds stock, is refused.

## §4 The List

Inventory → Inventory transactions: tabs **All**, **Drafts**, **Adjustments**, **Transfers**; each row's Number is
STK-…, with Type, Reason, Effective and State; a posted document opens read-only with its movements (Reason,
Recorded). Receipts and shipments appear as their own companion transactions (GR-/SH-), never renumbered.
