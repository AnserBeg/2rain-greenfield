# VALUATION — Test it yourself

Run each slice in under ten minutes from `/home/rvham/2rain-greenfield-valuation`.
This isolated fixture seeds two posted receipts: 10 EA at CAD 5 and 10 EA at
CAD 15, plus 10 opening units with no cost. It creates its own disposable database.

```bash
node scripts/run-with-test-lock.mjs exclusive -- node --import tsx test/helpers/order-entry-fixture.ts --serve --verify
```

Open the printed `ORDER_ENTRY_URL`. In the same terminal, paste:

```json
{"phase":"valuation"}
```

The printed measurement names the item and company. Stop with Ctrl-C when done.
On this laptop PostgreSQL can exceed the harness's readiness bound before the
app starts; the hosted operations browser job executes the same isolated path.

## 1. Stock value

Open Catalog -> Inventory value. Find Field notebook. Expect On hand **30**,
Average cost **CAD 10**, Known value **CAD 200.00**, Unvalued quantity **10**.
The opening units contribute no guessed cost. Search for Field notebook and
export the List: the same known/unknown figures accompany its item row.
Open that item's page from Catalog -> Items. The selected company is stated;
the page shows the same average, known value and unvalued quantity, alongside
the existing CAD selling price of **12.50**. The PO estimate of 99 is not a cost.

Each currency is labelled separately. There is no converted or combined value.

## 2. Shipment cost and margin

In the fixture terminal, paste:

```json
{"phase":"valuation-shipped"}
```

Use its printed shipment, order and invoice IDs to open those records in the
selected company (Inventory -> Shipments; Sales -> Sales orders / Invoices).
The shipment has **CAD 40.00** known cost, **0** unvalued shipped quantity and
**Fully valued** coverage. Its Relieved inventory cost table shows the same
line relief. The order and invoice each show **CAD 40.00** cost and **CAD 60.00**
product margin: four units sold at 25, costed at the moving average of 10.
Freight of 10 and the other fee of 5 do not enter that product margin.
Print the invoice: internal cost and margin stay off the customer document.

Open Costed notebook in Catalog. A subsequent 10-unit receipt at CAD 30 means
current on hand is **26**, known value **CAD 460.00**, average cost
**CAD 17.692308** and unvalued quantity **0**. The earlier shipment still relieves
40.00; it does not use that later average. These are derived operational figures.
