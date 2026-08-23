# ADR-0060: A posting family declares whether the kernel writes its companion

Date: 2026-08-23
Status: accepted
Tier: Critical (review per `review-tiers`)

Written after the vertical was built and measured, not before it. That
sequencing is `purchasing-sales-v1-plan.md` §7.16's ruling, which capped
ADR-0049's design phase because three design passes each ruled this mechanism
settled from goods receipt alone and each was refuted by stock count: *"an ADR
written from predictions is what `PUR-2` would then build against."* Every
claim below was produced by construction in `PUR-2a`.

## Context

Inventory posting turns a source document into movements. Some sources bring
their own inventory transaction; stock count does not, and the difference had
never been named. Instead the posting service dispatched on hardcoded strings —
a `command.sourceType !== 'stockCount'` literal and three
`switch (postingRole)` statements — and both stock-count companion relations
were **required** create-time inputs, which made a reviewed stock count
unconstructible without a pre-staged transaction. The kernel read those columns
and never wrote them.

`PS-0`, `PS-1` and `PS-2` all proposed a mechanism keyed on a profile; §7.16
refuted profile-as-executable-authority, baseline-plus-extension, and
lock-and-sum, and routed the mechanism here as construction.

## Decision

**Posting execution is selected by a compiled family-execution binding keyed by
`(capabilityId, familyId)`, and a family declares its ORIGIN.**

A **family** is the source entity family a posting executes for, in the
vocabulary the inventory contract already uses for families. `origin` is
ADR-0049 §4's authored/companion axis, made executable:

- **`authored`** — the caller authored the inventory transaction and hands it
  to the kernel. The kernel validates the draft it was given: it locks the
  header, captures the line-set digest, asserts the draft matches the command
  exactly, and posts under a compare-and-set on that digest. Those verifiers
  exist to protect an authored draft against edits between validation and
  posting.

- **`companion`** — the caller authored the SOURCE. The inventory transaction
  is a **companion**: the kernel derives its identity, writes it, and writes
  the derived identity back onto the source, all inside the posting
  transaction. The source may — and before posting must — exist without one.

**A companion identity is DERIVED from the source, never copied from a
command.** The derivation is
`uuidv8(sha256(namespace | capabilityId | familyId | companionFamilyId | sourceRecordId))`.
Two properties follow from purity and both are load-bearing:

1. **Nothing a caller sends can steer it.** The companion-origin command shape
   carries no companion id at all, and one that does is refused.
2. **It is deterministic**, so a retry derives the same identity and collides
   on the primary key rather than minting a second companion for one source.
   This is what `#companionDerivation` never had: §7.16 measured that it
   *copied* `transactionId` from the command, so `ON CONFLICT DO NOTHING`
   "converges by doing nothing" and declaring stock count companion-origin
   "does not give it a kernel writer."

**The authored verifiers are NOT re-run over kernel-written rows.** A row
created inside the posting transaction has no validation-to-posting window, so
there is nothing for them to protect, and running them would make a verifier
share a code path with the writer — `AGENTS.md` §6's fifth vacuity vector.
What replaces them is a **read-back**: both companion identities and both
revisions are read out of storage, and the expected identity is recomputed from
the source record id **read back from the same row**. That is observation of
the persisted effect rather than trust in a reported row count.

**Both revisions are derived and both are written.** The companion transaction
is inserted directly in `posted` state at `sourceRevision + 1`, the same
revision the source reaches. A reader joining a posted count to its companion
sees one consistent pair, and `source.revision == companion.revision` is a
reconciliation predicate rather than a coincidence.

**Companion relations are optional, pinned rather than permitted.** The
compiler's pinned stock-count relation table now requires
`stock_count -> inventory_transaction` and
`stock_count_line -> inventory_transaction_line` to be optional. Requiring them
is what made the source unconstructible; permitting either value would let the
defect return silently. `stock_count_line -> stock_count` stays required,
because a parent-scoped child genuinely cannot exist without its session.

## What this ADR does NOT claim

**The family roster is not executable authority.** What is frozen in the
provider is WHICH families exist. What is compiled and release-verified is
everything each family is MADE OF: every entity, relation column and enum
option is resolved out of the registration's storage target.

*Stated at its real strength and no further, because the two halves happen at
different times.* Resolution runs at service CONSTRUCTION, so on its own it
only proves a family against the target it was handed. `assertActiveRelease`
runs per POSTING, and it proves that target is the exact active-release
artifact by comparing its canonical BYTES against the persisted projection
chunk — not merely a content hash. Together they mean a family the ACTIVE
RELEASE cannot satisfy can never post. Construction alone does not mean that.

Moving the roster itself into the compiled contract release requires changing
`InventoryPostingRegistrationV1`, which has fourteen construction sites.

This distinction is deliberate. Profile-as-executable-authority is exactly the
ADR-0049 claim §7.16 marked REFUTED, and restating it here in a new vocabulary
would reintroduce it. ADR-0049 §1.1 stands unmet in its second half: the
catalog arrives as a compiled projection, and `PUR-2` still owes the proof that
the ROSTER is the exact active-release artifact, as the storage target already
is.

**Nothing here is claimed about goods receipt.** The mechanism is proven on one
companion-origin family. A second family is how a mechanism is tested, and
§7.16's whole point is that a mechanism whose nominated second family refutes
it is not a mechanism — so goods receipt is the test of this ADR, not evidence
for it.

## Consequences

**Easier.** A new companion-origin family is a roster entry plus its compiled
entities, not three new switch arms and a second companion-writing path. A
reconciliation reader can recompute any companion identity from source ids
alone, without the posting kernel, through an exported pure function.

**Harder, and this is the real cost.** Relaxing requiredness on an
**already-released** relation is a storage transition the v1 language cannot
plan: `sameRelationShape` includes the relation column's nullability in the
compared physical shape, so `COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED`
refuses it. A fresh install is unaffected — the rule only fires where the
previous release already carries the relation — but the composed web
application's 14-release lineage cannot advance across this change until a
requiredness-relaxation transition element exists. NOT NULL → NULL is a
widening DDL that is always safe, so this is a missing planner element rather
than an unsafe change, and it is filed as its own charter rather than taken
mid-packet.

**A shipped surface is now misleading.** The `stock_count_form` surface still
offers a Transaction picker. An operator who uses it creates a count that can
never post, because the kernel refuses a reviewed source that already names a
companion. Filed as `stock-count-form-offers-a-dead-transaction-picker`.

## Evidence

`PUR-2a`, `docs/execution/packets/pur-2a.md`. The acceptance control is
§7.16's, not this packet's choice of an easy one: create and review a
stock-count source with **no pre-staged transaction or transaction lines**,
assert zero `inventory_transaction` and zero `inventory_transaction_line` rows
exist, post, and prove the kernel derives and writes both companion IDs and
both revisions. Band A, full `AGENTS.md` §6, with the mutation manifest in
`test/evidence/pur-2a.expected-red.json` under ADR-0058.
