# PURCHASING-PARITY — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-purchasing-parity`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --distributor`,
then open the printed URL. Ctrl-C stops it and removes its container.

## §1 A priced purchase order (slice 1)

The fixture's Alpine Office Supply is also a supplier; it defaults to CAD, Net 30 and **GST-AB (5%)**.

1. Purchasing → Purchase orders → New. **Expected date** already reads the date 14 days from today.
2. Vendor **Alpine**: Currency CAD, Payment terms Net 30 and Tax code GST-AB fill in place; Freight tax
   code and Other fee tax code follow the order's, each with "tax rate %" 5 frozen beside it.
3. Line 1 product **OFF-100 Field notebook**, Quantity 3, Unit cost 12.5, Discount % 10: the line's
   Tax code GST-AB and Tax rate % 5 fill in place. Freight 25. Save draft.
4. The order shows **Total 61.69** and Payment terms Net 30; Priced lines read Amount 33.75, Tax 1.69;
   Details: Subtotal 33.75, Freight 25.00, Charges 25.00, Tax 2.94.
5. Change Line 1's tax code to none, Save draft: its Tax reads 0.00 and the total falls by 1.69.
6. **Print purchase order**: the priced lines and a totals list (Subtotal, Freight, Other fee, Tax, Total).
7. Release, then receive the line as before: the receipt still asks for the actual received cost, which is
   not the order's price. **Connected receipts** lists it as **RCV-000001** (the next receipt takes
   RCV-000002), instead of a generated id.

## §2 Ending an order properly (slice 2)

1. Purchasing → Purchase orders → New: vendor **Alpine**, line 1 **OFF-100 Field notebook**, quantity 5.
   Save draft, then Record actions → **Release**.
2. **Order lines** now read Ordered 5, **Received 0**, **Open 5**.
3. Select the line → **Receive with cost explicitly absent**: quantity 2, Calgary warehouse → Review →
   Confirm → Back to order. The line reads Received 2, Open 3.
4. Record actions → **Cancel** → Confirm: refused with RECEIPT_QUANTITY_OUT_OF_BOUNDS ("Cancellation is
   refused after any net receipt…"). The order is still Released.
5. Record actions → **Close** → Confirm: refused the same way (three are still open).
6. Select the line → **Close open remainder**: Reason "Supplier discontinued the rest" → Review → Confirm →
   Back to order. The line reads Ordered 2, Received 2, Open 0, and the action is no longer offered on it.
7. Record actions → **Close** → Confirm: the order is **Closed**. Reopen returns it to Released; Cancel is
   still refused, because something was received.
8. A second order with nothing received: Release, then Record actions → **Cancel** → Confirm: **Cancelled**.

## §3 Receiving paperwork (slice 3)

1. Purchasing → Purchase orders → New: vendor **Alpine**, **Receive into** Calgary warehouse, line 1 **OFF-100**,
   quantity 4. Save draft; the page's details show Receive into: Calgary warehouse. Record actions → **Release**.
2. Select the line → **Receive with cost explicitly absent**: **Receiving location** already reads Calgary
   warehouse. Quantity 4, **Packing slip / delivery note** `PS-1042`, **Notes** "Two boxes, one dented" → Review →
   Confirm → Back to order.
3. **Connected receipts** lists the new RCV- number with Packing slip PS-1042; open it to read the slip and notes.
4. Receive again leaving the slip and notes empty: the receipt saves with neither (empty, not blank text).

## §4 What is still to arrive (slice 4)

1. Purchasing → **Expected receipts**: tabs **To receive**, **Late** and **All released**, each with its count.
2. New purchase order: vendor **Alpine**, **Expected** three days ago, line 1 **OFF-100** quantity 6. Save draft, Release.
   Back on Expected receipts it is under To receive with Ordered 6, Received 0, Open 6, and under **Late**
   its Expected date reads "3 days late".
3. Receive 2 of it (Select the line → Receive with cost explicitly absent). The row reads Received 2, Open 4.
4. Close the line's open remainder (reason "Short shipped"): the order leaves To receive and Late (still under
   All released), and on the order page neither Receive nor Close open remainder is offered on that line.
5. Export CSV from To receive: the figures are exact decimals; at phone width the List keeps its tabs.
