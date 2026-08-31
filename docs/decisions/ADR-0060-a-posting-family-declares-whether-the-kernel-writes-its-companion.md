# ADR-0060: A posting family declares whether the kernel writes its companion

Date: 2026-08-23
Status: PROPOSED — blocked on the released-contract transition below
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

  **The kernel is the only writer WITHIN a successful companion-origin posting;
  it is not the only reachable writer in the application, and this ADR does not
  claim otherwise.** *An earlier version did, and the review refuted it.*
  Generic O0 operations still admit draft inventory-transaction create and
  update, reviewed stock counts remain mutable, and the stock-count form still
  renders the now-dead Transaction picker. Something else can therefore write a
  transaction under the derived identity, or write the source relation, before
  posting. What the reviewed-must-be-null fence buys is that the kernel refuses
  to ADOPT such a row — refusal, not sole-writer enforcement. ADR-0049 required
  user-reachable companion creation and update to be CLOSED; that remains owed
  and is filed as `companion-writers-not-closed`.

**A companion identity is DERIVED from the source, never copied from a
command.** The derivation is
`uuidv8(sha256(namespace | capabilityId | familyId | companionFamilyId | sourceRecordId))`.
Two properties follow from purity and both are load-bearing:

1. **Nothing a caller sends can steer it.** The companion-origin command shape
   carries no companion id at all, and one that does is refused.
2. **It is deterministic**, so a retry derives the same identity for one source
   rather than minting a second companion. *Narrowed on review: what is
   established is the derivation's determinism and the fact that the stock
   identity locks, the request-key lock and the natural-replay path serialize
   posting. The simultaneous-post case — two concurrent postings racing to
   INSERT one derived primary key, and resolving through the raced-replay
   branch — is REASONED, NOT MEASURED, and no control holds it.*
   This is what `#companionDerivation` never had: §7.16 measured that it
   *copied* `transactionId` from the command, so `ON CONFLICT DO NOTHING`
   "converges by doing nothing" and declaring stock count companion-origin
   "does not give it a kernel writer."

   **CORRECTED in review round 9, and the correction is not a narrowing but a
   substitution.** The sentence above is about ONE source retried, and for that
   case the derived companion transaction identity is indeed the colliding key.
   It says nothing about TWO DIFFERENT sources carrying the same natural effect
   tuple, and this ADR previously left the reader to assume the same mechanism
   covered both. It does not. The movement table's own `effectIdentityUnique`
   carries `record_id`, minted fresh per posting, so it cannot collide across
   postings at all; the only key that reserves a natural effect is the PRIMARY
   KEY of `movement.factStorage.companion`, which omits `business_period` and
   `record_id` and which the posting service does not bind. **The
   raced-replay branch's refusal depends on a table this ADR never named.**
   Filed as `movement-effect-reservation-not-observed`; the verification packet
   owns both the read-back and the measurement.

**The authored DRAFT PROTOCOL is not re-run over kernel-written rows, but its
projection checks are not discarded.** A row created inside the posting
transaction has no validation-to-posting window, so the header lock, the
draft-state assertion and the line-set compare-and-set have nothing to protect,
and running them would make a verifier share a code path with the writer —
`AGENTS.md` §6's fifth vacuity vector.

*The first review arm found that an earlier version of this ADR used that
argument to discard too much, and it was right.* The authored path was also
independently verifying every business field and the exact line set. Dropping
those left a read-back that checked identity, state and revision only — so a
writer producing the RIGHT identities and the WRONG transaction type, reason,
instant, quantity, unit or direction committed silently, which is precisely the
class this ADR invokes Band A for. **What replaces the draft protocol is a full
projection read-back**: every persisted companion header and line field is
compared against the projection of the source, the companion's own children are
counted so an extra line cannot hide behind a source-side join, and each
expected identity is recomputed from the source record id **read back from the
same row**.

**The companion is created at the contract's initial revision.** It is inserted
directly in `posted` state at revision `1`, because it is a CREATE: the
compiled storage contract declares an entity's optimistic revision with
`initialValue: '1'`, and the generic mutation interpreter gives every create
`projectedRevision: 1`.

*An earlier version of this ADR ruled the opposite — that the companion takes
`sourceRevision + 1` so the two rows match, making revision equality a
reconciliation predicate. The first review arm refuted it and was right.* That
overloads the optimistic-revision field with lineage it does not carry: at
source revision 9 it created a brand-new transaction at revision 10, which no
part of the compiled revision contract authorises. **The source-to-companion
join is the DERIVED IDENTITY**, recomputable from the source alone, and it
never needed revision equality. A packet that genuinely needs to know which
source revision produced a companion owes a lineage field or a reconciliation
fact, not a reinterpretation of an existing one.

**Companion relations are optional, pinned rather than permitted.** The
compiler's pinned stock-count relation table now requires
`stock_count -> inventory_transaction` and
`stock_count_line -> inventory_transaction_line` to be optional. Requiring them
is what made the source unconstructible; permitting either value would let the
defect return silently. `stock_count_line -> stock_count` stays required,
because a parent-scoped child genuinely cannot exist without its session.

## The transition this ADR does NOT rule, and cannot

**This decision changes an ALREADY-RELEASED contract, and the first review arm
was right that a fresh-install acceptance test cannot certify that.**

The base `InventoryStockCountPostingCommandV1` required a caller-authored
`transactionId` and per-line `transactionLineId`, and both companion relations
were required, so reviewed stock counts necessarily carried caller-selected
companions. Under this decision a reviewed count must carry NULL and a posted
count must carry the derived identity. Relaxing `NOT NULL` clears no existing
value and re-keys no existing row, so against already-released data:

1. an existing reviewed count with its formerly required companion is refused
   by the must-be-null fence;
2. an existing posted count whose caller-chosen ids differ from the derivation
   fails the projection read-back;
3. an old caller cannot resend the old shape, because `exactKeys` refuses it;
4. an existing version-3 receipt was digested from caller-selected ids and now
   recomputes from derived ones, so it replays as an idempotency conflict.

**Point 4 is a rule violation, not a judgement call.** Migration `0016` states
the rule in its own text: writers *"retain the v1 default until their own
digest input changes under a versioned migration."* The digest INPUT changed
here. An earlier version of this packet argued the exemption on the grounds
that the digest SHAPE was unchanged — a distinction the rule does not make.
That argument is withdrawn.

**The versioned digest was BUILT here and then withdrawn, and the reason is a
measurement rather than a preference.** Migration `0022` plus a version-4 write
were implemented and green in isolation. Run against the whole suite they broke
**eleven tests across seven files**: the checked-in schema snapshot, four
independently pinned tail-migration assertions, two exhaustive migration lists,
and a migration range encoded in a test's own title. There is no single
registry for a migration in this repository, so each site is discovered as a
separate red. For contrast, the storage-transition element this packet
deliberately did NOT build accounts for **two**. A change with that pin surface
is a platform change, and burying it in a posting packet ships it with no
controls of its own and a schema snapshot regenerated by an invented script.
It belongs to `PUR-2b` as that packet's subject.

**The limit that stands in the meantime, stated rather than papered over:** a
stock-count posting still writes digest version 3, so a receipt written before
companion derivation replays as an ordinary idempotency conflict rather than
one naming the contract change. That is loud, not silent, and it is wrong in
the diagnosis it gives rather than in the outcome it produces.

**What is owed before this ADR can be accepted**, and none of it is a lane's to
rule: a versioned public command and capability version; a digest version with
its `CHECK` migration; a disposition for legacy reviewed rows and their
pre-staged drafts; a disposition for legacy posted rows, movements and
receipts; and either an explicit proof that no live data exists or a transition
that carries it. Until then this ADR is **proposed**, not accepted, and the
mechanism it describes is proven only on a fresh install.

## What this ADR does NOT claim

**The family roster IS executable authority — provider authority, not
active-release authority.** *This corrects an earlier version of this ADR that
said the roster "is not executable authority" flatly. The first review arm
refuted it and supplied the right distinction, which is adopted verbatim
because it is better than the one it replaces.*

The provider-local roster decides whether execution is authored or
companion-origin, the pinned source type, the movement role option, the
companion transaction type, the business-key prefix, and which families exist
at all. `family.origin` branches production execution directly. That is
executable authority by any honest reading.

What the compiled artifact contributes is narrower: every entity, relation
column and enum option a family names is resolved out of the registration's
storage target, so a provider-declared family whose storage parts are absent
from the active release cannot post. **The active release does not declare the
family, and does not authorise its origin.**

*Stated at its real strength and no further, because the two halves happen at
different times.* Resolution runs at service CONSTRUCTION, so on its own it
only proves a family against the target it was handed. `assertActiveRelease`
runs per POSTING, and it proves that target is the exact active-release
artifact by comparing its canonical BYTES against the persisted projection
chunk — not merely a content hash. Together they mean a NEW WRITE cannot use a
provider-declared family whose referenced storage parts are absent from the
exact active target. Construction alone does not mean that, and neither half
means the release declared the family. *Receipt replay returns before the
active-release assertion; it writes no new effect, but the limit is stated
rather than left to be discovered.*

Moving the roster itself into the compiled contract release requires changing
`InventoryPostingRegistrationV1`, which has fourteen construction sites.

This distinction is deliberate. Profile-as-executable-authority is exactly the
ADR-0049 claim §7.16 marked REFUTED, and restating it here in a new vocabulary
would reintroduce it. ADR-0049 §1.1 stands unmet in its second half: the
catalog arrives as a compiled projection, and `PUR-2` still owes the proof that
the ROSTER is the exact active-release artifact, as the storage target already
is.

**Nothing here is claimed about the platform plane — added in review round
8.** This ADR's verification rule is that every MODULE row a posting writes is
compared column-for-column against an executed proof before the posting
commits, and that the set of columns proved must EQUAL the set the row carries.
Round 8 established that the writer inventory has to be taken from every
synchronous effect on the tables a posting touches, not from the SQL statements
the kernel issues: an `AFTER INSERT` trigger maintaining the posted-stock
projection is a writer, and the rule now covers it. It does NOT cover the trust
documents, the semantic-operation receipt, or the aggregate-generation advance.
Those belong to the platform contract, and whether they adopt this rule or
carry their own is open as
`posting-platform-plane-writes-not-row-complete`. **A reader must not restate
this ADR as "every write is read back".**

**Nothing here is claimed about goods receipt.** The mechanism is proven on one
companion-origin family. A second family is how a mechanism is tested, and
§7.16's whole point is that a mechanism whose nominated second family refutes
it is not a mechanism — so goods receipt is the test of this ADR, not evidence
for it.

## Consequences

**Easier, but NOT roster-only — corrected on review.** A reconciliation reader
can recompute any companion identity from source ids alone, without the posting
kernel, through an exported pure function. That much holds.

*An earlier version claimed a new companion-origin family is "a roster entry
plus its compiled entities". That was false and the review measured why.* The
roster supplies no generic source port: there is no family-driven source lock,
source validation, or source transition. A second companion-origin family still
needs a public entry point, a command type, a parsed-union arm, its own source
validation and transition, and changes to the guards that are still written
against stock count specifically. **What this ADR establishes is the KEY and
the origin axis, proven on one family — not roster-only extensibility.**
Building the generic source port is the next packet's work, and until it exists
the honest claim is that the hardcoding moved up into the entry point rather
than being eliminated.

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
