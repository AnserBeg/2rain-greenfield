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
