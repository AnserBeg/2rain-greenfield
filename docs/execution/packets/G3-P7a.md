# G3-P7a — verification derivations for unarrangeable scenarios

Status: implementation complete; candidate awaiting migrations 0017 and 0018,
the serial full-matrix slot, and Critical review
Tier: Critical
Base after doctrine refresh: `5a86e5a73d91c5dcfccb05f76135ea371872de19`
Branch: `packet/g3-p7a`

## Goal and boundary

Widen release verification from an executed-only result set to a compiler-owned
exact partition of executed results and per-scenario impact-analysis
derivations. A scenario may be executed or derived, exactly once, but never
missing and never both.

This packet owns:

- the compiler result and conformance contract;
- durable schema enablement by migration 0019;
- release admission's existing verification-reader boundary;
- PostgreSQL and architecture controls; and
- ADR-0033 and this record.

It does not edit Inventory definitions, create a generic operation for
append-only facts, widen a canonical or semantic gateway, or change the
concurrent verification service. G3-P6a owns
`release-verification-service.ts` and already emits the exact
`VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE` finding shape consumed here.
That lane maps its constructibility findings to this compiler contract after
G3-P7a integrates; it does not create another result vocabulary.

## Why derivation is not a skip

ADR-0020 permits an unexecuted scenario only with a recorded impact-analysis
derivation. The compiler still iterates every emitted scenario in the original
verification plan. For each scenario, its derivation callback returns either:

- one typed reason, which records a derivation and does not call the provider
  executor; or
- exactly `null`, which runs the real PostgreSQL executor and records an
  executed result.

No filtered plan is created, so the compiled plan digest remains unchanged and
there is no provider-local verification authority. Derivations are stored in a
separate array and cannot masquerade as ordinary result rows.

The closed execution command is unchanged. `skipVerification`, `sampleSize`,
and `timeBoxMs` remain unknown fields and each fails before the execution
counter advances.

## Result contracts and compatibility

The three-argument full-execution path remains
`northstar.verification-result-set/v1`. Its field set and SHA-256 digest domain
are unchanged, and it carries no `derivations` property.

Supplying the fourth derivation callback produces
`northstar.verification-result-set/v2` and requires at least one derivation.
Each derivation binds the original scenario ID and fingerprint and carries one
closed reason:

1. `VERIFICATION_NO_GENERIC_CREATE_OPERATION` with entity and message; or
2. `VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE` with the BUILD lane's entity,
   operation, required-storage-column, and message fields.

The result-set digest covers both arrays. A generic count is not a derivation:
every unexecuted scenario has its own bound record.

`validateExecutedVerificationPlan` independently rebuilds the executed and
derived maps and enforces their exact partition over the compiler-emitted plan:

```text
executed scenario IDs ∪ derived scenario IDs = emitted scenario IDs
executed scenario IDs ∩ derived scenario IDs = ∅
```

It also rejects duplicate, undeclared, malformed, or digest-tampered entries in
either bucket.

## Durable widening

Migration `0019_release_verification_derivations.sql` replaces only the two
existing header checks. It adds no table, column, data rewrite, grant, mutable
path, or second reader.

- v1 remains `FULL`, with `impact_analysis_derivation IS NULL`.
- v2 is `EXACT_PARTITION`, with a closed, non-empty
  `northstar.verification-impact-analysis/v1` document.
- `skipped_scenario_ids` remains exactly `[]` for both forms.
- `result_count` counts only executed PostgreSQL results; the derived count is
  the length of the durable derivation array.

The existing release repository still calls `readDurableVerificationEvidence`
once. It does not inspect JSON, count partitions, or admit through a second
path. After the concurrent service reader consumes v2, that validated evidence
can report `7 executed + 32 derived` and admission remains unchanged above the
reader boundary.

## Controls and load-bearing victims

| Control | Observed fact | Exact victim |
|---|---|---|
| Derived and executed partition is admissible | Three emitted scenarios produce one provider execution and two separately reasoned derivations; compiler conformance passes. | `packages/compiler/src/verification.ts:184` `continue;`; deletion invokes the provider for a derived scenario and the execution-ID assertion fails. |
| A scenario in neither bucket is refused | A v2 set is re-signed independently after one derivation is removed; conformance returns `VERIFICATION_SCENARIO_DISPOSITION_MISSING`. | `packages/compiler/src/verification.ts:390` missing-disposition branch. |
| A scenario in both buckets is refused | A valid executed result is inserted beside the same scenario's derivation and the set is independently re-signed; conformance returns `VERIFICATION_SCENARIO_DISPOSITION_OVERLAP`. | `packages/compiler/src/verification.ts:385` overlap-disposition branch. |
| A derivation states why | Clearing `requiredStorageColumn` in an independently re-signed derivation returns `VERIFICATION_DERIVATION_INVALID`. | `packages/compiler/src/verification.ts:506` non-empty required-storage-column check. |
| Skip flag fails closed | `skipVerification` rejects before the execution counter advances from zero. | `packages/compiler/src/verification.ts:522` allowed-key array; adding `skipVerification` makes the control fail. |
| Sampling fails closed | `sampleSize` rejects before the execution counter advances from zero. | `packages/compiler/src/verification.ts:522` allowed-key array; adding `sampleSize` makes the control fail. |
| Time box fails closed | `timeBoxMs` rejects before the execution counter advances from zero. | `packages/compiler/src/verification.ts:522` allowed-key array; adding `timeBoxMs` makes the control fail. |
| Full execution is unchanged | The same plan executed through the original three-argument API returns v1, has no derivations property, and validates. Existing v1 serialization/conformance remains green. | `packages/compiler/src/verification.ts:232` full-path `schemaVersion`; changing it to v2 fails the compatibility assertion. |
| Durable derivation exists | PostgreSQL accepts v2/EXACT_PARTITION with one versioned derivation and reads its stored count as one. | `db/migrations/0019_release_verification_derivations.sql:26` v2 exact-partition branch. |
| Durable missing derivation is refused | PostgreSQL rejects a v2 document with an empty derivation array using SQLSTATE `23514`. | `db/migrations/0019_release_verification_derivations.sql:38` non-empty derivation predicate. |
| Durable skip remains forbidden | PostgreSQL rejects otherwise-valid v2 evidence with a non-empty skipped-ID array using SQLSTATE `23514`. | `db/migrations/0019_release_verification_derivations.sql:17` empty skipped-ID predicate. |
| Durable full evidence survives | PostgreSQL accepts an unchanged v1/FULL/null-impact row. | `db/migrations/0019_release_verification_derivations.sql:20` v1 compatibility branch. |

The independently re-signed negative fixtures recompute the v2 result-set
digest outside compiler production code. Missing and overlap controls therefore
cannot pass merely because tampering left a stale digest.

Each named victim was also mutated in the working tree and restored after the
corresponding control went red:

- deleting the derivation `continue;` executed all three scenarios instead of
  one;
- deleting the missing and overlap diagnostic branches separately made each
  contradictory fixture validate as passed;
- deleting the non-empty required-storage-column check made the unreasoned
  fixture validate as passed;
- changing the legacy result-set version from v1 to v2 failed the unchanged-v1
  assertion;
- admitting `skipVerification`, `sampleSize`, and `timeBoxMs` into the closed
  command key set made each of their three rejection controls fail separately;
- deleting the SQL non-empty-derivation predicate made a live PostgreSQL insert
  with zero derivations succeed; and
- deleting the SQL empty-skipped-IDs predicate made a live PostgreSQL insert
  with a silently skipped scenario succeed.

These are recorded red outcomes, not source-text inspections. All victims were
restored and their focused controls rerun green.

## Migration fallout classification

The 0019 addition moves exact inventories and newest-migration pins. Each file
was read before editing:

- `release-persistence-boundary.test.ts`: add only the 0019 filename;
- `trust-substrate.test.ts`: advance the upgrade endpoint and applied list;
- `inventory-storage.test.ts`: advance the observed stream endpoint/count;
- `module-storage-transition.test.ts`: append the observed applied filename;
- `db/schema.snapshot.json`: replace exactly the two widened constraint rows;
  and
- `migrations.test.ts`: preserve migration 0015 as the DDL subject by locating
  it by exact name and slicing around its index, rather than repointing the test
  to 0019.

None weakens an assertion. The snapshot constraint text was captured from a
real PostgreSQL database after applying 0019, not transcribed speculatively.

The branch currently lacks migrations 0017 and 0018 because 0017 is still on
G3-P4b and 0018 is reserved for parked G3-P5. The production loader correctly
refuses this temporary `0016 -> 0019` gap. No placeholder or renumbering is
introduced. All migration inventories are discarded and re-derived from main
after those ordinals integrate.

## Current evidence

- empirical disjointness: PASS for all exclusive G3-P7a paths after rebasing to
  `main@5a86e5a`; the migration inventory is handled by its add-only shared-file
  rule;
- TypeScript typecheck: PASS;
- focused exact-partition/full-compatibility controls: 4/4 PASS;
- existing v1 compiler serialization/conformance control: PASS;
- architecture release-persistence boundary: 3/3 PASS;
- repository-hygiene inventory and suite reachability declarations: 6/6 PASS;
- direct ephemeral PostgreSQL migration probe: PASS for unchanged v1, valid v2,
  empty-derivation refusal, non-empty-skipped-ID refusal, and exact captured
  constraint definitions;
- ten independent victim mutations: each corresponding control observed RED,
  then PASS after restoration;
- `git diff --check`: PASS; and
- full matrix: not started and not permitted without a serial slot.

The standard PostgreSQL suite cannot run from this branch until migrations 0017
and 0018 exist on its integration base. This is recorded dependency sequencing,
not an assertion relaxation.
