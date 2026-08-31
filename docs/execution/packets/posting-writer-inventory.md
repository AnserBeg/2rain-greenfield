# posting-writer-inventory — derive the writer inventory from the compiled target

Cut from `8bc097cdd6402388d80911db004590e335a6d5c6` (`packet/pur-2a`, frozen) on
branch `packet/posting-writer-inventory`. Tier: **Critical** — the change makes
the posting kernel refuse a release whose compiled target reaches a relation it
cannot observe, and a wrong or absent effect reservation is silent until
something reconciles it. Evidence band: **A, declared.**

**It stacks on a frozen predecessor deliberately.** The verification machinery
this packet extends — `assertPersistedRowVerified`, `verified`, `preserved` —
lives in `PUR-2a` and nowhere else.

## Inherited reds, unchanged

`check:app-release` and two `composed-application.test.ts` tests inside
`test:postgres`, all three the `COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED`
refusal that `packet/relation-requiredness-relaxation` is fixing in another lane.
**Not touched, not worked around.**

Measured rather than recalled: `pnpm check:app-release` at the branch point fails
with `compiled application release is stale; run pnpm --filter @north-star/web
build:app-release`. The `--check` path stops at staleness *without attempting the
compile*, so the refusal itself is not printed there; the refusal is what makes a
rebuild impossible, and is visible in the two `composed-application` tests.
**Stated precisely because "the red is the refusal" is a claim about a path this
packet did not execute** — rebuilding would write `apps/web/release/**`, which is
outside this lease.

## What the packet found, and it is the reason the packet exists

`PUR-2a` took nine rounds. Rounds 2, 3, 5, 6 and 7 each found one more column a
posting wrote and no read-back observed; round 8 rebuilt coverage as a set
equality; round 9 found an eighth synchronous module writer.

**The root cause is none of the eight fixes.** The writer inventory was
hand-enumerated while the compiled storage target already declared every writer.
A list a human maintains produces one review round per entry the human did not
think of. That is a generator of rounds, not a defect that converges.

## The central premise was tested first, and it HOLDS — with one measured boundary

The charter's real stop condition was *"the compiled target does not in fact
declare every writer — some physical write is installed by the materializer
without a target declaration."* Swept before building:

`module-storage-materializer.ts` installs exactly five triggers on module
tables, and **every one is a pure function of `StorageTargetPayloadV1`**:

| trigger | installed on | writes |
|---|---|---|
| `factStorage.companion.reservationTriggerName` | movement table | the companion, **plus a platform-plane row — see below** |
| `factStorage.rejectMutationTriggerName` | movement table | nothing (refuses) |
| `factStorage.companion.rejectMutationTriggerName` | companion | nothing (refuses) |
| `periodLock.provisioningTriggerName` | legal-entity master | the period-lock table |
| the posted-stock balance projection trigger | movement table | the balance table |

The last one is the one worth naming: its *trigger name* is not a field on the
target, it is derived by the materializer from `balance.physicalTableName`
(`nsm_t_…` → `nsm_z_…`). **The relation it writes is target-declared even though
its trigger name is computed**, and the writer inventory is about relations, so
the premise holds.

**THE ONE PLACE IT DOES NOT HOLD, and it is out of scope by charter.**
`reserve_inventory_movement_effect` also calls
`north_star_internal.advance_semantic_aggregate_generation`, writing
`north_star_internal.semantic_aggregate_anchors`. That is a platform-plane row
the compiled target does not declare as a relation, so **the derivation cannot
see it and does not claim it.** Already filed as
`posting-platform-plane-writes-not-row-complete`, which the charter routes out.
**This is reported rather than patched around**, per the stop condition.

## Deliverable 1 — the derived inventory

`derivePostingWriterInventory` expands each entity the kernel writes into the
relations that write reaches: the entity's own table, every declared partition,
the declared `factStorage.companion`, and any projection whose insert trigger the
target declares on a table this posting writes.
`assertPostingWriterInventoryRegistered` then requires a registered read-back for
each, as a set equality in both directions, **at construction**.

**The exclusion is derived, not assumed.** The period-lock provisioning trigger
is passed to the derivation alongside the posted-stock projection, and is
excluded because its trigger is installed on the legal-entity master, which a
posting never inserts. An exclusion that is measured is worth more than one that
is reasoned, and reasoning is the thing that failed nine times.

**What is NOT derived, measured rather than assumed.** The target's
`consumerWriterRoots.writerOperationIds` is **empty** for both
`inventory_movement` and `posted_stock_balance` — it records authored operations
and the posting kernel is a capability. So the compiled target does not know the
kernel writes the movement, and the write ROOTS stay a kernel declaration.
**That is the weakest link in this mechanism and no gate closes it.**

Round 7's ruling that coverage must not be derived from the compiled binding
holds for column VALUES and does not reach which TABLES a write reaches.
[ADR-0062](../../decisions/ADR-0062-the-writer-inventory-is-derived-from-the-compiled-target.md)
states why this reads as a reversal and is not; the value comparisons stay
independent.

## Deliverable 2 — the reservation read-back

`assertMovementEffectReservations` binds `movement.factStorage.companion` from
the active compiled target — every column name read from `companion.columns` or
`factStorage.fieldColumns`, none reconstructed locally — and runs immediately
after `readBackMovements`, under the module role, before any trust document or
receipt. It requires exact one-to-one equality and compares tenancy, legal
entity, business period, movement id and the five-column effect tuple through
`assertPersistedRowVerified`.

**Why that table is load-bearing.** The movement's own `effectIdentityUnique`
carries a freshly minted `record_id` and therefore **can never collide between
two postings**; it is shaped that way because a partitioned table's unique
constraint must carry its partition key. The companion's PRIMARY KEY omits
`business_period` and `record_id` and is the only natural-effect reservation in
the system. The FK runs companion → movement `ON DELETE RESTRICT`, so a movement
with no reservation row violates nothing.

### What the read-back adds over the database — narrowed after measurement

The companion → movement foreign key covers **all ten** companion columns and
its targets are **exactly** `effectIdentityUnique`. So `effectIdentityUnique`
carries `record_id` because it is **this foreign key's target**, which the
charter's own account gave only half of.

- A reservation with a **wrong effect tuple** has no referent: PostgreSQL
  refuses it with **23503**. Its control must SUSPEND the compiled constraint to
  construct its subject, and its claim is scoped to that — it proves the
  read-back does not depend on the foreign key staying this wide, **not** that a
  wrong effect can be written today.
- A reservation that is **absent** violates nothing, because the foreign key
  runs companion → movement. **That is the live gap**, and its control
  constructs its subject without touching the schema.

**The claim must not be stated as the first when the evidence is the second.**

`assertPersistedRowVerified`'s entity parameter was narrowed to the shape it
actually reads (`foldedColumns`), so the reservation — a compiled companion
relation, not an entity — is verified by the same mechanism rather than a
parallel one. Its generated-column set is DERIVED as the intersection of the
movement's generated columns with the companion's declared columns; **measured
empty today**, and still correct if the compiler ever copies one.

## Deliverable 3 — the simultaneous post

Two authored documents, one natural effect, two stock identities, two
idempotency keys — and the test asserts the disjointness of both locks rather
than asserting it in prose.

**The hold point needed real work, as the charter predicted.** The existing
`installLineRaceBlocker` is `BEFORE INSERT` on the movement, which parks a
posting *before its reservation exists*, so the collision under measurement never
happens. The new blocker fires `AFTER INSERT` **on the companion itself**, so the
parked posting holds both its movement and its reservation uncommitted.
Installing it on the companion rather than on the movement makes the hold point
independent of trigger firing ORDER — it is reached by construction when the
reservation row is written, not by a trigger name that sorts late enough, which
would have been fragile against both `nsm_g_` and `nsm_z_`.

**The outcome assertion is a disjunction on purpose.** Exactly one semantic
effect is accepted and exactly one movement and one reservation exist; the loser
must reach replay OR conflict handling, and which one depends on whether the
winner's receipt is visible when the loser re-reads. Both are correct; a second
committed movement is not.

## Deliverable 4 — controls

In lease, and no mutation subject outside it. Both install a REPLACEMENT
reservation writer through the admin pool — the `installLineRaceBlocker`
pattern — and disable the real one.

- **A wrong reservation writer** — the replacement copies the movement
  faithfully except one column of the five-column effect tuple. **CORRECTED
  AFTER REVIEW: this control must SUSPEND the compiled foreign key to construct
  its subject at all**, because that key covers all ten companion columns, so a
  wrong effect tuple has no referent and PostgreSQL refuses it with `23503`. It
  therefore proves the read-back compares the effect tuple INDEPENDENTLY of the
  constraint and would still catch a wrong reservation if the compiled
  declaration narrowed. **It is not evidence of a reachable defect today**, and
  an earlier version of this line said the foreign key was satisfied, which was
  false.
- **A missing reservation writer** — the replacement reserves nothing, and the
  posting must refuse and commit no movement, no reservation, no balance, no
  document transition, no trust evidence and no receipt.

### A cross-plane coupling, found by a control failing for the wrong reason

The first version of the missing-reservation control simply DISABLED the real
trigger, and the posting refused — **from the wrong layer.** Measured:

`reserve_inventory_movement_effect` does two things on every movement insert. It
writes the effect reservation, **and** it calls
`north_star_internal.advance_semantic_aggregate_generation`. The posted-stock
balance trigger fires later on the same insert and raises
`POSTED_STOCK_BALANCE_GENERATION_MISSING` (P0001) when that generation row is
absent. So disabling the trigger removed both effects at once and the posting
refused before the reservation read-back was ever reached.

**A red for the wrong reason certifies nothing**, so both controls now keep the
generation advance and vary exactly one property: what, if anything, gets
reserved.

**Then the replacement lost a second race, and it is worth recording because it
is the same shape.** PostgreSQL fires same-event triggers in NAME order. The
real reservation trigger is `nsm_g_…` and the balance trigger `nsm_z_…`, so the
real one wins by construction; a replacement named `pwi_…` sorts after both and
reproduced the identical wrong-reason red. The generation advance now runs
`BEFORE INSERT`, which precedes every `AFTER INSERT` trigger **by PostgreSQL's
own semantics rather than by sorting late enough**; only the companion write,
whose foreign key needs the movement row, stays `AFTER`. The same reasoning is
why the simultaneous-post blocker is installed on the COMPANION rather than on
the movement.

**Both of these were caught only because the control was required to red for its
OWN stated reason** rather than merely to red — `review-tiers`, "Verify why a red
fired, not just that it fired". A control asserting only "the posting refuses"
would have passed twice while proving nothing.

**The first finding is worth more than the fix.** The module-plane balance projection
**depends on a platform-plane row** written by the reservation trigger, so those
two writers are not independent — which is a fact about the plane boundary this
packet's derivation draws, and a reason
`posting-platform-plane-writes-not-row-complete` matters more than a
"documents and receipts are unobserved" summary suggests.

The expected-red manifest mutates only this packet's own verifier.

## Review evidence, and the acceptance ruling

**Two online arms, both BLOCK, both correct, neither argued down.**

| Round | SHA | Verdict | What it found |
|---|---|---|---|
| 1 | `942f5fc` | BLOCK | F1 traversal + edge declaration, F2 decorative registration strings, F3 overclaimed evidence |
| 2 | `134fcd8` | BLOCK | N1 deferred-trigger timing, N2 non-callable verifier type, residual contradicting comment |

**CLOSED across the two rounds:** F1's traversal (transitive worklist, held by a
chained-writer control), F3 (claims narrowed everywhere), the empty-observation
refusal (held by an induced observer defect), N2 (callable verifier type —
**measured** by injecting `{ name: 'assertDraftTransaction' }` and observing
`TS2353`), and the residual comment.

**STILL OPEN, and stated as limits rather than repaired:** F1's edge declaration
(`module-writer-edges-are-convention-not-declaration`), the verifier-ran half of
F2 (`posting-writer-coverage-is-declared-not-observed`), and N1's deferred-trigger
vector (`posting-write-observation-misses-deferred-triggers`).

### ACCEPTED ON NARROWED CLAIMS, NO THIRD ARM — user ruling, 2026-08-31

The ruling was made on evidence, not on fatigue, and the evidence is worth
recording because it is the stop criterion this programme keeps relearning:

- **Round 2 found ZERO production defects.** Every finding was a claim outrunning
  its enforcement. Nothing misbehaves; no wrong row is written.
- **Severity was converging even though the count was not.** Round 1 found a
  *shipped* registration naming a function that does not exist. Round 2 found a
  type that would *permit* recreating that, and a trigger form nothing in the
  repository uses. Round 3's findings were predictable in kind — non-tuple
  writes, `TRUNCATE`, DDL — all true, all unreachable, all narrowing the claim
  further without changing code that runs.
- **The reviews had stopped finding defects and started finding LIMITS.** That is
  information about the ambition, not the code, and it converges only by ceasing
  to promise completeness — which the narrowed claims now do.

**N1 was narrowed rather than fixed, deliberately.** The candidate repair,
`SET CONSTRAINTS ALL IMMEDIATE` before the snapshot, changes transaction
semantics on the Critical posting path and would force migration 0006's deferred
platform-plane constraints to validate early. Docker became unavailable before it
could be tested. **An untested change to transaction semantics on a Band-A path
is a worse risk than a vector measured dormant**, so the limit is stated and the
control that settles it is filed.

**What this packet no longer claims is completeness. That is the correction, not
a concession.**

## Record claim

`main` gained `record-claim-fidelity`'s gate while `PUR-2a` ran, and this branch
is cut from `PUR-2a`, so **the checker does not exist on this branch and the
block below is UNVERIFIED BY IT.** Verify at integration with
`bash scripts/check-records.sh` on the merged tree. What WAS verified here, by
git plumbing against the frozen commits rather than the working tree:

- every claimed path really differs between `base` and `head`;
- every claimed symbol is a top-level declaration at `head`;
- no executable path changed in `base..head` that the roster omits —
  `test/evidence/**` counts as executable, which is the trap `PUR-2a` round 4
  found, and the manifest is claimed accordingly.

`head` is the last EXECUTABLE commit; the narrative commits that record the
matrix sit above it by construction, and it carries a
`Packet: posting-writer-inventory` trailer.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "posting-writer-inventory",
  "base": "8bc097cdd6402388d80911db004590e335a6d5c6",
  "head": "794770527d1e9ea65f37be001a3547e2744a43a0",
  "changedPaths": [
    "packages/postgres-provider/src/inventory-posting-service.ts",
    "test/evidence/posting-writer-inventory.expected-red.json",
    "test/postgres/inventory-posting.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "PostingWriterOrigin"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "PostingWriterRelation"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "PostingWriterRegistration"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "TriggerInstalledProjection"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "MovementEffectReservationBinding"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "derivePostingWriterInventory"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "assertPostingWriterInventoryRegistered"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "movementEffectReservationBinding"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "assertMovementEffectReservations"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "assertPersistedRowVerified"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "resolvePostingStorage"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "PostgresInventoryPostingService"
    },
    {
      "path": "test/postgres/inventory-posting.test.ts",
      "name": "requiredTargetEntity"
    },
    {
      "path": "test/postgres/inventory-posting.test.ts",
      "name": "movementFactStorage"
    },
    {
      "path": "test/postgres/inventory-posting.test.ts",
      "name": "activeBalanceCount"
    },
    {
      "path": "test/postgres/inventory-posting.test.ts",
      "name": "installReplacementReservation"
    },
    {
      "path": "test/postgres/inventory-posting.test.ts",
      "name": "removeReplacementReservation"
    },
    {
      "path": "test/postgres/inventory-posting.test.ts",
      "name": "assertAbsentEffectReservationRefuses"
    },
    {
      "path": "test/postgres/inventory-posting.test.ts",
      "name": "assertWrongEffectReservationRefuses"
    },
    {
      "path": "test/postgres/inventory-posting.test.ts",
      "name": "installEffectReservationBlocker"
    },
    {
      "path": "test/postgres/inventory-posting.test.ts",
      "name": "removeEffectReservationBlocker"
    },
    {
      "path": "test/postgres/inventory-posting.test.ts",
      "name": "effectRaceLockKey"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "moduleWriteCounters"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "assertObservedWriteSetIsDerived"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "PostingReadBack"
    }
  ]
}
```

## Round 1 — BLOCK, and every finding is upheld

The first online arm returned **BLOCK** on three findings. All three were
verified against the tree; **none was argued down.**

**F1 — the projection edge is convention, not declaration, and the traversal was
not transitive.** Both halves real.

- *Traversal (FIXED here).* Each trigger edge was tested against the ORIGINAL
  root set in one pass, so a relation reached only THROUGH another trigger was
  invisible. It is now a worklist closure carrying the origin by which each
  entity was reached. Held by a chained-writer control — the balance given its
  own fact storage, reached at two removes — and by an expected-red entry that
  restores the single-pass behaviour exactly.
- *Edge declaration (NOT FIXED, and not fixable in this lease).* The target
  declares an entity's table, its partitions, and its
  `factStorage.companion.reservationTriggerName` — three of four expansions,
  honestly. It declares **nothing** about the movement → balance edge. The
  materializer invents it from an entity-id suffix and a computed trigger name;
  this service reconstructs the same convention independently. *"Both are pure
  functions of the target" does not make the edge target-declared.* Filed as
  `module-writer-edges-are-convention-not-declaration`.

**F2 — a registration was an unchecked string.** Upheld, and the reviewer's
evidence was decisive: the shipped registration named `assertDraftTransaction`,
**a function that does not exist anywhere in the file**, and construction
accepted it. Registrations now pass the verifier FUNCTION and read the id off
the function object, so naming an absent verifier is a compile error and an
empty list is refused. **That closes "names something absent". It does not close
"never runs on this posting's path"** — filed as
`posting-writer-coverage-is-declared-not-observed`.

**F3 — committed evidence overclaimed.** Upheld. The manifest and the record
said a wrong-effect reservation satisfies the foreign key; it does not, which is
why the control must suspend that key. Both artifacts corrected.

**ADR-0062 carries both corrections inline and must not be read as claiming edge
completeness.**

### Round 2's substantive answer: observation, not a better list

F1's edge half could not be closed by writing a more careful edge list, because
the compiled target declares no edge at all for the projection. So the posting
**stopped asking the target what it wrote and asked PostgreSQL.** Before any
trust document or receipt, the module-plane write set is read from
`pg_stat_xact_user_tables` and every relation in it must appear in the derived
inventory.

**Two measurements decided the design, and one of them would have made it wrong
if skipped:**

| question | measured |
|---|---|
| do the per-transaction counters reset at transaction boundaries? | **NO.** A session that inserted 1000 rows reported them at the next `BEGIN` before writing anything. The service borrows pooled connections, so the write set must be a DELTA against a baseline taken inside the transaction. |
| what does it cost per posting? | **4.5ms per snapshot**, on 20 relations one carrying 200k rows, **flat in table size**. |
| what does the obvious alternative cost? | The `xmin = txid_current()` scan agreed **exactly** on the answer and cost **11x more** at that trivial scale, growing with the data. |

**An observer that sees nothing passes everything**, so an empty write set is
refused — every posting inserts at least one movement, and a wrong schema
filter or an unreadable view would otherwise look like unbroken green. The
control writes to a module relation nothing declares, through a trigger the
target knows nothing about, and requires the posting to refuse and name it. The
suite records the refusal verbatim:

> `INVENTORY_POSTING_STORAGE_REJECTED: this posting wrote module relations the
> compiled writer inventory does not derive: nsm_t_pwi_undeclared_writer`

**This needed no out-of-lease file.** The bridge into `storage.ts` and
`module-storage-materializer.ts` is no longer on this packet's critical path —
the design defect behind F1 stays filed and open, but the RISK it created is
closed by a different route than the reviewer proposed.

**What is still not proved:** that a registered verifier actually RAN for the
relation it is registered against. Observation proves the relation was written
and is derived; it does not prove a read-back compared its columns.

### A control of this packet's own was a SURVIVOR, and the run caught it

`an-empty-observation-passes-silently` removed the empty-observation refusal and
**the suite stayed green** — because the undeclared-writer control does not
produce an empty observation, so the guard it was meant to hold was never
exercised. **A mutation that stays green holds nothing.** Shipping it would have
certified the guard while testing something else entirely.

Rebuilding it needed a measurement first: **`ALTER SYSTEM SET track_counts = off`
does NOT empty `pg_stat_xact_user_tables`** — those counters are backend-local,
so the backstop survives that misconfiguration and **no operator setting can
reach the empty case.** The guard therefore defends against a defect in the
observer itself, and the control has to induce one: the schema filter is sent
looking for a schema that does not exist, with the bound parameter kept
referenced (dropping it would red with `42P18`, the wrong reason). The control
then dies by refusing for the EMPTY reason rather than the UNDECLARED one, which
is exactly what separates an observer that saw nothing from one that saw the
writer.

### Three things this round got wrong, all found by running rather than reading

1. The first closure claimed a projection's table twice — once at the edge, once
   on dequeue — and **red five tests**. The duplicate-writer guard caught it.
2. The first version of the transitive-closure expected-red entry **was not a
   control**: deleting the enqueue dropped the balance from the inventory
   entirely, so it red broadly for a stale-registration reason another entry
   already owns. A red that cannot be attributed to its own subject proves
   nothing.
3. A `test:postgres` run showed a third failure that was a **300s timeout** in
   `composed-application.test.ts` after five suites ran back to back. Run alone,
   that file returns 17/15/**2** — the inherited pair only.

**That is the third, fourth and fifth time in this packet that a control or a
measurement had to be right for its OWN reason rather than merely red.** It is a
pattern in this lane's work, not a run of slips, and it is recorded as one.

## Gate results — measured at `d441baa`

| Gate | Result |
|---|---|
| `typecheck` | OK |
| `lint` (`eslint .`) | OK |
| `format` (`prettier --check .`) | OK |
| `test:unit` | **155 / 155** |
| `test:compiler` | **152 / 152** |
| `test:integration` | **149 / 149** |
| `test:architecture` | **178 tests, 177 pass, 1 fail** — the out-of-lease line-pinned press-law control; see Stops |
| `evidence:expected-red` at round 2 | **OK — 42 reproduced and restored**, this packet's 6 among them |

**FINAL round-2 matrix, measured with container cleanup between suites:**
`test:unit` 155/155, `test:compiler` 152/152, `test:integration` 149/149,
`test:architecture` **178 / 177 / 1** (the out-of-lease pin alone),
`test:postgres` **217 / 215 / 2** (the inherited pair alone),
`evidence:expected-red` **OK — 44 reproduced and restored**, all eight of this
packet's among them, `check:expected-red-controls` OK (38).

Architecture and postgres are identical to round 1 apart from this packet's own
added test, which is what confirms the intervening third postgres failure was
machine load rather than the tree.
| `test:postgres` **(REQUIRED)** | **216 tests, 214 pass, 2 fail** — both the inherited `composed-application.test.ts` refusals, measured at the base and unchanged |
| `check:expected-red` (validate) | OK — 39 entries across 4 manifests still name live production text |
| `evidence:expected-red` (FULL manifest population) | **OK — 41 expected reds reproduced and restored**, this packet's 5 among them |
| `check:expected-red-controls` | **OK — 38 controls** |
| `check:app-release` | **RED, inherited** — `compiled application release is stale` |

**The widened verifier was re-measured rather than assumed.** This packet narrows
`assertPersistedRowVerified`'s entity parameter to the shape it actually reads, so
`PUR-2a`'s two controls over that mechanism —
`a-verifier-stops-comparing-a-column` and `a-read-back-observes-a-partial-row` —
were run against the new signature and **both still kill their two declared
victims each**. They are also inside the full-manifest run above.

**Every one of this packet's three new postgres tests passes**, and the five
other postgres files that import `inventory-posting-service.ts` —
`inventory-backdate-policy`, `inventory-backup-restore`, `inventory-stock-count`,
`inventory-reconciliation` and `inventory-posting` — all pass with the new
read-back running on every posting they perform.

### The inherited pair, measured rather than recalled

Two independent arguments, because "inherited" is a claim and not an excuse.

**Non-causation by construction:** `composed-application.test.ts` **does not
import `inventory-posting-service.ts`**, and that file is this packet's ONLY
production change, so the diff cannot reach the failing path.

**Non-causation by measurement:** the file was run **at the base commit
`8bc097c`**, in the separate `packet/pur-2a` worktree, and returns
**17 tests / 15 pass / 2 fail** — the same two test names, carrying
`COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED` on
`northstar.app:relation.stock_count_line_transaction_line`. Identical at base and
at head; nothing about this pair changed.

### An architecture red that was NOT the tree, and a first diagnosis that was wrong

Architecture returned **178/176/2** twice. The extra failure was
`repository-hygiene.test.ts`'s *"matrix lock and legacy-process waits fail busy
at their bounded deadline"*.

**The first diagnosis was that a second lane's suite was contending for the test
lock, and it was written into `lanes.md` as measured before it had been
measured.** The re-run meant to confirm it refuted it. The real cause was a
leaked `north-star-*` ephemeral container from a run this lane had killed:
`run-matrix.sh` refuses with `POSTGRES_CONTAINER_CONTAMINATION` before it can
refuse for the reason the test asserts, so the validator sees the wrong refusal
and reports a bare assertion failure that names neither the container nor the
cause.

Removing the container and changing nothing else returned **178/177/1**. Three
runs at one commit gave 2, 2 and 1 failures, differing only in container state.
Recorded in `lanes.md`, wrong first diagnosis included, because the correction is
the useful part.

## Stops

**ONE, and it is a bridge request rather than a quiet edit.**

`test:architecture` is 177 pass / 1 fail. `test/architecture/module-press-law.test.ts`
pins a routed PRESS006 coordinate **by line number** at
`inventory-posting-service.ts:1193`; this packet's insertions move that same
source line to 1278. The file is **outside this packet's lease** and is held by
no live lane, so the change was not made.

The fix is one integer at `module-press-law.test.ts:484`, plus the move history
in the comment above it.

**This is the ninth move of that pin, caused by the fourth unrelated packet**
(`PUR-2a` recorded the eighth, 1132 → 1193). Filed by `PUR-2a` as
`press-law-splice-control-pinned-by-line-number`. Nine moves by four packets is
the argument for **fixing the pin rather than the integer**: every packet that
adds a line above the routed coordinate inherits an architecture red it did not
cause and cannot fix inside its own lease.
