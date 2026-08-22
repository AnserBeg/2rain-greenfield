# ADR-0059: A document declares its whole lifecycle at adoption, and the purchase order's is ruled

Date: 2026-08-22

Status: **proposed** — packet `PUR-1`, branch `packet/pur-1-v2`. Ratification
belongs to the orchestrator at acceptance, not to a future reader; ADR-0049,
ADR-0050, ADR-0055 and ADR-0056 each outlived their own review with a stale
status line, and `ADR-0050`'s own header calls that "a pattern rather than an
accident."

Tier: Critical (it fixes the state set every later purchasing and sales packet
inherits, and the cost of changing it)

## Context

[ADR-0050](ADR-0050-the-record-transition-carrier.md) ruled that
`transitionStateEffect` is honoured and that `stateMachines` is decided with it,
because a `transitionDefinition` exists nowhere but inside a
`stateMachineDefinition`. It bound the placement — normalization materializes
each machine's state field as an ordinary enum field on its entity — and it
priced the cut:

> Zero release roots move, because no first-party module declares a state
> machine. Every one declares `stateMachines: []`. That is what makes the cut
> cheap today and **expensive the moment any module adopts one.**

`PUR-1` is that moment. It is the first first-party module to declare a machine,
and this ADR records what the cost turned out to be and what the purchase
order's lifecycle is.

## 1. The cost is a lineage entry per change, and it was measured rather than predicted

`PUR-1` first shipped a three-state machine — `draft`, `released`, `cancelled` —
and minted release lineage entry 14 for it. A bridge instruction then added
`closed` and two more transitions. Adding the state to the already-materialized
machine raised:

```
COMPILER_STORAGE_RETYPE_UNSUPPORTED
  phase           postLoweringValidation
  path            $.fields.fieldType
  subjectId       northstar.app:derived_state_field.machine.purchase_order_lifecycle
  rule            v1 storage transitions do not retype existing physical columns
```

**That is not a defect and no exemption is requested.** The materialized state
field is an ordinary enum column, and widening an enum is a retype like any
other. The premature entry was discarded, the lineage was rebuilt from the
accepted 13-entry head, and the packet minted exactly one.

### Ruled: a module adopting a state machine declares its WHOLE lifecycle in the release that adopts it

Including the states and transitions that release cannot drive. The alternative
— adding them as each becomes reachable — pays a normalization event and a
lineage entry per addition, and each one is a release the whole application must
reproduce forever.

**This is not "author speculatively".** A state is admitted when the document's
lifecycle genuinely reaches it and some later packet is chartered to drive it.
What is refused is the reverse: withholding a state that is already known,
purely because this packet has no trigger for it.

**The distinction from plan §7.12's `received_quantity` ruling, which points the
other way and is not being overturned.** A permanently-zero COLUMN buys nothing
and pre-commits a mechanism — stored-with-compare-and-swap versus derived-under-
lock — that a later packet must choose. A state is not that: `closed` commits
nothing about what closes an order, only that closing is where it lands. The
test is **whether the declaration pre-commits a mechanism or only names a
destination.**

## 2. The purchase order lifecycle

```
draft --release--> released --cancel--> cancelled
                       |  ^
                  close|  |reopen
                       v  |
                     closed
```

| From | To | Ruled |
|---|---|---|
| `draft` | `released` | the release |
| `released` | `closed` | the close. **What triggers it is `PUR-2`'s to decide** — the transition exists now so that decision costs no lineage entry |
| `closed` | `released` | the reopen. A closed order needing a further receipt or an amended quantity returns to `released` |
| `released` | `cancelled` | the cancel |
| `released` | `draft` | **refused.** `draft` asserts no commitments exist, and once released, receipts may |
| `draft` | `cancelled` | **refused.** A draft's exit is the generic ARCHIVE the four standard operations already provide |
| `closed` | `cancelled` | **refused.** Reopen first, so cancel departs from one state and needs one transition |
| `cancelled` | anything | **refused.** Terminal; reissue instead |

`cancelled` is `terminal: true`. `closed` is not.

**Cancel departs from `released`, not from `draft`, and the reason is
structural rather than editorial.** A released order is refused by every one of
the four generic operations, so cancel is its only exit; a draft order still has
archive. And `transitionStateEffect` carries exactly one `transition` reference,
so one operation drives one transition — a cancel reachable from two states
would need two transitions and two operations.

## 3. The editing guard is `not(released) and not(closed) and not(cancelled)`

Editable only while `draft`, spelled negatively.

**The negative form is forced by the create path, not chosen.**
`prepareMutation` evaluates a create's precondition against the CANDIDATE image,
which is the caller's patch — and the materialized state field is excluded from
every caller-writable contract, so it is absent there. Under
[ADR-0021](ADR-0021-total-absent-value-semantics.md) total-absence semantics
(`absentComparison: 'false'`) a positive `state equals draft` evaluates FALSE on
that image and refuses every create. `not(equals X)` holds on the same absence.
This is measured: the compiled guard evaluated against an empty image reports
`holds`.

**Three terms rather than one.** [ADR-0034](ADR-0034-terminal-state-operation-preconditions.md)
gives `stock_count` a single `not(posted)` because `posted` is its only
non-editable state. A purchase order has three, and `terminal: true` is metadata
that no generic rule reads — nothing in the platform refuses a mutation because
a state is terminal. A one-term guard would leave a cancelled order fully
editable, and through the parent-aggregate rule its lines too.

One predicate still covers all four generic operations, which is ADR-0034's
shape, and it is the predicate `parentGuardsFromCatalog` propagates to
`purchase_order_line` from the header's UPDATE operation.

## 4. What this forecloses, and what it does not

**Ordered quantity cannot be changed once an order leaves `draft`.** `PUR-1`
attempted an amend operation and could not express one. Three independent
measurements, each of which would have to be answered separately:

1. **`writableFieldIds` is entity-wide.** `operationInputContract` builds it
   from `fieldsByEntity.get(operation.effect.entity.targetId)` — the entity's
   whole active field set minus materialized state fields — and
   `operationDefinition` is a `z.strictObject` with no per-operation field
   carrier at all. The shipped `advance_period_lock` / `reopen_period` pair on
   `inventory_period_lock` demonstrates it: two update operations, one
   entity-wide writable set. A "quantity-only" operation is a full line update
   under a narrower name, which is ADR-0050 §7's defect class one construct
   over — a record asserting a restriction execution ignores.
2. **A line precondition cannot address the parent's state.** The state field is
   on `purchase_order`; a line's record image has no such key, so under ADR-0021
   the comparison is false and `any(equals released, equals closed)` refuses
   always.
3. **The parent-aggregate rule refuses it regardless.**
   `parentGuardsFromCatalog` collects EVERY active `updateRecordEffect` on the
   parent and `requireRelationTarget` requires all of them, so the header guard
   refuses a line mutation in exactly the states an amend is for. A second header
   update operation makes this stricter, not looser.

**None of the three is decided here.** Each is a platform question with its own
cost — a canonical carrier for a per-operation writable subset, a way for a
child operation to read the parent image, or an exemption from the
parent-aggregate rule — and `PUR-2` inherits them together with the
received-quantity floor that belongs with the same decision.

**What is decided here** is that the reopen exists, so the eventual answer has a
state to return to.

## Consequences

- The second document module (`sales_order`, `SAL-1`) declares its whole
  lifecycle at adoption and pays one lineage entry, not one per confirm/cancel/
  close it discovers.
- `PUR-2` may implement close and reopen without a language event, because their
  transitions are already in the release.
- A state added to any shipped machine costs a normalization event and a lineage
  entry, and fails loudly with `COMPILER_STORAGE_RETYPE_UNSUPPORTED` rather than
  silently. That refusal is the trigger to revisit this ADR, not a bug report.
- **What this forfeits:** a lifecycle declared before its drivers exist is a
  lifecycle whose states can be reached only by the packets that add them, so a
  reader of the compiled release sees four states where only three are
  presently producible. That is visible in the machine and stated here, rather
  than being discovered from an empty column.

## Boundaries

This decision authorizes no posting, no receipt, no inventory movement, no
capability, and no change to `packages/runtime/` or `packages/postgres-provider/`.
It does not revisit ADR-0050's placement ruling, and it does not overturn plan
§7.12 — it distinguishes from it.
