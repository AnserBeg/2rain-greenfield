# SPECIAL-ORDER — dedicated purchase supply received into stock

Status: BUILD active on `packet/SPECIAL-ORDER`, based on DROP-SHIP `1b16c746`. No integration or deployment.

## Design (before implementation)

- Special order extends the existing fulfillment route and symmetric demand/supply line link. Create special-order PO creates or extends the supplier's draft PO with exactly one purchase line per sales line; repeated execution reuses the link.
- The existing supplier field is shared by Drop ship and Special order and labelled Supplier. Normal goods receipts enter stock; no delivery document, virtual location or new movement family is introduced.
- Reservation admission checks net linked receipts minus net shipped and live reservation coverage. Shipment admission checks resulting net shipped against net linked receipts. Named refusals distinguish missing supply from insufficient arrivals.
- Capability/lifecycle admission shares a company-scoped allocation mutex on the same connection used by the unchanged writer. It spans the guard and commit; it never replaces the kernel's stock locks. Receipt reductions cannot undercut shipped plus live reserved quantities; release and shipment corrections participate in the mutex.
- A declared selected-line Task, Reserve for the special order, uses the existing reservation create/reserve operations. Receiving never automatically reserves. Both orders expose route, linked line/order and Arrived through governed read models.
- Owned paths: application assembly metadata, capability/lifecycle executors and commercial/fulfillment read models, focused tests, generated release/coverage/schema artifacts, pins and packet records. Posting kernel, serializer, posting trigger/rebuild, activation/verification, trust, migrations and RLS/grants remain unchanged.
- PaneFlow's route/allocation behavior is a read-only reference; its receipt auto-reservation and multi-demand allocations are not copied.

## Rulings

- S-A: special-order goods arrive into ordinary stock (owner recommended choice).
- S-B: one purchase line per special-order sales line, using the existing link (owner recommended choice).
- S-C: explicit reservation Task only; no auto-reservation in receipt posting (owner recommended choice).

## Gates

Pending: focused unit/integration/web contracts; full hosted CI, commercial PostgreSQL and operations browser; hosted full-replay snapshot regeneration; compiled pins and language coverage; record fidelity.

Review: not owed — intended diff is outside the Critical set.
