# ADR-0068 — Exact unit conversion at the document boundary

Status: accepted by owner ruling for packet UNITS, 2026-10-04.

## Context

The plan §5.2 and §12.6 reserve unit conversion at the document boundary;
ADR-0016 pins the item base unit and forbids restating posted movements.
PaneFlow accepts alternate units through product-specific or company conversions,
but Rain's owner selected exact factors and explicit refusal instead of rounding.

## Decision

UNITS consumes the reserved document-boundary seam. A unit master is keyed by
today's text unit code and declares its name and decimal precision. Existing
item base unit fields are not retyped, and their ledger-backed immutability is unchanged.
A company conversion optionally targets an item and expresses from/to units as a
positive integer numerator/denominator. Direct item, direct company, reverse item,
then reverse company is the lookup precedence. Ambiguous applicable rules refuse.

Documents keep base quantity in their existing fields and add an optional entered
quantity/unit pair. Ordinary line mutations convert before writing base quantity;
all reservation, shipment, receipt, invoice, bill and posting paths continue to
consume base quantity. The result must be exactly representable in the base unit's
decimal precision and the existing quantity field. A non-exact result is refused
by name; it is never rounded silently. A saved line keeps its entered and base
quantities, and subsequent conversion edits do not restate it or the ledger.

The compiler carries canonical normalization metadata to the shared runtime;
there are no hard-coded unit-entry screens. Normalization uses authorized master
reads in the document mutation's transaction, and existing idempotency covers the
caller's original input. Replay does not depend on current conversion configuration.

## Consequences

This amends the plan's reserved-seam scheduling and its explicit rounding-policy
choice to exact-or-refuse. It does not amend ADR-0016's base-unit immutability,
stock serialization, trust, release verification, database policies or migrations.
Historical records without an entered pair continue to use their existing base
quantities. Missing unit definitions or conversions never cause a guessed factor.

Implementation checkpoint: unit/conversion setup and standalone exact arithmetic
can ship in UNITS. The entered-document slice depends on the separately scoped
Critical UNITS-VERIFICATION packet; this decision does not authorize edits to
release verification under the UNITS charter.
