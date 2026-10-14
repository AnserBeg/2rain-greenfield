# RECEIVING-EXTRAS — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-receiving`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --verify`,
then open the printed URL. In that terminal type `{"phase":"order_pages"}` and Enter, then `{"phase":"incoming_supply"}`
and Enter; Ctrl-C stops it and removes its container. The phases add, through the governed operations:

- two placed purchase orders of **Field notebook** (OFF-100): the *truck* (lines 5, 2 and 4, nothing received) and the
  *delivered* order (6 and 3, one posted receipt of 4 and 3);
- **Task lamp** (OFF-210), nothing on hand: a placed order for 6 with 2 received (so 2 lamps are free and 4 still on
  order), a draft order for 50 and a placed order for 30 cancelled before anything arrived (neither counts);
- sales orders of lamps: **9** and **6** (confirmed) and **20** (a draft), told apart by quantity.

All instants read in UTC, as everywhere in Rain; "today" for the posting window is the company's business day in
Edmonton (America/Edmonton). The window is seven business days back, never after today, never inside a closed period.
So at 7 pm in Edmonton, Received on starts at tomorrow's UTC date: leave it and the receipt is booked today; changing
it to today's date would book it yesterday evening.

## §1 The day the goods arrived

1. Purchasing → **Purchase orders** → the truck (nothing received yet) → **Receive lines with actual cost**.
2. **Received on (UTC)** already holds now, to the second. Change only its date to tomorrow; **Fill open quantities**,
   empty line 2, enter a unit cost on lines 1 and 3, **Review**, **Confirm**.
3. Expected: "**Date is after today** — Stock is never posted on a business day after the company's today." with the
   code `RECEIPT_FORWARD_DATE_REFUSED` under it. Back on the order, Received still reads 0 on every line.
4. Again with a date nine days back: "**Date is too far back**" (`INVENTORY_BACKDATE_LIMIT_EXCEEDED`); nothing received.
5. Again with yesterday: "Receive lines with actual cost: done". Received reads 5, 0 and 4, and the posted receipt in
   **Connected receipts** reads yesterday's date and the time you entered, in UTC, under Received at
   (for example "Oct 12, 2026, 7:05 PM UTC").
6. The two refused attempts each left a **draft** receipt in Connected receipts (Filed below); a draft can be opened,
   its Received at edited and Post used, or left alone — it moves no stock.

## §2 Correct part of a receipt

1. Open the delivered order (Received 4 and 3). A second delivery: **Receive lines with actual cost** → **Fill open
   quantities** (only line 1 is offered, 2), unit cost **2.5**, **Review**, **Confirm**. Received reads **6** and **3**.
2. In **Connected receipts**, on the first posted receipt (the one of 4 and 3), **Open receipt**.
3. The receipt's page: its order (with **Open purchase order**), state *posted*, kind, Received at, location and packing
   slip; **Receipt lines** with Reversible **4** and **3**; **Corrections and reversals** (empty); the receiving links
   below; Post and the rest under **Record actions**.
4. **Correct receipt** → **Fill reversible quantities** (4 and 3). Set line 1 to **7**, empty line 2, give a reason,
   **Review**, **Confirm**: "**Quantity is beyond what was ordered or received**" (`RECEIPT_QUANTITY_OUT_OF_BOUNDS`):
   the order line has only received 6. Nothing moves; Reversible still reads 4 and 3.
5. Again with line 1 **5**: "**Correction exceeds the receipt**" (`RECEIPT_CORRECTION_INVALID`): the order line has
   6, but this receipt's line only added 4. Nothing moves.
6. **Correct receipt** again: line 1 **1**, line 2 empty, a reason. Review shows one line; Confirm → "Correct receipt:
   done". Reversible now reads **3** and **3**; Corrections and reversals lists a posted *correction*.
7. **Open purchase order**: Received reads **5** and **3**.

## §3 Short, unless it is on order

1. Sales → **Sales orders**. The lamp orders read: **9** — Short **3 !**, On order **4**; **6** — Short **0**, On order
   **4**; the draft **20** — Short **14 !**, On order **4**. Each order sees the 2 free lamps first, then the 4 still
   to arrive on the placed order; the draft order for 50 and the cancelled one count nothing.
2. **Blocked by supply** holds the lamp order of 9 (and the order_pages phase's notebook order, short beyond its own
   reservations, free stock and the notebooks on order) — never the lamp order of 6, which is covered by what is on
   order. **Export CSV** has an "On order" column after Short.
3. Open the lamp order of 6: its Fulfillment line reads Short **0** and On order **4**, and no "Fulfillment exception"
   banner. The order of 9: Short **3**, On order **4**, and the banner names the line.

## §4 Without purchase order read

1. Type `{"phase":"deny","subject":"purchase_order_line_read"}` and refresh the Sales orders List: it still serves;
   Short and On order read "—", one line says "Short and On order are withheld by current policy; Blocked by supply
   and Reserved need them and are unavailable.", and those two tabs have no count. The order of 9's page reads "—"
   for both too, never a shortage that ignores what is on order.
2. `{"phase":"allow","subject":"purchase_order_line_read"}` and refresh: the figures are back.

## Not built

A purchase order counts whatever its expected date (PaneFlow counts only orders due by the sales order's requested
date); a correction is dated now; the received date is a UTC date and time, not a calendar date.
