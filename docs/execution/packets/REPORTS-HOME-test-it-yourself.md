# REPORTS-HOME — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-reports`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve`,
then open the printed URL **without** its `?surface=…` part (just the host and port). Ctrl-C stops it and removes its
container. The demo data has one company, the customer **Alpine Office Supply** (P-1001) and 10 **Field notebook**
at **Calgary warehouse**. Allow about ten minutes.

## §1 Today (the home view)

1. The bare address opens **Today** (Sales → Today in the sidebar). Six tiles, each a number: **Late receipts**,
   **Blocked sales orders**, **Approvals waiting**, **Receipts due**, **Ready to ship**, **Inventory risks**. With
   no orders yet each reads 0, except Inventory risks, which counts items at or below their reorder point.
2. Click **Blocked sales orders**: the Sales orders List opens on its *Blocked by supply* tab, with the same count.

## §2 Customer accounts (the CRM view and open orders by customer)

1. Sales → Sales orders → **New**: customer Alpine Office Supply, currency **CAD**, one line of 4 Field notebook at
   12.50 with 10% discount → Save → **Confirm**. Make a second order in **USD**: 2 Field notebook at 100 → Confirm.
2. Sales → **Customer accounts**. Only customers are listed (no supplier-only parties). Alpine reads Open orders
   **1**, Ordered units **4**, Open units **4**, Open value **45.00** (4 × 12.50 less 10%). The boxes above the grid
   say *Totals in CAD* and add every listed customer.
3. Change **Currency** to USD → Apply: Alpine now reads 1 order, 2 units, **200.00** — the USD order alone. Nothing
   is ever converted or added across currencies.
4. The **With open orders** tab keeps only customers with an open order in the chosen currency. **Orders** on a row
   opens the customer's account page at its orders.

## §3 Receivables aging and the customer statement

1. Open the CAD order → reserve and ship 4 (Fulfillment) → **Invoice shipped quantities** → Review → Confirm.
2. Sales → **Receivables aging**. Alpine owes the invoice total, all **Current** (due on receipt, so due today);
   Status *Current*; the boxes read the same Total owing and Current. *Past due* is 0.
3. Record a payment of 10 on the invoice (its page → Record payment). Aging drops by 10: it ages the balance.
4. **Statement** on Alpine's row → the **Customer account** page in this company: every invoice with Total, Paid,
   Credited and Balance, and the sales orders below. **Print statement** → the printable statement; use the
   browser's Print to save a PDF. Nothing is emailed.
5. Narrow the window to a phone (about 390 px): every page scrolls down, never sideways.

What you cannot see here: a balance moving between buckets as days pass (the PostgreSQL test walks one invoice
across each boundary: 0|1, 30|31, 60|61 and 90|91 days), and a second company (its reports show none of these).
