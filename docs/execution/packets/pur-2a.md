# PUR-2a — the posting-family mechanism, proven on stock count

Cut from `2908e7faff74386bfef07abe741609fa0c76be24` (`origin/main`) on branch
`packet/pur-2a`. Tier: **Critical** — the change makes the posting kernel the
writer of a companion document identity, and a posting that writes the wrong
companion identity is silent until something reconciles it. Evidence band:
**Band A, declared.** Full `AGENTS.md` §6: one recorded red per vacuity
vector, each varying exactly one property.

Routed here by `purchasing-sales-v1-plan.md` §7.16, which capped ADR-0049's
design phase after `PS-0`, `PS-1` and `PS-2` each ruled the mechanism settled
having built only goods receipt, and each was refuted by stock count. This
packet opens with construction, not a design document.

## What the charter said was the real risk, and what construction found

The charter named one genuine stop: *"discovering that the companion
identities cannot be derived from the stock-count source alone."*

**They can.** That is the packet's first result and it is measured, not
reasoned. A companion transaction id is a pure function of `stockCountId`, and
a companion line id a pure function of `stockCountLineId`, through
`deriveInventoryPostingCompanionId` — SHA-256 over
`namespace | capabilityId | familyId | companionFamilyId | sourceRecordId`,
stamped as an RFC 9562 version-8 UUID. Purity buys the two properties that
matter: nothing a caller sends can steer the companion identity, and a retry
derives the same identity and collides on the primary key rather than minting
a second companion for one source.

**What construction found instead is a different constraint, and it is real.**
See "The one blocked gate" below.

## The defect, restated from measurement

1. Both stock-count companion relations were required create-time inputs
   (`packages/domain/src/inventory/definition.ts`, `stockCountTransaction` and
   `stockCountLineTransactionLine`), so a stock-count source could not exist
   before its companion transaction. The shipped fixture inserted the
   transaction and its lines first.
2. The kernel read those columns and never wrote them.
3. There was no compiled family binding at all. Posting dispatched on
   hardcoded strings — a `command.sourceType !== 'stockCount'` literal and
   three `switch (postingRole)` statements.

## What was built

### One compiled family-execution binding, keyed by `(capabilityId, familyId)`

`INVENTORY_POSTING_FAMILIES_V1` in `inventory-posting-service.ts` is the
roster. A **family** is the source entity family a posting executes for, in
the vocabulary the inventory contract already uses (`LEGAL_ENTITY_FAMILY_MAP_V1`
lists `stock_count`, `inventory_transaction`, `goods_receipt`'s eventual
neighbours). `origin` is ADR-0049 §4's authored/companion axis:

- `inventory_transaction` / `authored` — the caller authored the transaction
  and hands it to the kernel, which validates the draft it was given. Roles:
  `adjustment`, `transfer`.
- `stock_count` / `companion` — the caller authored the source; the inventory
  transaction is a companion the kernel derives and writes. Roles: `count`,
  `correction`.

`resolvePostingFamilies` resolves every entry against the **compiled storage
target** in the registration: each entity by its compiled entity id, each
relation column by the compiled relation, each enum option by the compiled
field contract. A family naming anything the supplied target does not carry
throws at service construction rather than at posting time.

**The timing is worth stating exactly, because the obvious sentence overstates
it.** Resolution happens at construction, against the target the service was
handed. `assertActiveRelease` happens per posting, and it is stronger than a
hash comparison — it matches the target's canonical BYTES against the
projection chunk the active release persisted. So the honest claim is the
conjunction: a family the ACTIVE RELEASE cannot satisfy can never post.
Construction alone proves only the weaker half.

The three `switch (postingRole)` statements became lookups in that binding, and
the `'stockCount'` literal became the family's declared `sourceType`.

**The limit, stated plainly.** What is frozen in the provider is the ROSTER —
which families exist. What is compiled and release-verified is everything each
family is MADE OF. §1.1 of ADR-0049 (upheld) requires the catalog to arrive as
a compiled projection and `PUR-2` to prove it is the exact active-release
artifact; that is true of the storage target, which is content-hashed in the
registration and checked by `assertActiveRelease`, and therefore true of every
part each family resolves. It is **not** true of the roster itself. Moving the
roster into the compiled contract release requires a change to
`InventoryPostingRegistrationV1`, which has fourteen construction sites, two of
them outside this packet's lease.

**The roster IS executable authority — PROVIDER authority, not active-release
authority.** *Corrected in round 3; an earlier version of this section said the
packet "does not claim the roster is executable authority", which contradicted
both the code and the revised ADR-0060.* Production branches directly on
`family.origin`, and the roster decides the pinned source type, the movement
role option, the companion transaction type, the business-key prefix, and which
families exist at all. What it is NOT is release-supplied: the active release
validates that every part a provider-declared family names exists, and never
declares the family or authorises its origin. That distinction — not a denial —
is what keeps this clear of the ADR-0049 claim §7.16 marked REFUTED.

### The kernel is the writer of both companion identities and both revisions

- The command lost `transactionId` and per-line `transactionLineId`. A command
  that still supplies one is refused by `exactKeys`.
- `writeCompanionTransaction` inserts the companion header and its lines inside
  the posting transaction, directly in `posted` state, each at the compiled
  optimistic-revision contract's `initialValue: '1'` — they are CREATES.
- `transitionStockCountToPosted` writes the companion transaction id onto the
  source in the same compare-and-set that posts it. The guard is `IS NULL`, so
  it can only ever fill an unwritten identity.
- `writeCompanionLineIdentities` writes each derived companion line id onto its
  source line, guarded `IS NULL` for the same reason, **and advances that
  line's revision**, because writing the relation mutates the row.
- `assertCompanionIdentitiesPersisted` then reads both back **out of storage**
  and recomputes the expected identity from the source record id read back from
  the same row. That is observation of the persisted effect, not a report that
  the writes returned a row count.

**No authored verifier is re-run over kernel-written rows.** For a
companion-origin family the header lock, the draft-header assertion and the
line-set assertion are structurally skipped. They exist to protect an AUTHORED
draft against edits between validation and posting; a row created inside the
posting transaction has no such window, and re-running them here would be a
verifier sharing a code path with the writer — `AGENTS.md` §6's fifth vacuity
vector, and evidence of nothing.

### The relations are optional, pinned rather than merely permitted

`definition.ts` passes `required = false` for both, and
`packages/compiler/src/conformance.ts` pins the expectation to `false` in the
same pinned rule table that previously pinned it to `true`. Two table cells;
`stock_count_line_session` stays required, because a parent-scoped child
genuinely cannot exist without its session.

## Gate-invisible deliverables, named as acceptance criteria

Per `mission-cadence`'s R4 obligation. **The binding makes two things possible
that were not possible before, and both are proven rather than asserted.**

1. **An operator-visible refusal.** The kernel writes the companion identity at
   post time, so a reviewed stock count that already names one — the shape
   every pre-derivation count has — is refused with
   `INVENTORY_COUNT_EVIDENCE_CONFLICT` naming the companion specifically.
   `reviewed-source-companion-must-be-null-fence-removed` holds the refusal's
   IDENTITY and nothing more: non-adoption is enforced separately by
   `transitionStockCountToPosted`'s own `IS NULL` compare-and-set, and the
   kernel is **not** the only reachable writer of a companion column — see
   `companion-writers-not-closed`.
2. **A reconciliation predicate anyone can recompute.**
   `deriveInventoryPostingCompanionId` is exported, pure, and takes only source
   ids, so a reconciliation reader can recompute a companion identity **without
   the posting kernel** and compare it to what is stored. The acceptance test
   uses exactly that entry point rather than reading the value out of the
   posting result, so a kernel that minted its companion some other way fails
   there. **Revision equality is NOT part of that predicate** — the derived
   identity is the whole join. Creates take revision `1` and mutated rows
   advance by one; that is a different fact, asserted separately.

**What the binding does NOT make possible, stated so it is not assumed:** no
reconciliation VIEW, query, or surface ships in this packet. The predicate is a
function and two column comparisons; nothing renders it. That is `PUR-2c`
territory and is not claimed here.

## The acceptance control

§7.16: *"`PUR-2`'s first acceptance control is stock count, not goods receipt."*

`test/postgres/inventory-stock-count.test.ts`:

- `stock-count companion derivation: a source with no pre-staged transaction
  posts and the kernel writes both companion identities` — asserts, **before
  posting**, that the source exists, its companion column is null, its lines'
  companion columns are null, and that there are **zero** `inventory_transaction`
  and **zero** `inventory_transaction_line` rows in the tenant. Then posts, and
  asserts both derived identities, both revisions, and the companion's posted
  state.
- `stock-count companion derivation: the companion transaction and its lines
  are the kernel projection of the count` — the companion's business key,
  source type, source id, type, reason, and the sign-dependent from/to location
  projection in **both** directions.
- `stock-count companion derivation: a reviewed count that already names a
  companion transaction is refused` — the operator-visible refusal, plus that
  the refusal leaves stored state alone and writes no movement.

`seedReviewedCount` in both `inventory-stock-count.test.ts` and
`inventory-backup-restore.test.ts` no longer stages a transaction at all.

**There are no purchasing entities in this packet.** No `goods_receipt`, no
lines, no purchase-order change — building goods receipt first is what let
three passes miss this.

## Evidence — Band A, and what each vector is held by

`test/evidence/pur-2a.expected-red.json`, nineteen entries, run through
`evidence:expected-red` under ADR-0058: each mutation is measured before the
restored run, each declared kill must fail in its own body for its own declared
reason, and the observed kill set must equal the declared one exactly.

| §6 vacuity vector | Held by |
|---|---|
| The subject absent entirely | `source-companion-column-never-written`, `source-line-companion-column-never-written` — the identity is not written; `companion-identity-not-derived-from-the-source` — the source-dependence is gone |
| The check reading zero input | `source-line-companion-column-never-written` — the read-back's join returns zero line rows, and the length comparison reds rather than a loop passing over nothing |
| A proxy satisfied while the fact does not hold | `companion-revision-not-the-contract-initial-value`, `source-line-revision-recorded-wrongly-for-comparison`, and `source-line-companion-column-never-written` — every write reports its row count and the persisted fact is still wrong; only the read-back catches either |
| Output shapes the parser does not recognize | The runner's own 38 controls, `check:expected-red-controls`, wired as its own gate in CI and the matrix. This packet adds no parser of its own |
| **The subject repaired before it is measured** | Structurally: no authored verifier is re-run over kernel-written rows. Executably: `companion-derivation-namespace-moved` — a derivation that changes but stays deterministic passes the kernel's own read-back, because the read-back recomputes with the function that wrote. Two golden vectors computed by a separate implementation are the only assertion that does not share the algorithm under test |

**Each entry's scope limit is declared on the entry.** Every run is scoped by
`namePattern` to the three `companion derivation` tests, so the kill set is
measured within those three — which is what the runner observes. Where a
mutation also reds the wider stock-count file, the entry says so rather than
implying it was measured.

**Two mutations were repaired after measurement, not after reasoning.**
Deleting a `SET` assignment leaves its bound parameter unreferenced and
PostgreSQL refuses the statement with `42P18` — a red, but not the declared
one, and an entry whose kill dies for the wrong reason certifies nothing. Both
null-write mutations now use `NULLIF`. A third entry was declared against an
`assert.rejects` message the assertion never reaches, and the test was
restructured so its refusal identity is asserted directly.

**One control was a survivor before it was evidence.**
`family-roster-transaction-type-repointed` stayed green because the projection
test read only the `correction` role's companion type while the mutation moved
the `count` role's. The test now reads both, so each declared role binding is
observed by something.

## Round 7 — the class, not its seventh field

**F15, Critical, verified:** the movement relied on the column default for its
revision and had no archive check, so a create-contract violation survived the
insert, the row count, every field comparison and every parent check.

**But the finding that mattered was the convergence one.** Rounds 2, 3, 5, 6
and 7 each found exactly one more column a posting wrote and no read-back
observed — source-line revision, source-header actor and instant, movement
transaction relation, authored header state, movement revision. Every fix was
correct and none stopped the next, because each was a FIELD and the defect was
a CLASS: a verifier whose coverage was a hand-written list that nothing ever
compared against the row it verified.

`assertPersistedRowFullyAccountedFor` compares them. Every read-back selects
`to_jsonb` of the row it verified and declares the columns it actually
COMPARED; any column the row carries that the verifier does not account for
fails the posting. **Applied to all six direct writers** — companion header,
companion lines, movement, authored header, source header, source lines. A
column added to an entity, or a comparison quietly dropped, is now refused at
posting time instead of found by the next reviewer, and
`a-verifier-stops-accounting-for-a-column` holds exactly that.

**The accounted list is deliberately NOT derived from the compiled binding.**
Deriving both the row and its coverage from one source would make a shared
omission invisible, which is the failure round 7 named explicitly.

**It found a category on its first run that seven review rounds had not.**
Storage-GENERATED case-fold columns exist on these entities: the database
computes them, and the kernel never writes one. They are admitted by
DERIVATION — a generated column is accounted for only if its source column is
itself compared — because comparing one would be comparing the database to
itself, and admitting one unconditionally would be a hole in the mechanism that
closes the hole.

**Declared limit of the class control.** It proves that REMOVING coverage
fails the posting. It cannot be built the other way round: with full coverage
and correct values there is nothing for a mutation that disables the mechanism
to kill. The generated-column admission likewise has no committed control for
its conditional half; what is held is that removing the admission entirely
breaks correct postings.

## Round 6 — the AUTHORED header, and a control masked by a uniqueness collision

**F13, Critical, verified.** `transitionTransactionToPosted` writes state and
revision to the authored transaction header and observed neither
independently: it checked the affected row count and the revision its own
`RETURNING` reported — the mutating statement reporting on itself — and never
read `state` at all. A wrong-but-valid state written alongside a correct
revision increment survived, so an adjustment could report a successful posting
while its header stayed a draft. An independently issued re-read now compares
identity, state and revision, held by a control that writes `draft` while
keeping the increment correct.

**This is the authored twin of rounds 2, 3 and 5.** Those found unobserved
writes on the source line, the source header, and the movement — all on the
companion-origin path, because that is what this packet built and what its
review prompts kept naming. Adjustment and transfer run through
`transitionTransactionToPosted` and had no persisted header observation at all.
**The correct enumeration was never "source header, source line, companion
header, companion lines, movement" — it is every direct writer executed inside
the savepoint, across BOTH origins**, and three consecutive prompts of mine
framed it the narrower way.

**F14, evidence.** `companion-business-key-not-derived-from-identity` used a
CONSTANT number, so the second companion in the projection test collided on
`inventory_transaction_number`'s unique business key and the mutant died at the
database boundary — before the test reached its assertion that the number
equals the derived identity. It proved non-collision while claiming derivation.
Split: the constant mutation now holds non-collision under its own name, and a
wrong-but-UNIQUE prefix holds derivation by removing uniqueness as an alternate
kill.

**A factual correction to the round-6 review, which does not change its
verdict.** It reported the delta above the attested head as
`docs/execution/packets/pur-2a.md` and `docs/plans/purchasing-sales-v1-volume-2.md`.
The second path does not exist anywhere in this repository; the actual second
file is `docs/execution/current-plan.md`. Both are narrative, so "docs-only
above the attested head" holds either way.

## Round 5 — the movement row, which four rounds of "either row" never named

**F11, Critical, verified.** `readBackMovements` selected the committed
movements and MAPPED them into the result. It compared nothing but the row
count, so whatever storage held became the returned value and the receipt's
record of it. It also never read the movement's DIRECT transaction relation,
its reason, actor, reversal identity, or stock-dimension version — the last of
which it hardcoded to `'v1'` rather than reading.

The sharpest consequence is one nothing else could catch. A movement carries
two companion relations, and **the storage model does not tie them together**:
the compiler lowers each declared relation to its own foreign key over scope
plus record id, and asserts nothing about a movement's transaction being the
parent of its own line. So a correction's movement can name the superseded
count's companion header while keeping its own line, satisfy both foreign keys,
and pass every companion projection assertion — while the result and the
receipt record a different transaction than the row does. It surfaces only when
an unrelated natural replay compares the two.

`readBackMovements` is now a verifier: every field `insertMovement` writes is
compared against what was planned, and the line's parent transaction is joined
and required to be the transaction the movement names directly.

**Why four rounds missed it.** F5 and F8 were both "a write the read-back did
not observe", and after F8 this record predicted that a fifth finding, if it
existed, would be of that class. It was — and the search went to the source and
companion rows, which this packet's own review prompt called "either row". The
movement row is written by `insertMovement` inside the same savepoint and was
never in the frame. **The prediction was right and the scope of the search was
wrong**, which is a more useful thing to have recorded than a clean sweep.

**F12, records.** The `source-line-revision-does-not-advance` claim named
`source-line-revision-reported-but-not-stored` as its complement — a control
that does not exist under that name; it is
`source-line-revision-recorded-wrongly-for-comparison`. The manifest's own
derivation map was false, and `expected-red` stays green through it because the
runner measures mutations and kills, not whether prose resolves.

## Round 3 — F8, and a record rewrite that was not yet final

**F8, new and Critical, verified.** `transitionStockCountToPosted` writes five
facts to the source in one compare-and-set — state, recorded instant, actor,
companion id, revision — and only three were read back. The companion header's
actor and instant WERE compared, but that is a different row, so a
wrong-but-valid actor or instant committed on the source while the trust
documents recorded the expected in-memory values. A posting could report
success with the business row and its own evidence disagreeing about who posted
it and when. All five are now read off the row the statement writes them to,
and two controls hold them.

**F7 was reopened and was right to be.** Round 2's rewrite quarantined the
history but left three stale claims in the governing sections: a sentence
denying the roster is executable authority, an entry count of eight against a
manifest of eleven, and a record claim naming a head five executable commits
behind, omitting a changed file, and claiming a deleted symbol. The record
claim is now REGENERATED from the frozen tree rather than amended — each path
re-read from the diff, each symbol re-checked as a top-level declaration.

**The lesson, recorded because it recurred:** amending a record from its
previous version reproduces the previous version's staleness. Both times F7 was
raised, the fix that failed was an edit and the fix that worked was a
regeneration.

## Review history — HISTORICAL, superseded where it conflicts with the sections above

**Everything below records how the packet got here. Where it disagrees with the
mechanism described above, the sections above govern.** Round 1's account is
kept because the corrections it forced are the substance of this packet, not
because its original claims still hold.

### Round 1 — BLOCK, and it was right on all four findings

The first arm returned **BLOCK** with four Critical findings. I verified each
against the tree before acting; **all four are correct**, and one of them is a
rule violation I argued my way into rather than measured.

| Finding | What I measured | Verdict |
|---|---|---|
| F1 — a released contract changed in place (versioning owed, see below) | Migration `0016`'s own text: writers *"retain the v1 default until their own digest input changes under a versioned migration"* | **Correct, and decisive** |
| F2 — the pair-keyed binding was not what executed | Two lookups: pair-keyed in the entry point, role-keyed in `#post`; `sourceEntityId` and `sourceLineEntityId` written and never read | **Correct** |
| F3 — the companion should start at revision 1 | `storage.ts` declares `initialValue: '1'`; `module-runtime-interpreter.ts` gives every create `projectedRevision: 1` | **Correct** |
| F4 — the read-back was identity-only | It selected six fields: identity, state, revision, parentage. No type, number, reason, instant, quantity, unit or location | **Correct** |

**F1 is the one that should not have happened.** I recorded, as a deliberate
decision, that the digest version need not move because the digest SHAPE was
unchanged. The rule keys on the digest INPUT, and mine changed. I reasoned past
a constraint instead of measuring it, and the packet record carried that
reasoning as settled.

#### Taken in round 1

- **F3** — the companion is inserted at the contract's initial revision. Its
  control is rewritten around the corrected invariant; the old control was
  protecting the wrong one.
- **F4** — the read-back compares every projected header and line field, and
  counts the companion's own children so an extra companion line cannot hide
  behind a source-side join.
- **F2, execution half** — the family resolved by `(capabilityId, familyId)` is
  carried on `ParsedPosting` and is what executes; `transactionType` reads the
  executing family's own role binding; the two unread fields are gone, their
  existence checks kept as visible assertions.
- **Control claims** — three narrowed to what a non-masked assertion observes,
  and the golden vectors and role types compared as single values so neither
  half masks the other.

#### Attempted, measured, and withdrawn

**F1's versioned digest.** Migration `0022` plus a version-4 write were built
here and were green in isolation — the version bump was observable in storage
and a control held the legacy refusal. Run against the whole suite they broke
**eleven tests across seven files**: the checked-in schema snapshot, four
independently pinned tail-migration assertions, two exhaustive migration lists,
and a migration range encoded in a test's own title. Nothing enumerates those
sites, so each arrived as a separate red across three runs.

The comparison decided it. The storage-transition element this packet declined
to build as too large accounts for **two** reds; the five-line migration
accounted for **eleven**. A change with that surface is a platform change, and
finishing it here would ship it with no controls of its own and a schema
snapshot regenerated by a script invented for the purpose. It is withdrawn to
`PUR-2b`, which starts with the pin surface written into its charter — which is
what `mission-cadence` means by moving the unfinished seam into a charter of
its own with the discovered constraints written in from the start.

Filed separately as `migration-addition-has-no-registry`.

**What survives from the attempt:** the public command and line types stay at
**V2**, because the shape genuinely did change and the name should say so, and
a reviewed count that already names a companion keeps its own refusal message.
Neither depends on the digest version. **What is knowingly owed:** the digest
version, the capability version, and the migration, as one coherent piece.

#### NOT taken, because they are not a lane's to rule

The versioned transition for already-released data (`db/migrations/**`), making
the roster an active-release artifact (`InventoryPostingRegistrationV1`, 14
construction sites), and closing the generic companion writers (`apps/web/**`
and the O0 operations). All three are outside this lease and all three are
design rulings. They are recorded in ADR-0060 under *The transition this ADR
does NOT rule, and cannot*.

#### What round 1 refutes in the plan

**§7.16's premise is refuted by construction**, in the same way §7.16 itself
refuted the three design passes. It ruled that the stock-count relations
becoming post-time outputs is *"a code change, not a ruling."* It is a code
change **and** a ruling, because the relations are already released: the
storage planner refuses the transition, and the receipt rule refuses the digest
change. Neither was visible from reasoning; both appeared on contact.

## Gate results, measured at `499aab1` (round 1, superseded)

| Gate | Result |
|---|---|
| `typecheck`, `lint`, `format` | green |
| `evidence:expected-red` (8 entries) | **OK — 8 reproduced and restored**, kill sets exact |
| `check:expected-red-controls` | green |
| `check:boundaries` | green |
| `test:unit` | 155 pass, 0 fail |
| `test:compiler` | 152 pass, 0 fail |
| `test:integration` | 149 pass, 0 fail |
| `test:architecture` | 177 pass, **1 fail** — stop 2 |
| `test:postgres` | 210 pass, **2 fail** — both stop 1. The round-6 third red (`container-pressure-forges-outcomes`) did NOT recur in this full-topology run on the frozen tree, which is the evidence round 6 asked for: an isolated pass was a hypothesis, a clean full suite is a second independent observation |
| `check:app-release` | **RED** — stop 1 |

**All three reds trace to exactly two out-of-lease causes, and neither is in
this packet's production logic.** Every test this packet added or changed
passes, including all four stock-count tests.

## Stop 1 — the release lineage cannot advance

**Corrected after measurement. An earlier draft of this record said the blast
radius was `check:app-release` alone; it is not, and the difference matters
because the second half is this packet's REQUIRED gate.**

Regenerating `apps/web/release/app.compiled.json` refuses:

    COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED
    $.relations  northstar.app:relation.stock_count_line_transaction_line
    v1 rejects mutation or removal of an existing relation physical shape,
    requiredness, ownership, target, or referential action

That one refusal reds three things:

- `check:app-release` — *compiled application release is stale*;
- `test:postgres` › `composed-application.test.ts` › *composed product advances
  an existing deployment to an exact compiled successor* — it shells out to the
  same compile script;
- `test:postgres` › `composed-application.test.ts` › *a same-profile successor
  over one revision is not named a profile-only edge* — same script, asserting
  `compiled` and receiving `failed`.

`test:postgres` is the gate the charter made REQUIRED here, so this stop lands
on it and not only on a release artifact.

`check:app-release` is **RED** and cannot be made green inside this lease.

Regenerating `apps/web/release/app.compiled.json` refuses:

    COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED
    $.relations  northstar.app:relation.stock_count_line_transaction_line
    v1 rejects mutation or removal of an existing relation physical shape,
    requiredness, ownership, target, or referential action

`sameRelationShape` (`packages/compiler/src/storage.ts`) includes
`relationColumn` — and therefore `nullable` — in the compared physical shape,
so relaxing requiredness on an **already-released** relation is a storage
transition the v1 language cannot plan. The composed web application's lineage
has 14 releases and the previous one carries these relations as required.

**This is a constraint on evolving a released relation, not on the target
shape.** A fresh compile is unaffected: the rule only fires when the previous
release already carries the relation, so the module path — including the
acceptance control's own fixture, which compiles `empty` then `inventory` — is
green. `test:compiler` passes 83/83, including the very test that pins this
rule (`relation mapping fingerprints include nullability and existing physical
mutations fail closed`).

**What is needed, and why it is a separate charter.** NOT NULL → NULL is a
widening DDL that is always safe, so the gap is a missing transition element
rather than an unsafe change. Closing it touches
`packages/compiler/src/storage.ts` and
`packages/postgres-provider/src/module-storage-materializer.ts` — both outside
this lease, both Critical, and a wrongly-planned DDL against a live tenant is a
Band-A failure. That is a storage-transition packet with its own evidence
obligations, not a bridge to be taken mid-flight.

**What was NOT done, deliberately.** `compile-app-release.ts` carries
`--truncate-invalid-lineage`. Using it would discard release history to route
around a refusal the language is making on purpose. It is for repairing a
lineage a compiler change invalidated, not for escaping a correct diagnostic.

`app.authored.json` IS regenerated, because it is the honest projection of
`definition.ts`; the staleness `check:app-release` now reports is the true
state, not a hidden one.

## Stop 2 — a control pinned by line number, which this change moves

`test:architecture` › `module-press-law.test.ts` › *consolidated guard red: the
routed Inventory literal cannot mask a later live-comparison splice* fails on
one stale integer.

The control splices `${'northstar'}.${'inventory'}:capability.posting` into the
live provider source at `registration.capabilityId !== INVENTORY_POSTING_CAPABILITY_ID`
and asserts the guard reports it at a **hardcoded** line. That comparison sits
at line 866 in the base and at **1079** here, because this packet added
declarations above `validateRegistration`. The needed change is one integer at
`test/architecture/module-press-law.test.ts:460`, and
`test/architecture/**` is not in this packet's owned paths.

**This packet already avoided the other half of the same problem.** The routed
PRESS006 debt list in that same file pins eight coordinates in
`conformance.ts`; an explanatory comment on the pinned relation table shifted
all eight, so the comment was removed and the compiler change made
**line-neutral** — measured with `checkModulePressLaw`, the eight coordinates
are back at 2371, 2934, 2973, 3142, 3146, 3151, 3155 and 3289, unchanged. The
remaining pin cannot be avoided that way: the public stock-count command types
must change, and they live above the pinned line.

**Filed as `press-law-splice-control-pinned-by-line-number`.** That control
locates its subject by a hardcoded integer, so it breaks for any packet adding
a line above `validateRegistration` in the posting service. The routed-debt
list in the same file already carries the lesson in its own comment — *read the
new values from `checkModulePressLaw` rather than arithmetic* — and locating
the spliced line by content would make this control immune rather than merely
easy to repair.

**Stop count for this packet: 2, plus a BLOCK whose unresolved half is new
scope. `mission-cadence` puts this at the re-scope point, not at a third
continuation.** Both stops are the same
shape: an artifact pinned OUTSIDE this lease that an in-lease change
necessarily moves. Neither is a defect in the packet's production logic, and
neither was foreseeable from the charter.

## Findings routed out, not taken

- **`stock-count-form-offers-a-dead-transaction-picker`.** The
  `stock_count_form` surface still renders a Transaction relation picker.
  After this change, an operator who chooses one creates a count that can never
  post — it is refused by the new fence. The surface is generated from
  `definition.ts`'s surface declarations, which this lease explicitly excludes
  ("the two companion relation declarations only, nothing else in the file"),
  and `apps/web/src/**` is not owned. Filed rather than taken.
- **`companion-key-collision-misreported-as-effect-race`.** Found by this
  packet's own mutation control, not predicted. `#post`'s savepoint catch
  treats any `23505` as a natural-effect identity race; the companion
  transaction now carries a unique business key, so a collision on it is
  diagnosed as a movement race. A primary-key collision on the derived
  companion id is a genuinely different case and is handled correctly, so the
  fix must discriminate by constraint rather than blanket-catch — which is a
  change to the replay path, outside what this packet should touch. Not
  reachable as shipped: the companion number is `SC-` plus the derived UUID.

- **The input digest version is OWED, and the argument for not bumping it is
  withdrawn.** *This bullet previously argued the exemption: that a digest
  version names the input SHAPE and the shape was unchanged. Review round 1
  refuted it and was right — migration `0016` keys the rule on the digest
  INPUT, not its shape, and the input changed when the companion ids became
  kernel-derived. A rule violation does not become compliance by being loud.*
  The version, its `CHECK` migration, and the capability version move to
  `PUR-2b` on the measurement recorded above. **The standing limit:** a receipt
  written before companion derivation replays as an ordinary
  `INVENTORY_POSTING_IDEMPOTENCY_CONFLICT` rather than one naming the contract
  change — visible rather than silent, but the wrong diagnosis, and a violation
  of the versioning rule until `PUR-2b` lands.

## Record claim

`main` gained `record-claim-fidelity`'s gate while this packet ran, so this
block is written to its `northstar.record-claim/v1` schema. **It is UNVERIFIED
on this branch** — the checker lives on `main` and this branch was cut before
it. Verify at integration with `bash scripts/check-records.sh` on the merged
tree.

**Regenerated twice, and the second time for a reason worth recording.** Round
3 rebuilt the roster from the frozen tree after it had gone stale in three ways
— a head five executable commits behind, a missing architecture test, and
`postingFamilyForRole`, a symbol the carried-family correction deleted. Round 4
then found the regenerated block STILL invalid, on two grounds the first pass
missed:

- **`test/evidence/**` is executable for claim-fidelity purposes.** The
  checker's non-executable list is `docs`, `.agents`, `CLAUDE.md`, `AGENTS.md`
  and `learnings.md` — the manifest is not on it. So every manifest repair after
  the declared head moved the tree the record must name, and "zero production
  delta" was the wrong test. That framing was in this packet's own review prompt
  and would have suppressed the finding.
- **The declared head must attest the range.** The checker reads a
  `Packet: <name>` trailer from the declared head's commit message and emits
  `RECORD_CLAIM_RANGE_UNOWNED` before observing any path or symbol. None of this
  packet's commits carried one, so the block was statically refused regardless of
  how accurate its roster was.

The head below is the final EXECUTABLE-evidence commit and carries
`Packet: pur-2a`. Each path was re-read from `git diff` against the base; each
symbol re-checked as a top-level declaration at that head.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "pur-2a",
  "base": "2908e7faff74386bfef07abe741609fa0c76be24",
  "head": "c9c44856d4f63438a4f1d9537a9e1c8df2507c57",
  "changedPaths": [
    "apps/web/release/app.authored.json",
    "packages/compiler/src/conformance.ts",
    "packages/domain/src/inventory/definition.ts",
    "packages/postgres-provider/src/inventory-posting-service.ts",
    "test/architecture/module-press-law.test.ts",
    "test/evidence/pur-2a.expected-red.json",
    "test/postgres/inventory-backup-restore.test.ts",
    "test/postgres/inventory-stock-count.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "deriveInventoryPostingCompanionId"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "INVENTORY_POSTING_FAMILIES_V1"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "resolvePostingFamilies"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "assertFamilyDeclaresRole"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "writeCompanionTransaction"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "writeCompanionLineIdentities"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "assertCompanionIdentitiesPersisted"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "companionTransactionNumber"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "companionInitialRevision"
    },
    {
      "path": "packages/postgres-provider/src/inventory-posting-service.ts",
      "name": "ResolvedPostingFamily"
    },
    {
      "path": "test/postgres/inventory-stock-count.test.ts",
      "name": "withCompanionEnvironment"
    },
    {
      "path": "test/postgres/inventory-stock-count.test.ts",
      "name": "readCompanionState"
    }
  ]
}
```
