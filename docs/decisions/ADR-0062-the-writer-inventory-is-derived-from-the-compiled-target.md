# ADR-0062: The writer inventory is derived from the compiled storage target

Date: 2026-08-26
Status: accepted (packet `posting-writer-inventory`, merge `379acfe`, 2026-08-31 on narrowed claims by user ruling; status line swept 2026-09-01 on `5g3-prog` R6)
Tier: Critical (review per `review-tiers`)

Written after construction and measurement, in the sequencing
`purchasing-sales-v1-plan.md` §7.16 ruled for ADR-0060. Every claim below was
produced by building the derivation and measuring the compiled target, not by
predicting either.

## Context

`PUR-2a` took nine review rounds. Rounds 2, 3, 5, 6 and 7 each found one more
column a posting wrote and no read-back observed; round 8 found the coverage
mechanism was itself an allowlist and rebuilt it as a set equality; round 9
found an EIGHTH synchronous module writer — `reserve_inventory_movement_effect`,
which copies each movement into `movement.factStorage.companion` — that nine
rounds of evidence had never named.

The root cause is none of those eight fixes. **The writer inventory was
hand-enumerated while the compiled storage target already declared every
writer.** Each round added one more entry to a list a human maintained, and the
next round found the next entry the human had not thought of. That is a
generator of review rounds, not a defect that converges.

`mission-cadence`'s stop-convergence rule is binding at two stops. This was the
ninth round, so the seam moved here with the constraint written in from the
start.

## Decision

**A posting derives, from the active compiled storage target, every physical
relation it writes; and every relation so derived must carry a registered
read-back or the service refuses at CONSTRUCTION.**

The derivation expands each entity the kernel writes into the relations that
write reaches:

- the entity's own physical table;
- every partition the entity's `factStorage.partitioning` declares, because a
  partitioned insert names the parent and lands in a partition;
- the `factStorage.companion` the entity's own declared `reservationTriggerName`
  writes;
- any projection whose insert trigger the target declares as installed on a
  table this posting writes.

The registry check is a set EQUALITY in both directions, for the same reason
`assertPersistedRowVerified` is one. An unregistered relation is an unobserved
write. A registration naming a relation the derivation does not reach is a
stale verifier — a read-back pointed at a table the target no longer touches —
and is refused rather than read as coverage.

Refusal happens at construction rather than at posting time because the fact
under test is a property of the release, not of the command. A release whose
compiled target reaches a relation this kernel cannot observe must not accept
a posting at all.

## This reads as a reversal of round 7, and it is not

Round 7 ruled that **coverage must not be derived from the compiled binding**.
That ruling is CORRECT and it still stands, for the thing it was about: the
column VALUES inside a row. Deriving both the persisted row and its expectation
from one source hides a shared omission — if the binding forgets a column, both
the write and the check forget it together, and the comparison passes by
agreeing with itself.

It does not reach WHICH TABLES a posting writes, and the two are different
kinds of fact:

| | round 7's subject | this ADR's subject |
|---|---|---|
| the fact | a column's persisted VALUE | which physical RELATIONS a write reaches |
| where truth lives | the command, the family binding, or a value the kernel computed | the compiled target's own declarations |
| what a shared source hides | an omitted column compared against itself | nothing — the target declares the relation whether or not the kernel knows it |
| measured failure mode | a wrong value agreeing with itself | **nine rounds of a hand-written list, each finding one more entry** |

A table list has no independent second source to compare against: the compiled
target IS where the relation is declared, and a human retyping it is not an
independent derivation — it is a lossy copy, which is what nine rounds
measured. The value comparisons in `readBackMovements`,
`assertMovementEffectReservations`, `assertCompanionIdentitiesPersisted` and
`assertPostedStockBalancesReconcile` remain independent of the binding exactly
as round 7 required, and nothing here relaxes that.

**The derivation is also fail-closed in the direction that matters.** A
relation it lists and no verifier covers refuses construction, so over-listing
costs a registration entry and under-listing is the failure this exists to
prevent. Round 7's concern was a check that passes when it should fail; this
mechanism fails when it is uncertain.

## AMENDED AFTER ROUND 1 — derivation is the plan, OBSERVATION is the backstop

The decision above is amended rather than replaced. Round 1 showed a derivation
over declarations can never be complete while one of the edges is a convention
rather than a declaration. **The amendment is to stop relying on the target
alone for completeness.**

**Before any trust document or receipt, the posting reads the module-plane write
set from `pg_stat_xact_user_tables` and requires every relation in it to appear
in the derived inventory.** It does not ask the compiled target what was
written; it asks PostgreSQL.

**NARROWED AFTER ROUND 2, and the earlier sentence here was too strong.** It
said a writer grown by a new convention, declared nowhere, refuses. What is
actually observed is **tuple DML that has already executed at the moment of the
snapshot**. A `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` fires at
COMMIT, after that snapshot, and there is no second observation — so its writes
are invisible, and the movement's own writes keep the observation non-empty so
the empty guard does not catch it either.

**This is an unclosed vector, not a live defect, and the difference is
measured:** there is no `CREATE CONSTRAINT TRIGGER` anywhere in the repository,
and the `DEFERRABLE INITIALLY DEFERRED` declarations in migration 0006 are
platform-plane foreign-key and unique CONSTRAINTS, which check rather than
write. Filed as `posting-write-observation-misses-deferred-triggers`.

**So the honest statement of what observation buys is:** it is a backstop
against writers the derivation cannot see, covering already-executed tuple DML
on module user tables. It is **not** a transaction-complete write set, and this
ADR must not be restated as one.

**Two things were measured before choosing this, and both changed the design:**

1. **Those counters do NOT reset at transaction boundaries.** A session that
   inserts 1000 rows and then opens a new transaction still reports them before
   the new transaction writes anything, and this service borrows pooled
   connections. The write set is therefore a DELTA against a baseline taken
   inside the transaction. Using the raw counters would have attributed a
   previous posting's writes to this one.
2. **Cost, on 20 relations one of which carried 200k rows: 4.5ms per snapshot,
   flat in table size**, because the counters live in memory. Scanning every
   relation for rows whose `xmin` is this transaction agreed exactly on the
   answer and cost **11x more at that trivial scale**, growing with the data.
   That is the whole reason one is affordable per posting and the other is not.

**An observer that sees nothing passes everything**, so an empty write set is a
refusal: every posting inserts at least one movement, and a wrong schema filter
or an unreadable view would otherwise look like unbroken green. Held by a
control that writes to a module relation nothing declares, through a trigger the
target knows nothing about, and requires the posting to refuse and name it.

**What this does and does not change.** The derivation still carries the
inventory and still refuses at construction when a derived relation has no
registered read-back — that is the cheap, early check. Observation is what makes
its incompleteness non-fatal. **The edge-declaration gap is still real and still
filed**; what changed is that it is no longer the only thing standing between an
undeclared writer and a commit.

**Still module-plane only.** The view is filtered to the module schema, so
platform-plane writes remain filed as
`posting-platform-plane-writes-not-row-complete`.

## CORRECTED AFTER ROUND 1 — the edge is not declared, only the destination is

Round 1 returned BLOCK on this ADR's central claim, and the finding is upheld.
**This section overrides any sentence above that reads more strongly.**

The claim was that the compiled target supplies every relation reachable from
the kernel's write roots. It does not. **Three of the four expansions are
genuinely target-declared, and one is not:**

| expansion | what declares it | declared? |
|---|---|---|
| the entity's own table | `physicalTableName` | **yes** |
| its partitions | `factStorage.partitioning.partitions[]` | **yes** |
| its effect companion | `factStorage.companion.reservationTriggerName`, which names both the trigger and the companion it writes, on the fact storage of the source entity | **yes** |
| the posted-stock balance | **nothing** | **NO** |

For the balance, the compiled target declares only that a `posted_stock_balance`
ENTITY exists. **Nothing in it says a trigger runs from the movement to that
entity.** The materializer reconstructs the edge by matching entity-id suffixes
and computing a trigger name from the balance's table name; this service
reconstructs the same convention independently, in a hand-written list of two
edges. *"Both are pure functions of the target"* does not make the edge
target-declared — it makes it a convention implemented twice.

**The consequence, stated as the failure rather than as a caveat:** a sixth
materializer-installed writer can be added, on a new provider convention, without
changing any target shape this service reads and without appearing in that list.
That is the same omission generator this ADR was written to eliminate, one level
up.

**What round 1 DID close, and what it did not.** The traversal was also not
transitive — it tested each edge against the original roots in one pass, so a
relation reached only through another trigger was invisible. That is fixed and
held by a chained-writer control. The **edge-declaration** half is not fixed and
**cannot be fixed inside this packet's lease**: it requires one authoritative
source-relation → trigger → destination-relation artifact in
`packages/compiler/src/storage.ts` and
`packages/postgres-provider/src/module-storage-materializer.ts`, both held by
another lane. Filed as `module-writer-edges-are-convention-not-declaration`.

**Until that lands, this ADR's status is: the derivation is complete over the
expansions the target declares, and incomplete over trigger edges it does not.**

## A registration proves a verifier EXISTS, not that it RUNS

Also corrected after round 1. The registry originally paired each relation with
an arbitrary string, and one shipped registration named a function that does not
exist anywhere in the file — proof that the strings were decorative. Registrations
now pass the verifier **function**, so naming an absent one is a compile error.

**That closes "names something that isn't there". It does not close "the named
verifier never runs for that relation on this posting's path."** The check is
still a declaration compared against a derivation, and `AGENTS.md` §6 is explicit
that inferring from a declaration is a proxy rather than an observation. Filed as
`posting-writer-coverage-is-declared-not-observed`.

## What is derived, and what is NOT — the boundary of the claim

**DERIVED:** given an entity the kernel writes, every physical relation that
write reaches. This is the enumeration round 9 found incomplete.

**NOT DERIVED:** *which* entities the kernel writes at all. This was measured
rather than assumed: the target's `consumerWriterRoots.writerOperationIds` is
**empty** for both `inventory_movement` and `posted_stock_balance`, because it
records AUTHORED operations and the posting kernel is a capability. The
compiled target does not know the kernel writes the movement. The write roots
are therefore the kernel's own declaration, and they are the part of this
mechanism a reviewer should attack hardest.

The exclusion of non-written entities is nonetheless DERIVED rather than
assumed, and deliberately so. The period-lock provisioning trigger is declared
exactly like the posted-stock projection trigger, and both are passed to the
derivation; the period lock is excluded because its trigger is installed on the
legal-entity master, which a posting never inserts. An exclusion that is
measured is worth more than one that is reasoned, and this is the class of
reasoning that failed nine times.

## SCOPED TO THE MODULE PLANE

`reserve_inventory_movement_effect` also calls
`north_star_internal.advance_semantic_aggregate_generation`. That is a
platform-plane row the compiled target does not declare as a relation, so this
derivation **cannot see it** and does not claim it. Together with the trust
documents and the semantic-operation receipt, it remains filed as
`posting-platform-plane-writes-not-row-complete`. **This ADR must not be
restated as "every write a posting performs is derived and observed."**

## Why the effect reservation is load-bearing, stated because it is easy to get wrong

The movement table's own `effectIdentityUnique` contains `record_id`, minted
fresh on every posting, so **it can never collide between two postings**. It is
not a duplicate-effect guard; it carries `record_id` because a partitioned
table's unique constraint must carry its partition key.

The companion's PRIMARY KEY omits `business_period` and `record_id`. **It is
the only thing in the system that reserves a natural effect**, and the `23505`
raced-replay branch — whose refusal reads *"a natural effect identity was
claimed by a different posting"* — depends entirely on it. The foreign key runs
companion → movement `ON DELETE RESTRICT`, so a movement with no reservation
row violates nothing: a reservation that silently failed to appear would leave
that refusal unreachable and a second posting free to commit the same effect.

### What the read-back adds over the database, stated narrowly after measurement

Measured, not assumed: the companion → movement foreign key covers **all ten**
companion columns, and its target columns are **exactly** `effectIdentityUnique`.
That answers a question the charter's own account left half-answered —
`effectIdentityUnique` carries `record_id` because it is **this foreign key's
target**, not only because a partitioned table's unique constraint must carry
its partition key.

The consequence is a narrower claim than "the read-back catches a wrong
reservation":

- **A reservation carrying a wrong effect tuple has no referent and PostgreSQL
  refuses it with 23503.** The database already holds every column. The
  column-for-column comparison therefore proves the read-back is INDEPENDENT of
  that compiled declaration remaining exactly this wide — its control has to
  suspend the constraint to construct its own subject, and says so.
- **What no constraint holds is the reservation's EXISTENCE and its one-to-one
  pairing with this posting's movements.** The foreign key runs companion →
  movement, so a movement with no reservation violates nothing at all. That is
  the live gap, and it is the half whose control constructs its subject without
  touching the schema.

Both halves are kept. The first is cheap and is the one that survives a
narrowing of the compiled foreign key; the second is the one that is reachable
today. **The claim must not be stated as the first when the evidence is the
second.**

The standing "reasoned, not measured" disclosure about the simultaneous-post
case was therefore **worse than disclosed**: the reasoning named the wrong
constraint. `PUR-2a` round 9 found this; this packet measures the case with two
genuinely concurrent postings that share neither the stock-identity lock nor the
request lock.

## Consequences

- A writer the compiled target grows is refused at construction without anyone
  remembering to add it to a list. That is the property nine rounds lacked.
- A release carrying a relation this kernel does not observe cannot post. This
  is a deliberate availability cost paid for a correctness guarantee.
- The write roots stay hand-declared, and stay the weakest link. If the kernel
  learns to write a sixth entity and nobody adds it, the derivation expands
  nothing for it. **No gate closes this**; it is stated as a limit rather than
  papered over.
- The platform plane is still not row-complete, and the claim above is scoped
  so that it is not mistaken for closed.
