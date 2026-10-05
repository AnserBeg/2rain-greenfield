# SALES-EXTRAS — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-sales-extras`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --distributor`,
then open the printed URL. Ctrl-C stops it and removes its container. The fixture's Field notebook has 10 on hand at
the Calgary warehouse.

## §1 Credit limit and credit hold

1. Party → open **Whitecourt Forestry**. The header reads **Credit: No limit**; Details show its open balance.
2. Record actions → **Set credit limit**: `500`, currency CAD → Review → Confirm. Credit reads **Within limit**,
   Available credit **500.00**.
3. Sales orders → **New**: customer Whitecourt Forestry, one line of 50 of any item (over 500 in total) → Save draft.
   The order page's Details show the customer's Credit limit, Open balance, Confirmed, not invoiced and Available credit.
4. Record actions → **Confirm**: refused, **CREDIT_LIMIT_EXCEEDED**. The order stays a draft.
5. Back on the customer: **Put on credit hold**. Credit reads **On hold**; Confirm on any of its orders is refused
   with **CREDIT_HOLD**. **Release credit hold**, set the limit to `0` (no limit): Confirm goes through, and the
   order's total now counts under Confirmed, not invoiced.
6. An order in USD for a customer whose limit is in CAD is refused with **CREDIT_CURRENCY_MISMATCH**.

## §2 Price lists

1. More → Catalog → **Price list** → New: code `WHOLESALE`, name, currency CAD, priority `10`, status Active → Save.
2. Open it: **Add price** for an item from quantity `1` at a price below its list price, and again from `10`
   at a lower one. **Assign customer**: Whitecourt Forestry.
3. Sales orders → New, customer Whitecourt Forestry, choose that item, quantity `4`: the unit price is the list's
   1+ price, **Line 1 price list** reads WHOLESALE. Change the quantity to `12` and press Enter: the 10+ price.
4. Type your own unit price, change the quantity again: your price stays (the list price moves). Save: the line
   reads **Manual price**; a line left at the list's price reads **Price list**, with WHOLESALE beside it.
5. **Deactivate** the list (or order in USD): new lines take the item's own list price again.

## §3 Counter sale

1. Sales orders → New: customer **Counter (walk-in)** — CAD, due on receipt, ship-to "Store counter" fill in.
   Two lines of Field notebook, `3` and `2` → Save draft.
2. Record actions → **Counter sale: take payment**. Both lines are listed. Ship from **Calgary warehouse**,
   Paid by **Cheque**, reference `CHQ-1042` → Review → Confirm: **Counter sale: take payment: done**.
3. Back on the order: **Released**, Details **Counter sale: Yes**; Shipments and packing has one **posted** shipment
   by **Counter**; Invoices has one **Paid** invoice, Balance **0.00**. The counter Tasks are no longer offered.
4. Sales orders List → the **Counter sales** tab counts and lists it; Inventory → Posted stock shows 5 fewer
   Field notebooks at the Calgary warehouse.
5. Another draft → **Counter sale: on account**: the invoice posts **Open** with its whole balance; no payment.
6. Put the customer on credit hold (§1.5), then run a counter sale: it stops at Confirm with **CREDIT_HOLD**;
   the order stays a **Draft** (marked a counter sale) and nothing is reserved, shipped or invoiced.
