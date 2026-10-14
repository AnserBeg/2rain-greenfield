# CATALOG-EXTRAS — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-catalog`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --verify`,
then open the printed URL. Type `{"phase":"replenishment"}` and Enter, then `{"phase":"catalog_extras"}` and Enter, into
that terminal; Ctrl-C stops it and removes its container. The second phase, through the governed operations: **Field
notebook** (OFF-100) is known by the barcode **0012345678905** and Alpine's code **ALP-NB-80**; **Shipping labels**
(OPS-310) is non-stocked; **Fine-point pen set** (OFF-120) follows the company rule with Reorder up to **50**; the
company reorders at **40%**; and **Field notebook (duplicate)** (OFF-100-DUP) was entered twice by mistake.

## §1 Find an item by an alias

1. More → Catalog → **Item**: the Items List with SKU, Item, Unit, Inventory policy and Price (CAD); tabs **All**,
   **Stocked**, **Non-stocked** (Non-stocked holds Shipping labels).
2. Search **alp-nb** (any case, part of the code): only **Field notebook**. Search **0012345678905**: the same.
3. Purchasing → Purchase orders → **New** → Line 1 product: type **0012345678905** → **Field notebook** is offered.

## §2 Aliases on the item page

1. Open **Field notebook** (OFF-100): **Inventory policy** Stocked and **Reorder rule** Manual among its facts; an
   **Aliases** section lists 0012345678905 (Barcode) and ALP-NB-80 (Supplier code).
2. Record tasks → **Add alias**: Alias **NB-RULED-80**, Kind **Alternate SKU** → Review → Confirm: "Add alias: done".
   The section lists three aliases; §1's search finds the notebook by **nb-ruled** too.
3. Add the same alias to another item (Fine-point pen set → Add alias → **nb-ruled-80**): refused by name,
   `MODULE_UNIQUE_VIOLATION` — an alias names one item across the business, whatever its case.
4. On the notebook, Select **ALP-NB-80** → **Remove alias** → Confirm: searching **alp-nb** now finds nothing.
5. Record actions → **Archive** the notebook: refused by name, `MODULE_ARCHIVE_RESTRICTED` — an item is archived only
   once nothing restricting it names it: an active alias, or (as here, first) its stock movements.

## §3 Stocked or not, and the company rule

1. Inventory → **Stock by item**: tabs **All 5**, **Shortage 1** (Task lamp), **Reorder 1** (Fine-point pen set).
   Shipping labels reads Status **Not stocked**; it is in neither Shortage nor Reorder.
2. Fine-point pen set: Projected **0**, Reorder point **20** — 40% of its level of 50, worked out now, never stored.
3. Inventory → **Buying worklist**: **To buy 2** — Task lamp and Fine-point pen set (Suggested **50**); Shipping
   labels is never on it.
4. Inventory → **Legal entity** → the company → Edit: **Reorder point percent** (the generic form names a field by
   its id) 40 → **25** → Save. Back on Stock by item the pens read Reorder point **12.5**. Clear it (When … is blank →
   Clear stored value): the pens read **—** and Healthy — a company without a rule gives no reorder point.
5. Catalog → Item → **Shipping labels** → Edit: Inventory policy **Stocked** → Save: it is back on the Buying worklist
   (Reorder point 0, Projected 0).

## §4 Merging a duplicate

1. Open **Field notebook (duplicate)** (OFF-100-DUP) → Record tasks → **Merge into another item**: the Surviving item
   list offers OFF-100 and the others, never OFF-100-DUP itself. Choose **OFF-100** → Review → Confirm: "Task complete"
   (the duplicate is archived, so the page cannot show it any more).
2. Catalog → Item: the duplicate is gone from All; searching **OFF-100-DUP** finds **Field notebook**, whose Aliases
   now list OFF-100-DUP as **Merged SKU** with no Remove (a merged SKU stays).
3. Nothing moved: a duplicate with stock movements, inventory document lines or count lines, or with an alias of its
   own, is refused at the archive by name (`MODULE_ARCHIVE_RESTRICTED`) — its merged alias is still written, and no
   movement is ever re-pointed (the PostgreSQL witness checks both refusals).
