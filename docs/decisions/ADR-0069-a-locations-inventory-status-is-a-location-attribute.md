# ADR-0069: A location's inventory status is a location attribute, not a stock dimension

Date: 2026-10-05
Status: accepted (owner ruling L-A, 2026-10-04: the recommended choice)
Tier: Behavioral (review per `review-tiers`; no Critical-set file changes)

Interprets plan §12.6 for quarantine/quality status and bins. Leaves
[ADR-0016](ADR-0016-stock-identity-dimension-set.md)'s versioned stock-dimension set and
its re-baseline operation untouched: set v1 stays.

## Context

Plan §12.6 says every N3 capability "that adds a member to stock identity —
lot/batch, serial, expiry, quarantine/quality status, bins — arrives through
ADR-0016's versioned stock-dimension set". The parity reference (PaneFlow
`d057daff`) keys stock by product × location: a location carries a type, an
inventory status (usable, quarantine, damaged, in transit, return pending) and
a parent; availability counts usable locations only; and putting stock in
quarantine is a move into a location with that status
(`lib/server/advanced-domain.ts` `moveInventory`, `saveLocation`). Packet
LOCATIONS brings that to Rain.

## Decision

1. **Quarantine/quality status and bins are attributes of a location**, not
   members of stock identity. A posted balance stays keyed exactly as set v1
   keys it (item × location × unit, per company); a location states its
   inventory status and, once RELATION-INSTALL lands, its parent. No stock
   dimension, ledger column or posted movement changes.
2. **What stock may be used for is read through its location.** Usable stock
   is stock at a live location whose status is usable; Available is usable
   stock less what reservations hold at usable locations; projected supply
   starts from usable stock. Every reader derives this at read time from the
   location's current status; nothing is stored per balance.
3. **Moving stock between statuses is a transfer between locations**, as in
   the reference. Changing a location's own status reclassifies what it holds,
   in place, and is a declared operation with a reason (the location page's
   "Change status", one governed update of status, reason and instant).
4. **Refusing to reserve or ship from an unusable location inside the posting
   kernel is out of this decision** (ruling L-C): it is a Critical-set change,
   deferred to its own packet. Until then the status is shown and excluded
   from every availability figure, not enforced at posting.

§12.6's dimension rule therefore applies to lot/batch, serial and expiry —
attributes of the stock itself — and not to status or bins, which describe
where stock is.

## Consequences

- No re-baseline and no new dimension-set version; the release lineage gains
  one ordinary entry (a status column whose declared default is usable on
  the released location table, a widened type CHECK).
- A status history is the location's change journal and its last reason; a
  per-unit or per-lot status (PaneFlow's serial units) would be a dimension
  and needs its own ruling with lot/serial (I17).
- Until L-C lands, a reservation or shipment may still name an unusable
  location; the figures do not count it as available.

## Evidence

PaneFlow `d057daff`: `db/schema.ts` (locations), `lib/server/advanced-domain.ts`
(`saveLocation`, `moveInventory`), `lib/server/reports.ts`
(`replenishmentWorklist`). Design notes: parity-notes
`design-structural-gaps.md` §4 "Locations"; audit rows I9, I10.

## Enforcement

`test/postgres/locations.test.ts` and `test/unit/canonical-model/surface-list.test.ts`
(the usable figures read the location's status through the id each row holds);
the dimension set's own tests (`inventory-dimension-set-replay`) are unchanged.
