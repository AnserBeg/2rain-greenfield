# DROP-SHIP — Test it yourself

Draft checkpoint: the [Critical relation-install bridge](DROP-SHIP-RELATION-INSTALL-design.md) is merged. The supplier-delivery PostgreSQL journey and new operations-browser spec passed in hosted run `37290557084`. Full DROP-SHIP CI is still pending after a separate rollback-test fixture correction; owner review of the bridge remains owed.

From `/home/rvham/2rain-greenfield-drop-ship`, first check Windows free memory:
`powershell.exe -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory"`.
Start only above 1.2 GB, with no other container-backed work running:
`node scripts/run-with-test-lock.mjs exclusive -- node --import tsx test/helpers/order-entry-fixture.ts --serve --distributor`.
Open the printed URL. Ctrl-C stops the fixture and removes its container.

## Linked demand and supply

1. Sales → Sales orders → Create. Choose Alpine, CAD and its complete customer ship-to.
2. Add OFF-100, quantity 5, unit EA, price 12. Fulfillment route defaults to Stock; change it to Drop ship and choose Alpine as the supplier. Save and Confirm.
3. Select the Drop ship line, then Create drop-ship PO → Review → Confirm. The action creates supply for the order's drop-ship lines. Each sales line shows its route and linked purchase line/order; repeating the action reuses the links.
4. Open purchase order from the sales line. Its ship-to is the customer's address. Edit the draft line's unit cost to 7 and save; Release (place) the order.

## Delivery is not warehouse stock

1. Select the linked purchase line. Warehouse receiving is not offered. Record supplier delivery: quantity 2, supplier reference `SUP-DEL-1` → Review → Confirm.
2. The PO line reads Received 0, Delivered 2, Open 3. Open the linked sales order: Shipped 0, Delivered 2, Open 3. Drop-ship lines do not offer Reserve stock.
3. Both orders have a Deliveries section. Open DSD-000001; it links to both orders and retains the supplier reference. Inventory stock and movement history are unchanged.
4. Trying quantity 4 now is refused: only 3 remain on each linked line. A partially delivered order cannot close.

## Settle and correct

1. Invoice shipped quantities on the sales order also invoices the 2 delivered units at 12. Bill received quantities on the purchase order also bills them at 7. Three-way match includes delivered quantity but Received stays 0.
2. Open the delivery → Reverse supplier delivery, with a reason. While either live invoice or bill relies on those units, reversal is refused. Void both unsettled documents first, then reverse.
3. Both Delivered figures return to 0 and Open to 5. DSD-000001 remains visible as Reversed, with its original quantity and your reason; no stock reversal is posted.
4. Record a new delivery for 5. Both Open figures become 0, the open order views exclude them, and both orders can close. Reopen both before reversing a delivery on closed orders; live settlement floors still apply.

Stock orders keep their ordinary reserve/ship/receive workflow. `special_order` is a filed follow-up, not an offered route in this increment.
