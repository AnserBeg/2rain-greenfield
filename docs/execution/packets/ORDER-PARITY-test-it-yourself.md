# ORDER-PARITY — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-order-parity`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --distributor`,
then open the printed URL. Ctrl-C stops it and removes its container.

## §1 The Sales orders List shows what is left to ship

1. Sales → Sales orders: the List has Ordered, Shipped and Open columns and a **To ship** tab after All.
2. Open a confirmed order with a line of 5, ship 2 of it (Fulfillment → ship), and go back to the List:
   the row reads Ordered 5, Shipped 2, Open 3 and is under To ship.
3. The row's action reads **Fulfill SO-…**: Enter opens the order at its Fulfillment section.
4. A closed or fully shipped order is not under To ship, and its action reads **View**.

## §2 The Purchase orders List shows totals and what is left to receive

1. Purchasing → Purchase orders: a **Total** column (not sortable) and Ordered, Received, Open;
   tabs **To receive** and **Late**.
2. A released order's Total equals the Total on its page.
3. A released order with an Expected date in the past is under Late, its Expected date reading "N days late".
4. Its action reads **Receive PO-…** and opens the order at its lines; a received or closed order reads **View**.
5. On a receipt form, the purchase-order picker still offers the same orders (it now reads the plain list).

## §3 At phone width

Narrow the window to about 390 px: each List keeps its tabs, the row action is a labelled line on the card,
and nothing scrolls sideways.
