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
field contract. A family naming anything the active release does not carry
throws at service construction rather than at posting time.

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
them outside this packet's lease. **This packet does not claim the roster is
executable authority** — that is precisely the ADR-0049 claim §7.16 marked
REFUTED, and it is not inherited here.

### The kernel is the writer of both companion identities and both revisions

- The command lost `transactionId` and per-line `transactionLineId`. A command
  that still supplies one is refused by `exactKeys`.
- `writeCompanionTransaction` inserts the companion header and lines inside the
  posting transaction, directly in `posted` state, at revision
  `sourceRevision + 1`.
- `transitionStockCountToPosted` writes the companion transaction id onto the
  source in the same compare-and-set that posts it. The guard is `IS NULL`, so
  it can only ever fill an unwritten identity.
- `writeCompanionLineIdentities` writes each derived companion line id onto its
  source line, guarded `IS NULL` for the same reason.
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

1. **An operator-visible refusal.** The kernel is the only writer of a
   companion identity, so a reviewed stock count that already names one was
   written by something else. Posting it is refused with
   `INVENTORY_COUNT_EVIDENCE_CONFLICT` rather than adopting whatever is stored.
   Proven by the test named below and held by manifest entry
   `reviewed-source-companion-must-be-null-fence-removed`, which dies alone.
2. **A reconciliation predicate anyone can recompute.**
   `deriveInventoryPostingCompanionId` is exported, pure, and takes only source
   ids, so a reconciliation reader can recompute a companion identity **without
   the posting kernel** and compare it to what is stored. The acceptance test
   uses exactly that entry point rather than reading the value out of the
   posting result, so a kernel that minted its companion some other way fails
   there. The pair
   `stock_count.revision == inventory_transaction.revision == sourceRevision + 1`
   is the second half of that predicate and is asserted directly.

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

`test/evidence/pur-2a.expected-red.json`, eight entries, run through
`evidence:expected-red` under ADR-0058: each mutation is measured before the
restored run, each declared kill must fail in its own body for its own declared
reason, and the observed kill set must equal the declared one exactly.

| §6 vacuity vector | Held by |
|---|---|
| The subject absent entirely | `source-companion-column-never-written`, `source-line-companion-column-never-written` — the identity is not written; `companion-identity-not-derived-from-the-source` — the source-dependence is gone |
| The check reading zero input | `source-line-companion-column-never-written` — the read-back's join returns zero line rows, and the length comparison reds rather than a loop passing over nothing |
| A proxy satisfied while the fact does not hold | `companion-revision-left-at-the-column-default` and `source-line-companion-column-never-written` — every write reports its row count and the persisted fact is still wrong; only the read-back catches either |
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

## The one blocked gate — a stop-and-bridge-request

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

**Stop count for this packet: 1.** `mission-cadence` allows two before
re-scope.

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

- **The input digest version was NOT bumped, and the reasoning is recorded.**
  `input_digest_version` is CHECK-constrained to `(1, 2, 3)` by migration
  `0017`, and `db/migrations/**` is outside the lease. It did not need bumping:
  a digest version names the input SHAPE, and the shape is unchanged — the same
  keys in the same order, with values the kernel now derives instead of the
  caller supplying. **The limit:** a receipt written by the pre-PUR-2a kernel
  carries caller-chosen companion ids and will not re-derive, so it replays as
  `INVENTORY_POSTING_IDEMPOTENCY_CONFLICT` rather than as a replay. That is a
  loud refusal, not a silent wrong answer, and no such receipt exists outside a
  live upgraded database.
