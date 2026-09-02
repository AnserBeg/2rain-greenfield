# ENUM-WIDEN — a released enum domain widens through one `widenEnumDomain` element

Adding an option to an enumeration on an already-released field was refused
with `COMPILER_STORAGE_RETYPE_UNSUPPORTED`, and `PUR-2c` measured that bypassing
that fence alone activates a release the database then contradicts. This packet
makes the transition real: a predicate that recognises only a monotonic
option-set superset, an explicit element, one atomic CHECK replacement in the
provider, catalog and live-root semantics that understand the change, and Band
A evidence from existing rows through activation on the real business table.

- **Tier:** Critical. **Evidence band:** A — the subject is a released storage
  contract and the DDL runs against live tenant tables; a wrong plan is silent
  until an operator's write fails.
- **Branch:** `packet/enum-widen`, cut from `main` at
  `8c417528db942f0a504c7744e56f816e770702c7` (verified by `git rev-parse main`
  at cut time, not taken from the charter).
- **Stops: 1 of 2 — at round 2, on the round-1 reviewer's ruling that the
  verifier's one-witness coverage is a release-gate stop condition** (§13).
  Both charter stop conditions were tested first and neither fired at round 1
  (§1); the round-1 reviewer read §1.2's disposition as a stop the lane should
  have taken, and the lane is now taking it rather than arguing it. Three lease
  crossings were taken and are disclosed in §4; their disposition is the second
  decision requested in §13.
- **ADR:** [ADR-0064](../../decisions/ADR-0064-a-released-enum-domain-widens-in-one-statement-at-prepare-time.md),
  taken because two things were ruled one-way: the element never narrows, and
  the physical constraint is the superset of every accounted live root.

## 1. The two stop conditions, measured before any design

### 1.1 Can the CHECK be replaced with no unconstrained window? — YES, and it does not fire

The live constraint is `NOT VALID` (observed by `PUR-2c` and again here).
PostgreSQL has no `ALTER CONSTRAINT` for a CHECK expression, so replacement is
`DROP` plus `ADD`. Measured as two sub-commands of ONE `ALTER TABLE` inside an
open transaction, against a table with 200,000 rows:

| what | observed |
|---|---|
| statement duration, `NOT VALID` before and after | 6 ms in the probe, 4 ms in the committed test — no row scan |
| lock held by the replacing session, from `pg_locks` | `AccessExclusiveLock`, granted, for the rest of the transaction |
| a concurrent INSERT of an OLD value | waits on `Lock/relation` (seen in `pg_stat_activity`), succeeds after `COMMIT` |
| a concurrent INSERT of the NEW value | waits the same way, succeeds after `COMMIT` — never refused |
| a third session's lock-free read of `pg_constraint` | exactly ONE constraint named `k`, the old OID, throughout |
| a third session's `pg_get_constraintdef` | BLOCKS behind the lock (it opens the relation) — the lock doing its job |
| after `COMMIT` | one constraint, NEW OID, three options, still `NOT VALID` |
| backend terminated mid-transaction | the old constraint remains with its old OID; the new value is still refused `23514` |
| behind a long-open reader, `lock_timeout = 250ms` | the statement waits, then fails `55P03`; the constraint is untouched |
| the two-statement form (`DROP` then `ADD` in one transaction) | identical to a third session: one constraint visible until `COMMIT` |

**There is no interval in which the table carries no membership constraint**,
because the catalog change is atomic at commit and every writer is queued on
the relation lock across it. The answer is therefore a REPLACED constraint,
not an added second one. The probe is committed as
`an enum-domain CHECK replacement is one statement under ACCESS EXCLUSIVE and leaves no unconstrained window`
in `test/postgres/module-storage-transition.test.ts`, and its waits are observed
from `pg_stat_activity` rather than inferred from elapsed time.

**The lock hazard is real and pre-existing.** A long-open reader ahead of the
statement queues it and every writer behind it, and the materializer sets no
`lock_timeout`. That is the same class as `addColumn`'s bounded catalog lock,
which the prepare path already takes; it is filed (§7), not changed here.

### 1.2 Why did candidate verification not catch the widened release? — a specimen error, not a gate defect; it does not fire

`PUR-2c` named three open explanations: the scenario is not planned for that
field, the entity is not constructible so the scenario never executes, or the
write is rolled back before the constraint. **None of the three is it.**

1. **The scenario is planned AND executed.** Running
   `verificationScenarioDeriver` over the head release
   (`releaseRoot 8476ba3f…`, 198 scenarios): the `enumReject` scenario for
   `northstar.app:field.inventory_transaction_type` is **EXECUTED**, not
   derived. (For contrast, `inventory_movement_posting_role` IS derived —
   `VERIFICATION_NO_GENERIC_CREATE_OPERATION`, the movement entity has no
   generic create — which is why that field could never be caught by this
   scenario at all. 47 of 198 scenarios derive on the head release.)
2. **The witness is the first DECLARED option, not the first SORTED one.**
   `#enumReject` writes `field.enumOptionIds[0]` where `field` comes from the
   OPERATION CATALOG's `inputContract.fields` (`#requiredField`), and
   `projections.ts` builds that list as
   `field.fieldType.options.map((option) => option.optionId)` — declaration
   order. The STORAGE contract's `enumOptionIds` is the one that is sorted, and
   that is the list `PUR-2c` read. Its "sorts-first" specimen appended the new
   option, so the witness stayed an old option and verification passed
   honestly.
3. **With the new option declared first, verification DOES refuse the stale
   release.** The committed test declares the new option first and runs
   candidate verification BEFORE any transition is prepared:
   `MODULE_PROVIDER_FAILURE: module provider rejected the operation
   (sqlstate=23514 relation=<the business table> constraint=<the enum-domain
   check>)`. The write reaches the real table and the real constraint refuses
   it. After the widening is prepared the same verification admits the
   candidate, and the release activates.

**Disposition, as corrected at round 2.** The round-1 record called the
remaining one-witness limit a scope row. The round-1 reviewer ruled that a
verifier which writes one witness — the first-declared option — exercises
behaviour common to both releases for every ordinary widening and does not
test the newly admitted value at all, so its coverage is insufficient as a
release gate for enum-domain changes, and that under the charter this is the
STOP-AND-REPORT case rather than a queue row. **The lane accepts that reading
and is stopped on it** (§13): candidate SELECTION is not defective and
`PUR-2c`'s specimen was wrong, but the verifier's COVERAGE is, and the fix —
writing every candidate option, or every option absent from the previous
release, in `#enumReject` — lives in `release-verification-service.ts` and
`verification.ts`, outside this lease. With this packet's element applied at
PREPARE and the composed runtime preparing before it verifies, the widened
constraint is present when the witness is written; that ordering is what keeps
the limit from sitting in front of a hole today, and it is an ordering, not a
gate.

## 2. What was built — three groups, and fewer than three was the unsafe outcome

### 2.1 Compiler and protocol semantics (`packages/compiler/src/storage.ts`, plus two one-line crossings)

- `isAdditiveEnumDomainTransition(previousColumn, candidateColumn,
  candidateField)` — the previous column carries an enum field contract whose
  option-id set is a STRICT subset of the candidate field's, and the candidate
  SOURCE field with the new option records removed fingerprints byte-for-byte
  as the previous release's stored column fingerprint (`columnShapeFingerprint`,
  factored out of `lowerColumn`). **Corrected at round 2:** round 1 compared
  the two lowered columns with the option ids and the whole fingerprint
  excluded, and the fingerprint is the only place labels and orderKeys live, so
  a widening plus a relabelled or reordered existing option passed. The exact
  test admits only new option records. It sits beside
  `isAdditiveSearchMappingTransition` as the second additive exception to the
  retype fence, and the two do not compose: a widening combined with a search
  flip is refused.
- `widensEnumDomain(previousCheck, candidateCheck)` — the same rule on the
  enum-domain CHECK: same field, same physical name, `enumDomain`, `NOT VALID`
  both sides, strict superset. **Exported and imported by the provider**, so
  the merge tolerance in §2.2 shares one authority with the planner.
- The planner's check loop compares a same-named check's DEFINITION before
  skipping it. `if (oldChecks.has(name)) continue;` was the hole: the physical
  name derives from the field id, so a widened definition matched by name and
  emitted nothing. A same-named check that changed and is NOT a widening is
  refused with `COMPILER_STORAGE_RETYPE_UNSUPPORTED` even if the column stage
  somehow passed — a second, independent fence that fails closed.
- `widenEnumDomain` in `StorageTransitionElementKind`, in
  `STORAGE_COMPATIBILITY_MATRIX` (`additive`; `oldRead:
  'requiresReadFallback'`, `oldWrite: 'compatible'`) and in
  `classifyStorageTransitionElement` (`catalogOnly` / `boundedCatalogLock` /
  `preApprovalInert` / `additive`). The renderer allowlist derives from the
  matrix and admits it for free.
- **Preserved refusals, each one property:** narrowing (an option removed),
  rebinding (one id swapped at constant count), relabelling (equal id sets),
  **widening + a relabelled existing option, widening + a reordered existing
  option** (both added at round 2), widening + search flip, widening + an
  unrelated retype. All seven are asserted in the Postgres-free compiler test.

### 2.2 Provider, live-target, catalog, verification and activation semantics (`packages/postgres-provider/src/module-storage-materializer.ts`)

- `applyDdlElement` gains a `widenEnumDomain` case calling
  `widenEnumDomainCheck`, which takes `LOCK TABLE … IN SHARE UPDATE EXCLUSIVE
  MODE` (added at round 2 so the read and the ALTER see one catalog), reads
  the LIVE definition from `pg_constraint`, extracts the text literals of the
  shape this materializer renders, and checks the extraction by ROUND TRIP
  (re-rendering must reproduce the live definition exactly, else
  `ENUM_DOMAIN_DEFINITION_UNRECOGNIZED`; the round trip proves shape, not
  authorship). Then: **absent → `ENUM_DOMAIN_CHECK_MISSING`, refused
  (corrected at round 2 — round 1 added the constraint `NOT VALID`, a
  pre-approval tightening that also repaired drift ahead of the verifier)**;
  target ⊆ live → no-op; live ⊂ target → ONE `ALTER TABLE … DROP CONSTRAINT k,
  ADD CONSTRAINT k CHECK (…) NOT VALID`; otherwise →
  `ENUM_DOMAIN_NARROWING_REJECTED`. Decided against the live definition, not the
  source root, because the managed tables are tenant-shared. Every executed
  path is now inert, which is what the `preApprovalInert` cell requires.
- **Idempotency, retry, recovery, stated as behaviours the test observes.** A
  replay finds the target within the live set and applies the element with no
  DDL (the OID does not move). A prepare that fails after the DDL rolls the DDL
  back with the transaction (the original OID returns and the new value is
  refused again), and the retry succeeds. The element's registry row is
  byte-identical on every application, so `registerElement`'s shape check
  passes on replay.
- `mergeCompatibleEntity` merges same-named enum-domain checks to the WIDER
  member when `widensEnumDomain` holds in either direction, and tolerates a
  column whose field contract differs from a sibling root's only by that
  widening (with `shapeFingerprint` excluded from the comparison, as it already
  is for the additive search-mapping pair). Everything else still raises
  `LIVE_SET_SHAPE_CONFLICT`.
- **Expected-catalog comparison, candidate verification and activation need
  no new code, and that is the finding rather than an omission.** The catalog
  verifier already compares each CHECK's DEFINITION at prepare and at the end
  of the approved attempt; with the merge taking the superset, a transition
  whose target advertises the option but whose envelope installs nothing is
  refused at prepare with `CATALOG_DRIFT: altered managed constraint …`.
  Activation's `module_schema_conformance_passed` derives from that receipt.
  Candidate verification runs after prepare in the composed runtime, so the
  witness meets the widened constraint. Each of those three is OBSERVED in the
  test rather than argued (§3).

### 2.3 Band A PostgreSQL evidence (`test/postgres/module-storage-transition.test.ts`, `test/evidence/enum-widen.expected-red.json`)

Three tests and thirteen reds (fourteen were written across two rounds; one
round-1 entry was withdrawn at round 2 as over-determined, §9). The subject is `ordinaryModuleV2`'s
`master_tier` enumeration (`standard`, `premium`) widened with `basic`,
declared FIRST so the verification witness is the new option. The mechanism is
proved on that controlled fixture; the real inventory fields are untouched
(§5).

## 3. `PUR-2c` §2.4b's nine assertions — the specification, closed

| # | Assertion | `PUR-2c` status | Now |
|---|---|---|---|
| 1 | Candidate storage target contains the new option; previous does not | MET | **MET** — both option lists asserted, under one physical constraint name |
| 2 | The exact candidate release root and storage-target root are staged | PARTIAL | **MET** — `prepared.targetReleaseId` is the staged candidate; the catalog receipt row for that generation names it |
| 3 | The preparation receipt is for that candidate and records the transition disposition | NOT MET | **MET, directly** — `prepared.receipt.state = 'PREPARED'`, `dataState = 'NOT_REQUIRED'`, the element's diff disposition `APPLIED`, and the persisted receipt `catalog_verified = true` for `target_release_id = <candidate>` |
| 4 | Activation makes that exact root active and the activation facts record the transition | PARTIAL | **MET, directly** — `activate` returns `SWAPPED_VERIFIED`; `release_activation_verification_receipts` carries `verification_version = …/v2` (the module-transition receipt) with `module_schema_conformance_passed = true`; the pointer reads the candidate. The charter wrote `module_transition = false` from `PUR-2c`'s broken chain; with the element present the honest fact is the v2 receipt, and it is asserted rather than inferred from a generation count |
| 5 | The verification witness and the sorts-first case are handled deliberately | MET, inverted | **RESOLVED** (§1.2): declaration order, not sort order; refused before the widening, admitted after — both observed |
| 6 | Before/after CHECK identified by OID/table/name and compared by definition | MET minus OID | **MET, with OID** — same table, same name, OLD OID before, NEW OID after, definitions read back with `pg_get_expr`, `NOT VALID` on both |
| 7 | The new-value failure is SQLSTATE `23514` from that exact constraint, on the real table | PARTIAL (temp replica) | **MET** — `error.code = '23514'`, `error.constraint = <the check's physical name>`, `error.table = <the business table>`, from an INSERT into `north_star_module.<table>` |
| 8 | The two write specimens differ only in the enum value | MET | **MET** — one helper, one statement, `standard` and `basic` |
| 9 | Repair-before-measure: pre-widening the CHECK must invalidate the expected rejection | **NOT MET** | **MET** — `repair-before-measure` renders every enum CHECK as a tautology; the pre-state rejection assertion dies on its own message, and it is placed BEFORE the definition read so nothing else can die first |

Beyond the nine: existing rows are written under the previous release before
anything moves; a value NO release declares is still refused after the
widening; the second tenant's replay against the already-wide constraint
applies with no DDL; the tampered transition is refused at prepare; the
failed-then-retried prepare restores the original OID; and a forged divergent
target is refused with `ENUM_DOMAIN_NARROWING_REJECTED` before any DDL.

## 4. Lease crossings, disclosed — the orchestrator's to revoke

The charter's lease omitted three paths its own precedent lists in its claim
block, and each is one line. All three were taken rather than stopped on,
under `mission-cadence`'s "foreseeable bridges" rule — the need was
predictable from `relation-requiredness-relaxation`'s record — and because a
stop with nothing delivered would have cost purchasing another round trip for
edits whose necessity is mechanical:

| path | change | why it cannot be avoided |
|---|---|---|
| `packages/compiler/src/protocol.ts` | `'widenEnumDomain'` added to `StorageTransitionElementKind` | the union is closed and `STORAGE_COMPATIBILITY_MATRIX` is `Record<StorageTransitionElementKind, …>`; TypeScript refuses a new kind anywhere else, and a cast-around would reintroduce the hand-maintained second list the precedent already corrected once |
| `packages/compiler/src/index.ts` | `widensEnumDomain` exported | the provider imports from `@north-star/compiler`, whose only export is `index.ts`; a private copy of the rule is the drift ADR-0061 records |
| `test/compiler/g2-module-storage.test.ts` | the closed-matrix pin lists the new kind; the `oldRead` emptiness loop skips it | the pin enumerates every key by hand and reds on a new one |

Every other path is inside the lease. `test/compiler/**` was not otherwise
touched: the compiler-level assertions live in the leased Postgres file as a
Postgres-free test, which is legal and cheap, and is stated here so a reviewer
does not look for them in the compiler suite.

**The inherited obligation is discharged.** `trust-substrate.test.ts`'s title
no longer encodes a migration range (`migrations upgrade accepted G1 and
converge with the checked-in snapshot`), and the relaxation manifest's two
title strings are repointed at the range-free name. `check:expected-red` stays
green either way; `evidence:expected-red`'s
`migration-does-not-admit-the-new-kind` selects by the new pattern and kills
by the new name.

**Migration `0024` was confirmed necessary, not assumed.** Migration `0022`'s
header records the failure mode and it reproduces: with the kind removed from
`0024`'s CHECK the snapshot drifts and `registerElement` would fail at PREPARE.
The seven pin sites and the snapshot (one line) moved together;
`inventory-storage.test.ts`'s count advanced 23 → 24.

## 5. The consumer boundary — division (i), kept

The mechanism is proved on a controlled fixture. `packages/domain/src/inventory/definition.ts`,
`packages/domain/src/inventory/contracts.ts`, `packages/compiler/src/conformance.ts`
and `apps/web/release/**` are untouched — `check:app-release` passes on the
unchanged artifact, which also proves the planner change alters no existing
lineage step. Resumed `PUR-2c` owns adopting the element for
`inventory_transaction_type` and `inventory_posting_role`, including the
conformance pins that fence those two fields ahead of the storage fence
(`PUR-2c` §2.2), and the consumer census. Nothing found here makes that
division unworkable.

## 6. What is NOT proven, stated narrowly

- **The provider's merge tolerance is bounded by the compiler's admission, not
  by its own test.** Option labels and orderKeys reach the provider only inside
  the column fingerprint it must exclude, so `mergeCompatibleEntity` cannot
  re-run the compiler's exact-fingerprint test (round-1 finding 1, provider
  half). The two roots it merges are compiled releases the fixed compiler
  admitted; a forged root is a forged release artifact. Stated in ADR-0064.
- **The round-trip guard is unobserved.** `ENUM_DOMAIN_DEFINITION_UNRECOGNIZED`
  fires only for a live definition this materializer did not render, which no
  committed path produces. A hand-altered constraint would be caught as
  `CATALOG_DRIFT` by any prepare or `verifyLiveCatalog` regardless; the guard
  is ordering defence so the DDL never runs on a definition it cannot parse.
- **A COHERENTLY forged target is not detected by the provider.** The tampered
  control removes the element and keeps the target; a target whose column
  contract and CHECK both advertise an option the envelope does not install
  would be refused the same way (`altered managed constraint`). A target whose
  CHECK is silently narrowed while its column contract is widened is a forged
  release artifact with a new root, outside the trust model — the compiler
  cannot emit it. Stated so the tampered control is not read as covering it.
- **The composed runtime's zero-element branch is outside this lease.** It
  routes `transition.elements.length === 0` to the no-transition path with no
  catalog check, which is exactly how `PUR-2c`'s bypass activated. The compiler
  now never emits an empty envelope for a widening, and the tampered control
  keeps one other element so preparation runs; the branch itself is filed (§7).
- **`oldRead: requiresReadFallback` is a ruling, not an observation.** No
  previous-release reader is exercised against a row carrying the new option.
- **Two successive widenings of one field share an `elementId`.** Consistent by
  construction (ADR-0064 consequences), exercised only in the single-widening
  and replay forms here.
- **Lock behaviour is measured both ways, and only one direction through the
  composed path.** The raw-statement test measures what writers see behind the
  replacement. The composed-path observation (added at round 2) holds a
  business writer's transaction open, watches the materializer's prepare wait
  on the relation lock in `pg_stat_activity`, and sees it resolve only after
  the writer commits. What is NOT observed through the composed path is a
  writer queued BEHIND the prepare for the transaction's remaining life
  (registration, catalog verification, commit) — that interval is real, it is
  the same interval `addColumn` already imposes, and its bound is the filed
  `lock_timeout` row (§7).

## 7. Findings raised — routed, not fixed

| row | tier | what |
|---|---|---|
| `enum-reject-witness-is-the-first-declared-option` | Behavioral | Candidate verification's `enumReject` scenario writes one witness, `enumOptionIds[0]` of the operation catalog (declaration order), so a widening whose new option is declared anywhere but first is invisible to it. `PUR-2c`'s specimen read the sorted storage list. With this element applied at PREPARE the limit sits behind no hole; a scenario that probes every candidate option, or at least every option absent from the previous release, would close it. Verification plan and `#enumReject` are outside this lease. |
| `zero-element-transition-skips-catalog-verification` | Critical | `composed-application-runtime.ts` routes an empty envelope to the no-transition path with no catalog check and `module_transition = false`, so a release whose storage target differs from its source but whose envelope is empty activates unverified — the exact shape of `PUR-2c`'s bypass. The compiler never emits it for any planned transition, so this is a defence-in-depth gap: assert `fromStorageTargetSemanticDigest === toStorageTargetSemanticDigest` on that branch, or run catalog verification there. |
| `vocabulary-migration-reds-are-superseded-by-restating-migrations` | Behavioral | `north_star_internal.module_storage_elements_shape` can only be restated whole, so a migration admitting a new element kind (`0022`, now `0024`) re-creates the constraint with the full list and makes every earlier migration's expected red on that list vacuous. Measured: `relation-requiredness-relaxation`'s `migration-does-not-admit-the-new-kind` survives at this packet's SHA. Owed: repoint such entries at the migration currently carrying the vocabulary whenever a restating migration lands, or derive the vocabulary CHECK from one source so no restating migration exists. |
| `materializer-prepare-sets-no-lock-timeout` | Behavioral | Every bounded-catalog-lock element in the prepare path (`addColumn`, `relaxNotNull`, now `widenEnumDomain`) queues behind a long-open reader with no bound, and every writer queues behind it. Measured: `55P03` at 250 ms under `lock_timeout`; unbounded without. A `SET LOCAL lock_timeout` for the DDL phase, with a defined retry, is one edit in one file. |

`migration-range-encoded-in-a-test-title` is CLOSED by this packet (§4).

## 8. Gates and SHAs

**A record cannot name its own commit.** The **executable candidate is
`8c2d5912b792c38d730fe14173f828bc204ce131`** — the last commit that moved
production, a test, a migration, the snapshot or a manifest. Every commit above
it is narrative, and the freeze is the branch tip, reported in the checkpoint
block with its `git ls-remote` line.

Four executable commits, in order: `94cd77f` (compiler, provider, migration,
snapshot, pins, the relaxation manifest's two strings, the closed-matrix pin),
`d4cc34d` (the manifest), `a4bcf21` (the count-first assertion and the
committed window probe), `8c2d591` (the tautology PostgreSQL round-trips).

**Measured at `8c2d591` unless a row says otherwise:**

| gate | result |
|---|---|
| `typecheck` | PASS |
| `lint` | PASS |
| `format` | PASS |
| `build` | PASS |
| `check:app-release` | PASS — the compiled application is byte-unchanged, so the planner change alters no existing lineage step |
| `test:unit` | 155/155 |
| `test:compiler` | 157/157 (the closed-matrix pin lists the new kind) |
| `check:expected-red` (static) | OK, 75 entries in 7 manifests |
| `check:expected-red-controls` | OK, 38 controls |
| `evidence:expected-red` | **13/13 of this packet's entries reproduced and restored.** Twelve at `a4bcf21` and the thirteenth (`repair-before-measure`) at `8c2d591`, whose only delta from `a4bcf21` is that entry's replacement text; the full thirteen are re-run inside the freeze pass below |
| the three enum-widen tests, focused | 3/3 (`node --import tsx --test --test-name-pattern="enum domain|enum-domain" test/postgres/module-storage-transition.test.ts`) |
| `test:postgres` | **226/226** (inside the matrix at `984c65d`, the first narrative commit; executable tree identical to `8c2d591` — `git diff --name-only 8c2d591 984c65d -- . ':!docs'` is empty) |
| `test:architecture` | **189/189** inside the matrix at `984c65d`, and re-run at the freeze tip because this suite reads `docs/**` — see the checkpoint block |
| `scripts/check-records.sh` | PASS — `records: OK (137 record(s), 6 declaring …; 158 ledger row(s), ids unique)`, with this record's block resolved against `8c41752..8c2d591` |
| full matrix (`scripts/run-matrix.sh`) | **PASS, `FULL_MATRIX_PASS_SHA=984c65d6a7780f13d1bb93b252735ebe116f8ab9`** — `scripts/run-matrix.sh enum-widen`: performance 5/5 (`PERFORMANCE_GATE_PASS_SHA` the same), `check:demo-release`, `check:app-release`, unit 155/155, compiler 157/157, integration 149/149, agent 3/3, architecture 189/189, contracts 29/29, postgres 226/226, locale 1/1, browser 93/93, observability producer, language coverage PASS (2050 obligations), reachability PASS (106/106 test files executed), dependency audit clean, secret scan clean (the one reported "leak" is the scan's own planted negative-control fixture, `negativeRuleDetected: true`). Log: `/tmp/matrix-enum-widen-984c65d6.log` |

**Round 2, measured at `00f9c5bcd4dc7842a7b4b471caf2bb67a008029b` (the round-2 executable candidate; the
round-1 matrix above is VOID for it, per `AGENTS.md` §4):**

| gate | round 2 |
|---|---|
| `typecheck` / `lint` / `format` / `build` | PASS |
| `test:unit` | 155/155 |
| `test:compiler` | 157/157 (seven preserved refusals, two new) |
| `check:app-release` | PASS — artifact unchanged |
| `check:expected-red` (static) | OK, 75 entries in 7 manifests |
| `evidence:expected-red`, this packet | **13/13 reproduced and restored** at `00f9c5b` (`widening-admits-any-option-change` withdrawn as over-determined, §9) |
| `evidence:expected-red`, `relation-requiredness-relaxation`'s `migration-does-not-admit-the-new-kind` | **SURVIVOR at `00f9c5b`** — migration `0024` restates the whole element vocabulary, `relaxNotNull` included, so removing `relaxNotNull` from `0022` no longer changes the final schema. An accepted packet's red made vacuous by a later migration; decision 3 in §13 |
| the three enum-widen tests, focused | 3/3, including the composed-path lock observation and the absent-CHECK refusal |
| `test:postgres` | <<POSTGRES2>> |
| `test:architecture` / `check-records` | <<ARCH2>> |
| full matrix | NOT re-run at round 2 — the packet is STOPPED on three decisions (§13); the matrix runs once at the SHA that will integrate, per `git-workflow` |

`test:postgres` is REQUIRED here under `AGENTS.md` §6's cross-layer rule — the
transition envelope gained an element kind — and two of its tests observe the
new DDL rather than merely tolerating it.

**This is the freeze-candidate gate set AND the full matrix**, because Docker
is up and the charter said there is no excuse for owed Postgres evidence. Per
`git-workflow`, the matrix that counts for acceptance is the one at the
INTEGRATED SHA; if a review changes executable content this one is void and is
re-run.

## 9. The thirteen reds, and what each kills

| entry | one property varied | kills |
|---|---|---|
| `widening-is-never-recognised` | the column predicate call replaced by `true` | the compiler test — the widening refuses `COMPILER_STORAGE_RETYPE_UNSUPPORTED` |
| `widening-ignores-everything-but-the-id-set` | the exact-fingerprint comparison returns `true` (round 2; replaces round 1's `widening-admits-unrelated-column-changes`) | the compiler test — `widenedAndRelabelled` compiles |
| `checks-are-matched-by-name-only` | the definition comparison always matches (the `PUR-2c` hole restored) | the compiler test — zero elements planned |
| `old-readers-are-told-widening-is-transparent` | the cell's `oldRead` flattened to `compatible` | the compiler test — the planned element's cell |
| `migration-0024-does-not-admit-widen-enum-domain` | the kind removed from `0024`'s CHECK | `trust-substrate` — schema drift against the snapshot, on a live database |
| `provider-never-executes-the-enum-widening` | the `ALTER TABLE` deleted from `widenEnumDomainCheck` | the Postgres test — `CATALOG_DRIFT: altered managed constraint` at the real prepare |
| `replay-reissues-the-ddl` | the target-within-live early return removed | the Postgres test — the second tenant's replay moves the OID |
| `element-narrows-a-divergent-live-constraint` | `ENUM_DOMAIN_NARROWING_REJECTED` removed | the Postgres test — the forged target replaces the constraint and the mixed-root merge then conflicts, a different refusal than the declared one |
| `merge-refuses-a-mixed-live-root-set-of-enum-checks` | the check-merge tolerance removed | the Postgres test — `LIVE_SET_SHAPE_CONFLICT` at the tampered tenant's prepare |
| `catalog-expects-the-narrower-check` | the merge keeps the narrower member | the Postgres test — the tampered transition verifies CLEAN (`Missing expected rejection`), which is `PUR-2c`'s activation reconstructed |
| `column-merge-refuses-the-widened-contract` | the column tolerance removed | the Postgres test — `LIVE_SET_SHAPE_CONFLICT` on the column |
| `repair-before-measure` | every enum CHECK rendered as a tautology | the Postgres test — `the previous release CHECK must reject the option it does not declare` |
| `missing-check-is-repaired-not-refused` | the `ENUM_DOMAIN_CHECK_MISSING` refusal replaced by round 1's `NOT VALID` add (round 2) | the Postgres test — the drifted tenant's prepare succeeds (`Missing expected rejection`) |

**One round-1 entry is WITHDRAWN at round 2, and the claim it carried is
over-determined rather than unproved.** `widening-admits-any-option-change`
made the strict-superset core return `true` and expected `narrowed` to
compile. After the exact-fingerprint correction a narrowing or rebinding is
refused by that comparison BEFORE the superset core is consulted, and a true
widening reaches the check-side rule only after the column stage admitted it,
so the mutation changes no observable outcome: it became a SURVIVOR. The core
still guards `widensEnumDomain`, the rule the provider merge shares, and its
merge role is what `catalog-expects-the-narrower-check` kills. Narrowing
therefore has no single-property killer — two independent fences refuse it —
which is the same shape `relation-requiredness-relaxation` recorded for
one-wayness, and it is stated here rather than kept as a red that proves
nothing.

Three claims share one kill message (`conflicting live roots claim`) because
three different mutations reach the same refusal from three places; each is a
distinct mutation of a distinct line and each is reproduced separately.

## 13. Round 2 — the BLOCK verdict, what each finding changed, and the stop

Round 1 returned **BLOCK** with two executable defects, one release-evidence
ruling and one process finding. Both defects were real. Each disposition:

| # | Finding | Disposition |
|---|---|---|
| P1 | **Widening + relabel/reorder of an EXISTING option passed both fences and the merge.** The round-1 predicate excluded the whole column fingerprint, the only place labels and orderKeys live. | **FIXED, exactly rather than by exclusion.** `isAdditiveEnumDomainTransition` now takes the candidate's SOURCE field, drops the option records the previous release did not carry, fingerprints what remains exactly as `lowerColumn` would (`columnShapeFingerprint`, factored out), and requires byte equality with the previous release's stored fingerprint. `widenedAndRelabelled` and `widenedAndReordered` are refused and asserted; the red `widening-ignores-everything-but-the-id-set` makes the comparison vacuous and dies on `widenedAndRelabelled`. The round-1 red `widening-admits-any-option-change` is withdrawn as over-determined by this fix (§9). **The provider half is a stated limit, not a fix:** labels and orderKeys reach the provider only inside the fingerprint it must exclude, so the merge cannot re-run the compiler's test; it is bounded by what the fixed compiler admitted (§6, ADR-0064). The lane says so as a claim and lets the reviewer disagree. |
| P1 | **The missing-live-CHECK branch was a pre-approval tightening, not an inert widening**, and it repaired drift ahead of the verifier. | **FIXED, fail closed.** `widenEnumDomainCheck` refuses with `ENUM_DOMAIN_CHECK_MISSING`; the Postgres test drops the constraint by hand, sees the refusal, sees the constraint still absent, and sees `verifyLiveCatalog` report `missing managed constraint`. The red `missing-check-is-repaired-not-refused` restores round 1's add and dies on the drifted tenant's prepare succeeding. Every executed path is now no-op or subset-to-superset, so the `preApprovalInert` cell holds for all of them. |
| P1 (release evidence) | **The verifier's one-witness coverage is a release-gate defect and the charter said STOP.** | **ACCEPTED, and the lane is STOPPED on it — stop 1 of 2.** §1.2 is corrected: candidate selection is sound and `PUR-2c`'s specimen was wrong, but one witness does not test the newly admitted value for an ordinary widening. The fix is outside this lease (`#enumReject` in `release-verification-service.ts`, the plan shapes in `verification.ts`). **Decision requested** — see below. |
| P2 (process) | **The three crossings were disclosed, minimal, and not authorized.** | **ACCEPTED as stated.** The lane should have issued one batched bridge request before the first crossing. **Retrospective disposition requested** — see below. Nothing in the crossings changed at round 2. |
| — | The round trip proves shape, not authorship; no relation lock covered read-then-ALTER. | **BOTH CORRECTED.** The comment now says shape; `widenEnumDomainCheck` takes `LOCK TABLE … IN SHARE UPDATE EXCLUSIVE MODE` before reading, so no concurrent DDL can change the definition between the read and the ALTER (the replacing ALTER escalates to ACCESS EXCLUSIVE). |
| — | Raw-statement lock timing is not Band A evidence for the composed prepare. | **CORRECTED by measurement, in the direction the test can make deterministic.** The Postgres test now holds a business writer's transaction open, starts the real prepare, observes the materializer waiting on the relation lock in `pg_stat_activity`, asserts the prepare unresolved and the OID unmoved, commits the writer, and sees the prepare resolve and the widening land. The other direction — a writer queued behind the prepare's remaining transaction — is stated as unobserved through the composed path (§6). |
| — | The prompt steered: it pre-asserted "verification was never the gap", pre-defended a non-local kill, characterised the crossings before asking, and grouped the repair path with the widening. | **ACCEPTED.** The round-2 prompt below states each of those as a question or a claim under test, and §1.2 no longer says the sentence. |

**Two decisions only the orchestrator can make, and the lane is stopped on
both:**

1. **The verifier's coverage.** Options the lane can see: (a) grant a bridge
   into `packages/postgres-provider/src/release-verification-service.ts`
   (`#enumReject`) and, if the result shape changes, `packages/compiler/src/verification.ts`,
   so the positive probe writes EVERY candidate option rather than
   `enumOptionIds[0]` — closes the gate inside this packet, at the cost of a
   verification-evidence shape change on a DEPLOY-lane path; (b) route it as
   its own packet (`enum-reject-witness-is-the-first-declared-option`, already
   filed) and narrow this packet's claim to what it measures — the element is
   applied at PREPARE, before verification runs, so the widened constraint is
   present when the witness is written; (c) something the lane has not seen.
   **The lane recommends (b)** because the verification plan is a persisted,
   digested artifact whose shape change deserves its own evidence, and because
   this packet's element does not depend on the verifier to be safe — but it
   is the orchestrator's ruling, and the reviewer's point that a Critical lane
   should not carry an insufficient release gate as a footnote stands either
   way.
2. **The three crossings** (`protocol.ts` union literal, `index.ts` export,
   the closed-matrix pin in `g2-module-storage.test.ts`): grant retrospectively,
   or revoke and instruct. Revoking the union literal is revoking the element.
3. **An accepted packet's red is now vacuous, and the fix is a crossing.**
   Measured at round 2 by running the repointed
   `relation-requiredness-relaxation` entry alongside this packet's: its
   `migration-does-not-admit-the-new-kind` removes `'relaxNotNull'` from
   migration `0022` and expects snapshot drift — but migration `0024` drops
   and re-creates `module_storage_elements_shape` with the FULL vocabulary,
   `relaxNotNull` included, so the final schema is identical and the mutation
   is a **SURVIVOR**. This is structural: the vocabulary CHECK can only be
   restated whole, so every restating migration supersedes every earlier
   migration's red on it. The honest fix is to repoint that entry's `file` to
   `0024_module_storage_enum_domain_widening.sql` (where the vocabulary now
   lives) — a one-property edit, but to an accepted packet's manifest beyond
   the two title strings this charter granted, so the lane has NOT made it.
   Options: (a) grant that crossing; (b) route it (`vocabulary-migration-reds-are-superseded-by-restating-migrations`,
   filed in `current-plan.md`) and accept that `evidence:expected-red` over
   the whole population is red at this packet's SHA until it lands.

**Round-2 gates** are in §8. **Stops: 1.**

## 10. Test it yourself

Under ten minutes, no diff reading. From the repository root on
`packet/enum-widen` with Docker up:

**A. The refusal `PUR-2c` stopped on is gone for a widening, and only for a
widening (~1 min, no database).**

```bash
node --import tsx --test --test-name-pattern="plans exactly one widenEnumDomain element" test/postgres/module-storage-transition.test.ts 2>&1 | grep -E "^(ok|not ok)|# (pass|fail)"
```

Expect `ok 1 …` and `# pass 1`. That test compiles the widening and asserts
one `widenEnumDomain` element, then compiles narrowing, rebinding,
relabelling, widening-plus-search and widening-plus-retype and asserts each is
still refused with `COMPILER_STORAGE_RETYPE_UNSUPPORTED`.

**B. The whole chain against live PostgreSQL, including the rejection before
and both values after (~2 min).**

```bash
node --import tsx --test --test-name-pattern="released enum domain is widened" test/postgres/module-storage-transition.test.ts 2>&1 | grep -E "^(ok|not ok)|# (pass|fail)|enum-widen:"
```

Expect `ok 1 …`, `# pass 1`, and one line beginning
`# enum-widen: verification against the stale CHECK refused with
MODULE_PROVIDER_FAILURE … sqlstate=23514` — that is `PUR-2c`'s residual,
observed.

**C. The window measurement (~1 min).**

```bash
node --import tsx --test --test-name-pattern="leaves no unconstrained window" test/postgres/module-storage-transition.test.ts 2>&1 | grep -E "^(ok|not ok)|enum-widen:"
```

Expect `ok 1 …` and `# enum-widen: CHECK replacement over 200000 rows took
N ms under AccessExclusiveLock` with N in single-digit milliseconds.

**D. The required repair-before-measure control, red on demand (~2 min).**

```bash
corepack pnpm evidence:expected-red repair-before-measure 2>&1 | grep -E "MUTATION_RED|SURVIVOR|FAIL|OK"
```

Expect `MUTATION_RED repair-before-measure 1 killed`. Pre-widening every enum
CHECK into a tautology makes the pre-state rejection fail — nothing else in the
chain notices, which is why that assertion exists.

**E. Read, rather than run:** §1.2 above — the residual `PUR-2c` left open and
why it was a specimen error — and ADR-0064's four dispositions against the
live definition. If you disagree with anything one-way in this packet, it is
"the element never narrows".

## 11. Online review prompt — paste this

> *This prompt was written by the lane whose work you are reviewing. **The lane
> has fenced nothing.** Any scope stated here is the orchestrator's, and it
> stands as a claim under test rather than a limit you may not question. Read
> whatever you judge relevant to the decisive questions, say plainly if you think
> the scope is drawn wrongly, and say plainly if the prompt itself is steering
> you.*

**ROUND 2.** Round 1 returned BLOCK; §13 tracks every finding to its disposition. Two are fixed in production, one is a STOP awaiting the orchestrator's decision, one is a process disposition awaiting the same. Rounds are fresh: nothing here is adjudicated, and the round-1 verdict carries no weight beyond the history in §13.

**Repository:** `github.com/AnserBeg/2rain-greenfield`. **Branch:**
`packet/enum-widen`, cut from `main` at
`8c417528db942f0a504c7744e56f816e770702c7`. **Executable candidate:**
`8c2d5912b792c38d730fe14173f828bc204ce131`. **Delta to read:**
`8c417528..packet/enum-widen`. The branch head carries narrative commits above
the executable candidate — this record, ADR-0064, and the ledger/lane/plan
rows; `git diff --name-only 8c2d591..packet/enum-widen -- . ':!docs'` is empty.
Review the head.

**Frozen SHA: `f07f9e7d0ea91f057ba32a71212551b0af7a32e5`**, the tip that carries the
matrix result. Quoted from the remote at freeze time:

```
$ git ls-remote origin refs/heads/packet/enum-widen
f07f9e7d0ea91f057ba32a71212551b0af7a32e5	refs/heads/packet/enum-widen
```

The branch head is one commit above that SHA, and its only content is this
block. `git diff f07f9e7..packet/enum-widen` shows it and nothing else.

**Tier: Critical**, because the diff plans and executes DDL against live
tenant tables and changes what the compiler admits for a released storage
contract; a wrong plan is silent until an operator's write fails. **Evidence
band: A.**

### Gates already green

`typecheck`, `lint`, `format`, `build`, `test:unit` 155/155, `test:compiler`
157/157, `check:app-release` (artifact unchanged), `check:expected-red`,
`check:expected-red-controls` (38), `evidence:expected-red` 13/13 for this
packet, and the rows in §8 for `test:postgres`, `test:architecture`,
`check-records` and the full matrix. Do not re-derive what those prove; read
§8 for exactly where each was measured.

### The lane's claims, written as claims to be tested

1. **Only new option records are admitted; every other change to the field is
   refused.** `isAdditiveEnumDomainTransition` fingerprints the candidate
   source field without its new options and requires equality with the
   previous release's stored fingerprint. Narrowing, rebinding, relabelling,
   widening-plus-relabel, widening-plus-reorder, widening-plus-search and
   widening-plus-retype keep `COMPILER_STORAGE_RETYPE_UNSUPPORTED`.
2. **A same-named CHECK is compared by definition before it is skipped**, and a
   changed non-widening definition is refused even if the column stage passed.
3. **The replacement is one statement with no unconstrained window**, decided
   against the LIVE definition read under `SHARE UPDATE EXCLUSIVE` (absent →
   `ENUM_DOMAIN_CHECK_MISSING`; target ⊆ live → no-op; live ⊂ target →
   replace; else `ENUM_DOMAIN_NARROWING_REJECTED`), with the live option set
   read back by round trip (`widenEnumDomainCheck`). Every executed path is a
   no-op or a subset-to-superset replacement.
4. **Two accounted live roots may differ on an enum-domain CHECK and its
   column contract only by a widening, and the expected shape is the superset**
   (`mergeCompatibleEntity`).
5. **Candidate SELECTION is sound and `PUR-2c`'s specimen was wrong; the
   verifier's one-witness COVERAGE is not sufficient for an ordinary widening,
   and the lane is stopped on that** (§13, decision 1). The witness is the
   operation catalog's first DECLARED option; declared first, the new option
   trips `MODULE_PROVIDER_FAILURE (sqlstate=23514 …)` before the widening and is
   admitted after it.
6. **The nine `PUR-2c` §2.4b assertions are all met directly** (§3), including
   SQLSTATE `23514` from the exact constraint on the real business table, the
   receipt and activation facts read from their rows, and the
   repair-before-measure control.
7. **The provider's merge tolerance cannot re-run the compiler's exact test and
   is bounded by it** (§6). This is stated as a limit; the lane does not know a
   way for the provider to see option labels.

### The decisive questions

1. **Is the predicate exactly the monotonic superset and nothing wider?** Read
   `isAdditiveEnumDomainTransition` and `widensEnumDomain` against the five
   preserved refusals in the compiler test. Is there an option-list change that
   is not a strict superset and still passes — or a column change other than
   the option list that the comparable-shape exclusion hides?
2. **Is deciding the DDL against the LIVE definition right, and is the round
   trip a sufficient guard?** `widenEnumDomainCheck` parses `pg_get_expr` by
   regex and accepts the parse only if re-rendering reproduces it. Can a
   definition this materializer rendered fail the round trip (a value with a
   quote, a `::text` inside a value), or can one it did NOT render pass it?
3. **Does the merge tolerance admit anything beyond a widening?** Read the
   check merge and the column merge (`enumDomainShadow`,
   `withoutContractAndFingerprint`). The column merge now excludes
   `shapeFingerprint` for the widened pair, as it already did for the search
   pair. Does excluding it let a non-widening column difference through when
   the option list ALSO widened?
4. **Are the thirteen reds discriminating?** Three entries share the kill
   message `conflicting live roots claim`. `element-narrows-a-divergent-live-constraint`
   is killed by a later refusal than the guard it removes; the green test's
   exact-code assertion is the direct-path evidence. Is the new
   `widening-ignores-everything-but-the-id-set` mutation the right
   one-property control for the exactness claim, and is the withdrawal of
   `widening-admits-any-option-change` as over-determined (§9) honest?
5. **Is the corrected §1.2 and the stop in §13 right?** The lane now says the
   specimen was wrong, selection is sound, coverage is insufficient, and the
   fix is out of lease; it recommends routing (option b) and is stopped for the
   ruling. Say whether the packet's own safety depends on that ruling.
6. **Is the provider's merge tolerance acceptable as a bounded claim** (claim
   7), given the provider cannot see option metadata, or does it need a
   different shape?
7. **With the absent-CHECK path now refusing, is `preApprovalInert` right for
   every path the element executes**, and is `oldRead: requiresReadFallback`
   the right cell?

### What the lane did NOT verify

- The round-trip guard (`ENUM_DOMAIN_DEFINITION_UNRECOGNIZED`) never fires in
  any committed path; it is unobserved (§6).
- A coherently forged target — column contract and CHECK both altered — is not
  distinguished from a compiled one by the provider; the compiler cannot emit
  it and it is outside the trust model (§6).
- The composed runtime's zero-element branch, which activated `PUR-2c`'s
  bypass with no catalog check, is untouched and filed (§7).
- No previous-release READER is exercised against a row carrying the new
  option; `oldRead` is a ruling.
- Two successive widenings of one field share an `elementId`; only the single
  widening and the replay are exercised.
- Lock behaviour is measured on a raw table with the exact statement shape,
  not through the materializer's longer prepare transaction.
- Real inventory fields are untouched by design (division (i)); nothing here
  proves the conformance pins on `inventory_transaction_type` and
  `inventory_posting_role` will move cleanly for resumed `PUR-2c`.
- The provider merge admits a widened pair on storage-visible shape alone; a
  root that also relabelled an existing option cannot be compiled, and the lane
  has no provider-side observation of that (§6).
- A writer queued BEHIND the composed prepare, for the transaction's remaining
  life, is not observed through the composed path — only ahead of it (§6).

### Reading list

`AGENTS.md` §6 · `review-tiers`, "Evidence depth follows FAILURE
OBSERVABILITY" · `mission-cadence`, "The lane writes its own review prompt" ·
`docs/execution/packets/pur-2c.md` §2.3–§2.6 and §8b · this record §1–§7 ·
ADR-0064 · ADR-0061 for the precedent element and its merge tolerance ·
`test/postgres/module-storage-transition.test.ts`, the three tests whose titles
contain `enum domain` / `enum-domain` · `test/evidence/enum-widen.expected-red.json` · the round-1 verdict as history, in §13.

The lane states no view on what verdict this round should reach.

## 12. Proposed next packets

| ID | Outcome | Tier | Why |
|---|---|---|---|
| `PUR-2c` (resume) | The goods receipt and its posting, on this element: widen `inventory_transaction_type` and `inventory_posting_role`, move the conformance pins, run the consumer census, then the receipt | Critical | Unblocked by this packet. Its re-charter should carry `PUR-2c` §1's two corrections, the `received_quantity` decision as its own step with ADR-0065 (ADR-0064 is now taken), and §5's division (i) |
| `zero-element-transition-skips-catalog-verification` | Assert source/target storage digests agree on the no-transition branch | Critical, small | Closes the runtime half of the `PUR-2c` hole as defence in depth |
| `enum-reject-witness-is-the-first-declared-option` | Probe every option absent from the previous release, not one witness | Behavioral | Makes candidate verification able to catch a stale CHECK on its own |

## The declared range

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "enum-widen",
  "base": "8c417528db942f0a504c7744e56f816e770702c7",
  "head": "00f9c5bcd4dc7842a7b4b471caf2bb67a008029b",
  "changedPaths": [
    "db/migrations/0024_module_storage_enum_domain_widening.sql",
    "db/schema.snapshot.json",
    "packages/compiler/src/index.ts",
    "packages/compiler/src/protocol.ts",
    "packages/compiler/src/storage.ts",
    "packages/postgres-provider/src/module-storage-materializer.ts",
    "test/architecture/release-persistence-boundary.test.ts",
    "test/compiler/g2-module-storage.test.ts",
    "test/evidence/enum-widen.expected-red.json",
    "test/evidence/relation-requiredness-relaxation.expected-red.json",
    "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/trust-substrate.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/compiler/src/protocol.ts",
      "name": "StorageTransitionElementKind"
    },
    {
      "path": "packages/compiler/src/storage.ts",
      "name": "isAdditiveEnumDomainTransition"
    },
    {
      "path": "packages/compiler/src/storage.ts",
      "name": "columnShapeFingerprint"
    },
    {
      "path": "packages/compiler/src/storage.ts",
      "name": "widensEnumDomain"
    },
    {
      "path": "packages/compiler/src/storage.ts",
      "name": "STORAGE_COMPATIBILITY_MATRIX"
    },
    {
      "path": "packages/compiler/src/storage.ts",
      "name": "classifyStorageTransitionElement"
    },
    {
      "path": "packages/compiler/src/storage.ts",
      "name": "buildStorageTransitionEnvelope"
    },
    {
      "path": "packages/postgres-provider/src/module-storage-materializer.ts",
      "name": "widenEnumDomainCheck"
    },
    {
      "path": "packages/postgres-provider/src/module-storage-materializer.ts",
      "name": "applyDdlElement"
    },
    {
      "path": "packages/postgres-provider/src/module-storage-materializer.ts",
      "name": "mergeCompatibleEntity"
    }
  ]
}
```
