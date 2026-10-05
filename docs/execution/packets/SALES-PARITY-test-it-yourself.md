# SALES-PARITY — Test it yourself (supporting artifact)

Each section runs in under ten minutes against a fresh tenant. Serve from
`/home/rvham/2rain-greenfield-sales-parity`:

    node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --distributor

Open the printed `ORDER_ENTRY_URL`. Ctrl-C stops the server and removes its
database container. §1 adds `--order-volume=120` to that command.

## §1 Shared List (slice 1)

1. Sales orders shows tabs **All 120 · Draft 68 · Released 40 · Closed 0 · Cancelled 12**, "120 matching records", "Page 1 of 3", newest order date first, customer names (never ids).
2. Draft: "68 matching records", every status Draft. Tab with the keyboard and press Enter on a tab: same result.
3. Search `Chestermere`, then Apply: only that customer's orders; every tab count now counts within the search.
4. Click the Customer header: A→Z (↑); click again: Z→A (↓).
5. All, Currency USD, Apply: "24 matching records". Clear.
6. Next, Last, then type 9 in the page box and Go: you land on Page 3 of 3, never an empty page.
7. Draft → Export CSV (68): the file has 68 rows plus a header; statuses read Draft, customers by name.
8. Narrow the window to phone width: the tabs scroll sideways inside their strip, orders become cards, the page never scrolls sideways.
9. Inventory → Posted stock: SKU, item name and location code, sortable, exportable. Purchasing → Purchase orders: the same tabs and filter (empty).
10. With JavaScript disabled, every tab, sort, filter, page and export still works (plain links and forms).

## §2 Numbering (slice 2)

1. Sales → New: there is no Order number field. Pick a customer, add a line, Save draft: the order opens as **SO-000001**; a second order is SO-000002.
2. Purchasing → New, save: **PO-000001** (its own sequence). Reserve and ship a confirmed order: the shipment is **SHP-000001**.
3. Edit a draft: the number cannot be changed. Archive an order and create another: the archived number is not reused.

## §3 Confirm, Reopen, carrier and tracking, print (slice 5a/6)

1. Open a saved draft (with a complete ship-to, §4): Record actions offers **Confirm** (not "Release"); after it the order reads Released.
2. Select a line → Reserve stock → pick a location → confirm. Select the reservation → **Ship reserved stock**: Carrier, Reference type (Tracking number or Bill of lading) and "Tracking or BOL number" are required.
3. The order's Shipments show Carrier and "Tracking or BOL"; Open packing shows them with the ship-to it went to.
4. **Print sales order** opens a printable page with the header, lines, notes and a Ship to block; the browser's Print saves it as PDF. Purchase orders print the same way.
5. Close a fully shipped order, then Record actions → **Reopen** (asks for confirmation): it is Released again.

## §4 Customers, salespeople and ship-to (slice 3)

1. Party → Party list → **Whitecourt Forestry**: the customer workspace reads Default currency CAD, Payment terms Net 30, Default salesperson Jordan Blake, Default ship-to Main delivery; Roles and Ship-to addresses below.
2. **Add ship-to address**: North yard, Yard office, 4500 Forestry Road, Whitecourt, AB, T7S 1A2, Canada → review → confirm: the book lists Main delivery and North yard.
3. Select North yard → **Use as default ship-to**. **Set order defaults**: USD, Net 45. **Set default salesperson**: only salespeople are offered (Avery Chen, Jordan Blake, Priya Natarajan, Morgan Lee); choose Priya Natarajan. The header facts update.
4. Sales → New → Customer **Whitecourt**: Salesperson Priya Natarajan, Currency USD, Payment terms Net 45, Ship-to address North yard and its six lines fill in place.
5. Open **Ship-to address**: only Whitecourt's two addresses are offered. Choose Main delivery: the lines change to it. Add a product line and Save draft.
6. The order header shows Salesperson and Payment terms; Details show the ship-to. Record actions offers Confirm. Edit, clear City, Save draft: Confirm is no longer offered; restore City and it returns.
7. Sales orders shows a **Salesperson** column; search `Priya` finds the order.
8. Repeat step 4 with JavaScript disabled (Search, then choose): the same defaults fill by page answers.

## §5 Prices, discount, tax, charges and totals (slice 4)

The fixture's Alpine Office Supply orders in CAD taxed by **GST-AB (5%)**; its Field notebook lists at 12.50 CAD, 9.25 USD, 8.50 EUR. Distributor customers carry GST (Alberta) or GST + BC PST (British Columbia); distributor items carry prices in all three currencies.

1. Sales → New → Customer **Alpine**: Tax code GST-AB; Freight tax code and Other fee tax code follow it, with "tax rate %" 5 frozen beside each.
2. Line 1 product **OFF-100 Field notebook**: Unit price 12.5, List price 12.5, Tax code GST-AB, Tax rate % 5 fill in place. Quantity 3, Discount % 10, Freight 25; Save draft.
3. The order shows **Total 61.69**; Order lines read Amount 33.75, Tax 1.69, Price "List price"; Details: Subtotal 33.75, Charges 25.00, Tax 2.94.
4. Edit → Currency **USD** → Save draft: the untouched line re-prices to 9.25 (Amount 24.98, Tax 1.25, Total 52.48).
5. Edit → Line 1 unit price **10** → Save draft: Price reads "Manual price"; Amount 27.00, Tax 1.35, Total 54.60.
6. **Print sales order**: the priced lines and a totals list (Subtotal, Freight, Other fee, Tax, Total).
7. Catalog → Tax codes: GST, GST-PST-BC, HST-ON, EXEMPT, GST-AB; a tax code's rate can change for future lines, and a line keeps the rate it froze.

## §6 Invoices, payments and credits (slice 7)

Serve the metadata-sales fixture instead: `node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/meta-sales-fixture.ts --serve`, then open the printed `META_SALES_URL` (a confirmed Alpine Office Supply order: 10 EA of Field notebook at 12.50, untaxed, stock at the Calgary warehouse).

1. Record tasks does not offer **Invoice shipped quantities** yet: nothing is shipped.
2. Select the line → Reserve stock 3 at Calgary warehouse; select the reservation → Ship reserved stock 2 (carrier and tracking number).
3. **Invoice shipped quantities** → review → confirm. Invoices lists one **INV-** invoice, Open, Total 25.00; the task is no longer offered.
4. **Open invoice**: Total 25.00, Balance 25.00, a due date; one line of 2 EA, Amount 25.00.
5. **Record payment** 30 → refused (`RECEIVABLES_AMOUNT_EXCEEDS_BALANCE`), nothing changes. Record payment 10 by Cheque, reference CHQ-2207: Balance 15.00, **Partially paid**, a **PAY-** row; **Void invoice** is no longer offered.
6. **Issue credit** 5, reason "Two covers scuffed": Balance 10.00, a **CM-** row.
7. **Print invoice**: the line and Subtotal, Charges, Tax, Total, Paid 10.00, Credited 5.00, Balance 10.00.
8. Back on the order, ship 1 more and invoice again: a second invoice of 12.50. Open it → **Void invoice**: Void, Balance 0.00; the order offers Invoice shipped quantities again.
9. Sales → **Invoices**: tabs All 2 · Open 0 · Partially paid 1 · Paid 0 · Void 1 (after step 8, before re-invoicing), customer names, CSV export.
10. Close the order after shipping everything: Record actions → **Reopen** is refused while an invoice counts (`RECEIVABLES_ORDER_NOT_REOPENABLE`).

## §7 Money with two decimals and a requested date three weeks out (slice 8)

Serve either fixture above.

1. Sales → New: **Requested date** already reads the date 21 days from today (00:00 UTC); change it or keep it, then Save draft.
2. Open a priced order (§5): Unit price, List price, Amount, Tax, Freight, Other fee and the totals read with two decimals and grouped thousands (`12.50`, `1,234.50`); a price stored with more decimals (`12.345`) is shown whole, never rounded.
3. §6's invoice figures, payments, credits and printed totals read the same way (`25.00`, `15.00`, `10.00`, `5.00`).
4. Sales → Invoices: Total and Balance columns read with two decimals; **Export CSV** keeps the stored values (`25`, `12.5`).
5. Purchasing → a purchase order: the lines' **Unit cost** reads with two decimals.
