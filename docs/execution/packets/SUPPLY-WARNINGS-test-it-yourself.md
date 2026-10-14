# SUPPLY-WARNINGS — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-supply-warnings`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --verify`,
then open the printed URL. Type `{"phase":"supply"}` and Enter into that terminal to seed the scenario below;
Ctrl-C stops it and removes its container. The demo seed holds 10 **Field notebook** (OFF-100) at **Calgary warehouse**; the
phase adds, through the governed operations: 20 more notebooks by adjustment, 4 moved into a quarantined
**QA-HOLD**, and six sales orders of notebooks (order numbers are the server's; they are told apart by quantities):

| Order | State | Lines | Reserved |
|---|---|---|---|
| A | Confirmed | 2 | 2 at the warehouse (stock reserved for this order) |
| B | Confirmed | 3 | 3 in QA-HOLD (covers its line, holds nothing usable) |
| C | Confirmed | 3, of which 2 shipped | 3 at the warehouse, 1 still to ship |
| D | Confirmed | 20 and 10 | 4 at the warehouse for the first line |
| E | Confirmed | 5 | nothing |
| F | Draft | 30 | nothing |

Usable on hand is 24 (30, less 4 in quarantine, less 2 shipped); reservations hold 2 + 1 + 4 of it at the
warehouse, so **17** notebooks are free now.

## §1 Blocked by supply

1. Sales → **Sales orders**: the tabs read All **6**, To ship **5**, Blocked by supply **1**, Reserved **4**,
   Draft **1**, Released **5**, Closed **0**, Cancelled **0**.
2. **Blocked by supply** (try Tab and Enter): "1 matching record" — order D. Its **Short** reads **9** with a red
   **!**: its two lines leave 16 + 10 uncovered by its own reservation, and the 17 free cover all but 9.
3. Short is shown, never offered as a sort; **Export CSV (1)** writes the same row with Short 9.

## §2 Reserved and Post shipment

1. **Reserved**: "4 matching records" — A, B, C and D, each offering **Post shipment** (B's reservation in
   quarantine still covers its line; shipping from quarantine is not refused yet, ruling L-C).
2. Order E is not here: nothing is reserved for it, so it offers **Fulfill** on the All tab.
3. At phone width (390 px) the List scrolls down, never sideways; each card keeps its Short and its action.

## §3 The order page says the same

1. **Post shipment** on order D: the order page opens at its **Fulfillment** section, where you reserve and ship.
2. The Fulfillment lines read Short **0** (line 1, its 16 uncovered covered by the 17 free) and **9** (line 2) —
   9 in all, the List's figure; the **Fulfillment exception** banner names line 2.

## §4 A short draft

On **All**, draft F reads Short **13** with **!** (30 asked, 17 free), as its page's banner says, but it is not in
Blocked by supply — only a confirmed order waits for supply — and it offers only **View**.

## §5 Without stock read

1. In the fixture terminal type `{"phase":"deny","subject":"posted_stock_balance_read"}` and refresh the List.
2. It still serves: Ordered, Shipped and Open read as before, **Short** reads "—", and one line says "Short is
   withheld by current policy; Blocked by supply and Reserved need it and are unavailable." Those two tabs have no
   count; opening one refuses by name. Order D now offers **Fulfill** — nothing reserved can be stated.
3. `{"phase":"allow","subject":"posted_stock_balance_read"}` and refresh: Short 9 and its **!** are back.

## Not built

Incoming purchase orders are not counted (R1, until purchase orders can be marked ordered); the List shows Short
but no reserved quantity column; Post shipment links to the page's Task and never ships from the List.
