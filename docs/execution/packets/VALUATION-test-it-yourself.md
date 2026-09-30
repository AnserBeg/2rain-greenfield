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
the page shows the same average, known value and unvalued quantity.

Each currency is labelled separately. There is no converted or combined value.
