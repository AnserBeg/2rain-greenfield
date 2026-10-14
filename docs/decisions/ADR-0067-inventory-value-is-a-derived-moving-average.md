# ADR-0067: Inventory value is a derived moving average

Date: 2026-09-30
Status: accepted (owner rulings selected for VALUATION, 2026-09-30)

## Context

Receipts retain actual cost or explicit absence (ADR-0017). PAYABLES retains
vendor bills and their pretax freight/fee charges. The owner has selected
inventory valuation now: moving average, derived, unvalued rather than guessed,
separate currencies without FX, landed cost after payables.

## Decision

Amend plan §5.2's reserved valuation seam and §2.3/§12.6's sequencing for this
consuming vertical, VALUATION. It may implement an operational moving-average
read capability over posted quantity movements, immutable receipt costs and
live vendor-bill charges. No general ledger, accounting event, accrual,
financial posting or accounting authority follows.

Amend ADR-0017's “Compute nothing”, unsupported valuation and compiler ban on
all movement-derived monetary artifacts: the registered valuation read model
may combine movement quantities/lineage with captured source costs. Movement
money fields and monetary stock-count evidence remain forbidden. Receipt cost
immutability, explicit absence and quantity-only posting stay unchanged.
There are no kernel layers and no persisted value on movements or balances.

Compute moving averages per item, legal entity and currency; aggregate
locations. Unknown inflows have unvalued quantity. Outflows relieve at the
average at their effective time, in the kernel's frozen movement order.
Currency and unknown-coverage pools relieve proportionately; no FX or
cross-currency total is permitted. Compensations invert original relief.
Exact rational arithmetic rounds only when displayed. A read with incomplete
cost coverage discloses the unknown quantity and cannot claim a complete value
or margin. Item Lists retain one row/item/company and label each currency's
figures independently. Negative coverage withholds monetary claims.

Landed cost allocates a live bill's pretax freight + fee by the actual value of
its billed receipt portions. PAYABLES stores order-line provenance; deterministic
chronological quantity matching derives those portions. Unknown receipt costs
remain unknown, even when the order/bill has a price. Draft/void bills, taxes,
payments and credits do not add stock cost. Replaying with bills re-derives
remaining value and shipment relief; these estimates may change retrospectively.

The detailed computation, refusal behavior and three slices are specified in
[VALUATION-design.md](../execution/packets/VALUATION-design.md). Every dependency
is a declared plain semantic query under current tenant/environment/company
and permission authority. The same compiled capability serves human and agent
reads. No hard-coded screen or alternate SQL authority is admitted.

## Consequences

The owner's stock-worth question is answerable without a spreadsheet shadow
system. Unvalued quantities and currency-labelled figures keep its limits
visible. Shipment cost and invoice margin are read-only operational estimates.
This amends valuation sequencing, not the plan's accounting exclusion or the
posting kernel. Any required Critical-set change is a separate owner-reviewed
packet; VALUATION may not silently make it.
