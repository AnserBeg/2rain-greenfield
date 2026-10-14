# PAYABLES — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-payables`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --distributor`,
then open the printed URL. Ctrl-C stops it and removes its container.

## §1 Bill what arrived

1. Create and release a purchase order (vendor **Alpine**, line 1 **OFF-100** quantity 5 at a unit cost, freight 10).
2. Receive 3 (Select the line → Receive with actual cost). The progress panel shows **Billing** needing attention.
3. **Bill received quantities**, supplier invoice number `INV-7781` → Review → Confirm: a **BILL-000001** for 3 units
   at the order's cost, discount and tax, with the freight; due date = today + the order's terms.
4. A second bill with the same supplier invoice number (any case or spacing) is refused.

## §2 Pay and credit

1. Open the bill: pay part of it (a **VPAY-** number); the balance drops.
2. Paying more than the balance, or a fraction of a cent, is refused.
3. Credit the rest (a **VCM-** number): the bill reads **Paid**; **Void** is no longer offered.

## §3 Lists and links

1. Purchasing → **Bills**: tabs by state; the bill is under Paid; CSV exports it.
2. The purchase order page lists its bill; receive the remaining 2 and **Bill received quantities** is offered again.

## §4 Three-way match and Cancel (increment 3)

1. On the order from §1, the line reads Billed 3, To bill 0 and **Matched** under the product; receive 2 more and it
   reads **Received, not billed** until you bill them.
2. Record actions → **Cancel**: refused while a live bill exists ("void its bills first"); void an unsettled bill and Cancel goes through.
3. On a bill, **Open purchase order** opens its order.
