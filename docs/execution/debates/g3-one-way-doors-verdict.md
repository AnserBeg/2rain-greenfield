# G3 one-way doors — converged record (2026-07-28)

Two independent arms — Codex `gpt-5.6-sol` xhigh and Fable max — answered the
same charter with no shared context. Reconciled by the orchestrator reading the
ratified artifacts. Artifacts: `~/2rain-missions/g3-doors-{codex,fable}.result.txt`.

**Why this ran.** Six of G3's ten stage-cut obligations close permanently when
the first movement is posted, because ADR-0007 and plan §7.4 forbid rewriting a
posted fact. The cut document is explicit: a packet that posts without them
"does not create debt; it creates an unrecoverable condition."

**Charter correction.** The charter asked four questions. **Q2 was not open** —
`northstar.stock-dimension-set/v1 = (legalEntityId, itemId, locationId)` is
stated verbatim at ADR-0016:36 and plan line 1293. Codex flagged this directly
("the repository contradicts the prompt's premise"). Orchestrator error in
writing the charter; recorded because a debate charter is an authority document.

---

## V1 — Legal-entity classification

**Both arms independently ruled: there is no default. An undeclared family is a
compile-time diagnostic.** Adopted. Each candidate default causes a named
prior-art failure — `tenantShared` silently creates entityless facts that cannot
be attributed once keys and history exist (audit G2); `entityOwned` silently
duplicates the shared masters ADR-0015 calls ordinary.

| Family | Ruling |
|---|---|
| `legal_entity` (the master) | `tenantShared` — the roster cannot own itself |
| `party` | `tenantShared` |
| `party_role` | `tenantShared` |
| `item` / Catalog | `tenantShared` |
| `location` | `tenantShared` |
| `inventory_movement`, transactions, reservations, counts | `entityOwned` |
| undeclared | **compilation failure — no default** |

**The arms split on `party_role` and `location`. Fable's assignment is adopted.**

**Location — decided by the ratified tuple.** ADR-0016 keys stock by
`(legalEntityId, itemId, locationId)`, carrying entity **independently of**
location. If location determined entity, entity would be derivable from location
and the ratified tuple would be redundant — so the set as ratified already
encodes *location does not determine ownership*. Codex's counter-argument, that
entity-owned locations prevent entity-A stock reaching entity-B's location, is a
real concern already answered elsewhere: the balance key contains the entity, so
a shared warehouse holds two distinct balances rather than one shared pool.
Entity-owned locations would instead force `WH-1-A`/`WH-1-B` duplicate masters —
ADR-0015's named failure.

**Party role — decided by the cost of being wrong in each direction.** A party's
capacity as supplier or customer is tenant-level at launch. The real future need
(per-entity vendor approval, per-entity credit state — the SAP company-code-data
shape) arrives as a **new `entityOwned` child family, never as a reclassification
of `party_role`**. Recording that extension pattern is what makes `tenantShared`
safe now: adding a child family later is cheap, reclassifying a family with
posted history is not.

**Item carries a second, independent reason:** base-unit immutability binds per
item, so duplicated per-entity items would let one SKU carry two base units,
poisoning any later intercompany movement.

Relations additionally declare `sameEntity` or `crossEntityAllowed`; movement →
location and movement → source document are `sameEntity`, movement → item and
party-role → party are `crossEntityAllowed`.

## V2 — The v1 stock-dimension set

**Already ratified; not an open question.** `(legalEntityId, itemId, locationId)`,
exactly three members. Lot, serial, bin, expiry and unit conversion remain N3 per
ADR-0016's own "what this ADR does not decide".

**One addition both arms support, from Fable, adopted:** all three members are
**required at posting with real values**, and their `unspecified` members are
**structurally unreachable** — no movement predates v1, so no "unspecified
location" sentinel may be manufactured. `unspecified` materializes only for
dimensions added at v2 and beyond. This closes a hole the ADR's first-class
`unspecified` would otherwise leave open at the boundary.

## V3 — Inventory posting configuration contract

Both arms converged on the shape and on the decisive default.

- **`negativeStock`** — `{reject, allowWithFlag, allow}`, default **`reject`**.
  The default direction is forced, not chosen: plan invariant 6 requires one
  explicit tenant policy with fail-closed defaults. Evaluated **inside the
  posting transaction** against serialized state, not as a preflight check — a
  preflight-only guard is the TOCTOU defect ADR-0012 names.
- **Reason requirements** per posting role; code-plus-narrative for adjustment,
  count, correction and re-baseline; code alone for transfer.
- **Approval thresholds** per posting role, in exact base units.
- **Same-instant tie-breaking** — closed and global, not a tenant dial.

**Unresolved and routed to G3-P0, not blocking:** the arms split on whether the
posture dials are scoped per tenant (Fable) or per legal entity (Codex). Both
rated it their lowest-confidence element. It is a scoping question with no
one-way-door character — a dial can be narrowed from tenant to entity later
without rewriting a posted fact.

## V4 — The anchor row, and what is actually a deadline

**Fable's split is adopted; it is sharper than the bundled question and sharper
than Codex's bundled answer.** Obligation 10's phrase "anchor row as a derived
cache with a proof obligation" conflates two things with different deadlines:

1. **The per-stock-identity serialization point inside the posting transaction —
   REQUIRED at first posting.** A named concurrency protocol (an aggregate lock
   every posting acquires, or serializable execution with a declared retry) is
   what makes the negative-stock guard phantom-proof. Without it, posted facts
   can violate the invariant, and posted facts are immutable. **This is a genuine
   one-way door and the charter nearly lost it inside a question about caching.**
2. **The anchor row as a materialized balance cache — ADDABLE LATER.** Plan line
   1313 already makes any cached balance a registered read-model projection.
   Both arms rated this high confidence.

**Net effect on the deadline: the cache comes off the list; the concurrency
protocol goes on it.** The irreversible set is smaller than the obligation text
suggests, but not in the place the text pointed.

---

## Disposition

G3-P0 cuts against this record. V1's table, V2's addition, V3's contract shape
and V4's split are settled inputs, not open design. Two items travel with the
cut as explicitly open: V3's dial scoping, and the concrete concurrency protocol
named in V4.1 — the *requirement* is ruled, the *mechanism* is G3-P0's to choose
and prove.
