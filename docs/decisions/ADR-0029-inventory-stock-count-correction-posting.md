# ADR-0029: Inventory stock-count correction posting

Date: 2026-07-30
Status: **ratified** 2026-08-21 — G3-P4b is accepted (ledger; reviewed
`f6b7463b8f8a2ed4b6c5fa4d23f4605cf5b86faa`, integrated `fa94633`), completing the
condition this ADR set for itself. (Status corrected by the orchestrator's 2026-08-21
record sweep, disposing program review R1, which found the condition met and the text
stale.)
Tier: Critical (review per `review-tiers`)
Supersedes: ADR-0026 only where it withholds stock-count correction

## Context

ADR-0026 admits one Inventory posting capability and one provider-owned posting
transaction, but expressly withholds stock-count correction. ADR-0027 extends
that same capability to transfer and reiterates that the existing `count` and
`correction` enum spellings are not authorization.

Freeze M requires a count session, line evidence, three independently recorded
physical quantities (expected, counted, and variance), a linked variance
movement, compensating correction and reversal, and consumption of the shared
posting protocol. ADR-0017 also requires persisted decisions to capture their
inputs. A stored variance alone cannot later disclose either the expected
quantity or what was physically counted.

The accepted dependency-set v3 does not authorize reads of the new count
session and line evidence or its state transition. Adding those authoritative
accesses is a governed dependency protocol event under G3-P0 obligation 7; an
undeclared read would instead be a compile failure.

## Decision

Admit `stock_count` and `stock_count_line` as entity-owned Inventory evidence
families and admit one closed `postStockCount` command family inside
`northstar.inventory:capability.posting` version 1. This authorization does not
admit a second posting implementation. `postStockCount` validates its variant
and enters the same private `#post` used by adjustment and transfer.

Every reviewed count line persists all of:

- `expectedQuantity`, the serialized physical quantity believed before the
  count;
- `countedQuantity`, the observed physical quantity;
- `varianceQuantity`, required to equal counted minus expected; and
- the Item, unit, count session, transaction line, and optional reversed
  movement links needed to interpret those values.

The posting movement is the exact variance at the count session's Location.
The initial session uses posting role `count`; corrections and reversals use
`correction`. The accepted natural effect remains
`(source_type, source_id, source_line, revision, posting_role)`, scoped by legal
entity. A correction appends a new session linked by `supersedes`; it never
changes or deletes the earlier session. A reversal also appends a session and
movement, and its movement must be the exact quantity inverse of the linked
movement from the immediately superseded session.

The reviewed session and all active lines are row-locked only with
`FOR NO KEY UPDATE`. Their complete persisted shapes must match the command.
The reviewed-to-posted session transition, transaction draft-to-posted
transition, variance movement, and trust facts share the existing single
post-lock savepoint and top-level transaction. A digest of the complete session
and line set is rechecked by the session transition, so a line inserted after
validation cannot escape observation.

Stock locks remain immediately after `BEGIN`, following the transaction-local
15,000 ms `set_config(..., true)` and preceding the request-key lock, business
reads, and savepoint. Negative stock remains evaluated inside that serialized
transaction. No change to `#post`'s structure or to `stock-serializer.ts` is
authorized or made.

## Dependency-set v4 event

The exact dependency list changes from 32 entries in v3 to 35 entries in v4.
The three additions are:

- `read:northstar.inventory:stock_count`;
- `read:northstar.inventory:stock_count_line`; and
- `transition:northstar.inventory:stock_count.state`.

The recorded roots are:

- before, dependency-set v3:
  `35fc38eaca7fbe47d8da5030ceefce8211a2194a25d233c45282ef0450d553ad`;
- after, dependency-set v4:
  `ffd4e9f6103b5c6053c39b62fe64e69dd255cb0c86cfd349ae465ab25179b3d3`;
- before, compiled Inventory release:
  `3a50e80ba684cef8049a70be7fff13b3da063df4a93f2a759c7ca6d63b40bf85`;
  and
- after, compiled Inventory release:
  `06d0477cfcb68096dbe41782183be3687cad7031665db0f9dd755d9c5ce3fac0`.

Compiler conformance recomputes the root from both `dependencies` and
`accessPlan`, requires their equality to the pinned v4 root, and continues to
reject every access not declared in the exhaustive set. This is not a
canonical-language version event: the existing language can express the new
entities, fields, relations, and contract data without changing its grammar or
normalization rules.

## Persisted receipt boundary

Migration 0017 expands the existing receipt digest-version check to admit
version 3. It does not rewrite an existing receipt.

- v1 remains the G3-P3 adjustment digest/result reader;
- v2 remains the G3-P4a adjustment/transfer digest/result reader; and
- v3 is the stock-count digest/result reader and requires persisted count
  evidence.

Both digest computation and result decoding choose their shape from the
artifact's stored `input_digest_version`, never from today's writer constant.
New count receipts store the posted session and line read-back, including all
three quantities and movement links. Existing v1/v2 results are returned with
`stockCountEvidence: null` and are not mutated in storage.

## Boundaries

This decision does not authorize an on-hand/read model, valuation, cost,
currency, price, monetary amount, reservation behavior, UI, transport route,
agent tool, canonical-language event, mutable balance, hard delete, or second
posting implementation. Count evidence is physical-quantity-only; valuation
remains owned by G4.

## Consequences

The ledger can answer all three audit questions independently: what quantity
was expected, what quantity was found, and what difference was posted. A bad
count can be corrected or reversed without erasing the original evidence. The
new command inherits the accepted release pin, legal-entity configuration,
period lock, base-unit validation, trusted actor attribution, natural replay,
stock serialization, negative-stock decision, and trust/outbox atomicity.

The dependency and release roots change intentionally and are golden-pinned.
Downstream registrations must consume v4. Existing receipt artifacts remain
readable because their stored versions remain authoritative.
