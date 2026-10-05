# RETURNABLE-ASSETS — Test it yourself

Serve the order-entry fixture from `/home/rvham/2rain-greenfield-returnables`:
`node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/order-entry-fixture.ts --serve --distributor`,
then open the printed URL. Ctrl-C stops it and removes its container. Under ten minutes.

## §1 A returnable type

1. Navigation → **Party** → **Returnable type** → **New**: Code `KEG-50`, Name `50 L keg`, Asset class: type `keg`
   and pick **Keg** from the suggestions (six classes make it a typed field, not a menu), Deposit cad `30` → Save.
2. Leave Deposit usd empty: an Issue in USD of this type is refused until you state one (0 for none).

## §2 Out with a customer

1. Party → Party → **Alpine Office Supply**. The page now carries the company in its address and shows an empty
   **Returnables** section.
2. **Issue returnables**: type `50 L keg`, Direction **Out with customer**, CAD, Quantity `6`, Deposit paid by
   **Cheque**, reference `CHQ-4410`, a reason → Review → Confirm. The section lists **RTN-000001**: Outstanding 6,
   Deposit held 180.00, Open.
3. **Open custody**: the facts read Outstanding 6, Deposit held 180.00, Refundable now 0.00; **Events** shows the
   Issue with its date, 180.00, Cheque, CHQ-4410, your reason and who recorded it. Refund deposit is not offered.
4. **Issue returnables** again for the same type, direction and currency from the party page: refused
   (`RETURNABLES_CUSTODY_DUPLICATE`, naming RTN-000001); the new record it started stays **New** (archive it) —
   issue more from the custody record instead (**Issue**).

## §3 Back, lost, refunded

1. **Return** 7: refused (`RETURNABLES_QUANTITY_EXCEEDS_OUTSTANDING`), nothing changes. **Return** 4: Outstanding 2,
   Refundable now 120.00.
2. **Forfeit** 2: Outstanding 0, **Awaiting refund**; the 60.00 on the lost kegs is kept (Deposit kept), Return and
   Forfeit are no longer offered.
3. **Refund deposit** 120.01: refused (`RETURNABLES_REFUND_EXCEEDS_DEPOSIT`). Refund 120 by **Bank transfer**:
   **Closed**, Deposit held 0.00. Four events, each dated and attributed.
4. Inventory → **Posted stock**: unchanged. Returnables never move stock.

## §4 The Lists

1. Party → **Returnables out**: tabs Open, Awaiting refund, Closed, All; RTN-000001 under Closed with **Alpine Office
   Supply** and `50 L keg`; CSV exports it.
2. On Alpine's page, **Issue returnables** with Direction **Held from supplier** and currency EUR (state a Deposit eur
   on the type first): Party → **Returnables held** lists it; Returnables out does not.
