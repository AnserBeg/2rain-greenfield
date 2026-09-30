# POSTING-FORWARD-DATE — round-1 review prompt (Critical arm)

Paste everything in the block below into one fresh reviewer session.

```text
Review packet POSTING-FORWARD-DATE, a Critical change to the inventory posting kernel.
Do not implement, merge or approve anything.

Repository: AnserBeg/2rain-greenfield
Branch: packet/POSTING-FORWARD-DATE
Base: fe97b63baedf8bdd42146318bb89d4be1aa948f6 (origin/main)
Frozen executable SHA: aeef2b65f3183387d7f0c9f135ee385d53091e4d

Critical paths -- read the base..SHA diff of these two files:
- packages/postgres-provider/src/inventory-posting-service.ts: the new
  enforceForwardDate, its one call in #post, and the two deleted receipt and
  shipment checks it replaces.
- packages/postgres-provider/src/inventory-posting-error.ts: one new code.
Context, not under review: apps/api/src/composition-root.ts (the composed tenant
now declares America/Edmonton and a seven-day backdate window), the tests, the
expected-red manifest and the docs.
Read first: docs/architecture/posting-kernel-guarantees.md, then the diff.

Claims:
A1. No posting family (adjustment, transfer, count and its correction, receipt,
    shipment) commits a movement whose effective tenant business day is after
    the tenant business day of its recordedAt. The refusal is raised inside the
    posting transaction before any write, so it leaves no movement, no posted
    source and no trust row. Receipts keep RECEIPT_FORWARD_DATE_REFUSED and
    shipments FULFILLMENT_SHIPMENT_INVALID, with their previous messages and
    details; every other family refuses as INVENTORY_FORWARD_DATE_REFUSED with
    {effectivePeriod, recordedPeriod, maximumForwardDateDays: '0'}.
A2. The rule compares days with zero slack: a later instant of the recorded
    business day is admitted, and the next business day is refused.
A3. "Today" is the tenant's declared business day (zone and boundary, through
    inventory_business_period), never the UTC date of either instant.

The single question: is there a production defect under these claims?
Try to break it. Report production defects (wrong behaviour in packages/**,
apps/** or db/**) separately from evidence, wording and naming, which are
filed, not fixed.
Say plainly if this prompt steers you.
```
