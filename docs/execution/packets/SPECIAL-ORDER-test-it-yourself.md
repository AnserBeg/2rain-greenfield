# Test SPECIAL-ORDER yourself (under ten minutes)

Use the local demo with its seeded buyer, customer, supplier, stock item and receiving location. No production sign-in, stock posting policy or existing stock is changed by route selection.

1. Open Sales orders, create a draft for the demo customer, and enter a complete ship-to. Add a line for 5 units, choose **Special order**, and select an active **Supplier**. Save and Confirm.
2. Select the line. Create special-order PO, review and confirm. The line now names its linked purchase line/order. Repeat the action: the same link remains, rather than a second purchase line.
3. Before receipt, Arrived and Arrived to reserve are zero; Reserve for the special order is not offered. A direct reserve request is refused with `SPECIAL_ORDER_ARRIVAL_LIMIT` (or `SPECIAL_ORDER_SUPPLY_LINK_REQUIRED` before linking), even when unrelated stock exists.
4. Open purchase order from the selected line. Enter its purchase price if billing is wanted, then expand More actions and Release / Place order. The line's route is Special order, not Drop ship.
5. Select the purchase line, Receive with cost absent (or actual cost), enter 2 units and choose the receiving location. Review and confirm. Received and Arrived are 2; the normal receipt has entered stock. Receiving has not created a reservation.
6. Return to the linked Sales order. Arrived is 2. Select the line and choose Reserve for the special order. Choose its stock location. Review shows 2 units, derived from arrived supply; confirm. Covered becomes 2 and the reservation Task disappears until more supply arrives.
7. Select the reservation and Ship reserved stock for 2 units, entering the required carrier/tracking information. Review and confirm. Shipped is 2; 3 remain open. The receipt and shipment are ordinary stock movements, not supplier delivery documents.
8. Receive the remaining 3 on the same purchase line. The explicit reservation Task offers those 3. Stock lines retain Reserve stock; Drop ship still uses Record supplier delivery and never warehouse receipt/reservation.

Receipt corrections/reversals that would remove supply already reserved or shipped refuse by name. Release the reservation or correct the shipment first; no automatic reservation is hidden inside receipt posting.

Automated evidence: `test/postgres/special-order.test.ts` (commercial PostgreSQL), `apps/web/test/browser/purchase-special-order.spec.ts` (operations browser), focused unit/integration tests and the shared web contract.

On the shared laptop, check Windows free memory >= 1.2 GB before taking the exclusive test lock; run one container-backed test file at a time, browser workers 1. The full acceptance matrix and snapshot regeneration run on GitHub.
