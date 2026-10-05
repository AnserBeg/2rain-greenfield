# RETURNS — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-returns`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --distributor`,
then open the printed URL. Ctrl-C stops it and removes its container. Each section takes a few minutes.

## §1 Take goods back from a customer

1. Create and confirm a sales order (any customer, a complete ship-to, line 1 **OFF-100** quantity 3).
   Select the line → **Reserve stock** 3 at **Calgary warehouse**; select the reservation → **Ship reserved stock** 3.
2. Select the line → **Receive return**: quantity 1, **Return into location** = **Edmonton store**, reason **Damaged**,
   **What came back** "cover torn" → Review → Confirm. The line reads **Shipped 3**, **Returned 1**; the order's
   **Returns** section lists **RMA-000001**, Posted, returned into Edmonton store.
3. Inventory → Posted stock: Edmonton store holds one more OFF-100; Calgary warehouse is unchanged by the return.
4. **Receive return** for 3 is refused, naming the line, shipped 3, returned 1 and attempted 3: only two shipped units
   have not come back.
5. **Invoice shipped quantities** still invoices all 3: a return changes neither shipped nor invoicing (credit is a
   separate step).

## §2 Reverse a return

1. In **Returns**, select RMA-000001: **Return lines** show what the line still adds to stock (**Still returned 1**).
2. **Reverse return** with a reason → Review → Confirm. The line reads **Returned 0**; Returns lists the reversal
   (Kind **Reversal**), taken back out of Edmonton store; RMA-000001's lines now read **Still returned 0**, so a
   second reversal has nothing left to take back.

## §3 The Returns List

1. Sales → **Returns**: tabs All / Posted / Draft, a Kind filter, CSV export; newest first.
2. A row opens the return document: its sales order, where it went, why, and its lines.

## §4 Send goods back to the supplier

1. Create and release a purchase order (vendor **Alpine**, line 1 **OFF-100** quantity 4); select the line → **Receive
   with cost explicitly absent** 4 at Calgary warehouse. The line reads **Received 4**, **Open 0**.
2. Select the line → **Return to vendor**: quantity 1, **Return from location** = Calgary warehouse (any active location
   may be chosen), reason **Defective**, **What goes back** "spine split" → Review → Confirm. The line reads
   **Received 3**, **Open 1**; **Vendor returns** lists **VRT-000001**.
3. A replacement: receive 1 more → Received 4, Open 0. A refund instead: **Close open remainder** (ordered becomes 3),
   then Close the order.
4. **Return to vendor** for 5 is refused: no more can go back than the line has received.
5. On a closed purchase order, Return to vendor is not offered; Reopen it first.
