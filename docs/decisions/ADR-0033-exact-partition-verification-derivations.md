# ADR-0033: Exact-partition verification derivations

Date: 2026-07-30
Status: proposed by packet G3-P7a; ratified when that packet is accepted
Tier: Critical (review per `review-tiers`)

## Context

The compiler emits one verification scenario for every declared conformance
obligation and `executeVerificationPlan` historically executed every emitted
scenario. Release verification persistence reinforced that assumption with a
database check requiring `execution_scope = 'FULL'`, an empty
`skipped_scenario_ids` array, and no impact-analysis derivation.

That contract is complete for ordinary editable master data, but not for
Inventory. Some searchable-exclusion scenarios target append-only facts or
period-lock entities that correctly expose no generic create operation. Others
target entity-owned transaction storage whose generic create input cannot
construct the required compiler-derived `legal_entity_id`. These scenarios are
not failed probes: their arrangements cannot be expressed by the generic
verification executor.

ADR-0020 already permits an unexecuted scenario only when a recorded
impact-analysis derivation accounts for it. It separately forbids skip flags,
sampling, and time boxes. Treating a derivation as an ordinary positive result
would falsely report execution; filtering a second provider-local plan would
fork the compiler-owned plan digest.

## Decision

Verification outcome v2 is an exact partition of the compiler-emitted plan:

```text
emitted scenario IDs = executed result IDs ⊎ derived scenario IDs
```

The union is complete and disjoint. A scenario in neither bucket is a silent
skip and fails conformance. A scenario in both buckets is contradictory and
also fails. Duplicate or undeclared entries in either bucket fail.

The compiler continues to iterate the complete emitted plan. A new optional
derivation callback is invoked for each scenario before its provider executor.
It returns either one typed reason or exactly `null`. A typed reason creates a
derivation and does not invoke the provider executor; `null` invokes the real
PostgreSQL probe and creates an executed result. No reduced plan exists and the
original verification-plan digest remains the binding authority.

Each derivation binds the original `scenarioId` and `scenarioFingerprint` and
uses `northstar.verification-derivation/v1`. Its reason is exactly one of:

- `VERIFICATION_NO_GENERIC_CREATE_OPERATION`, carrying the scenario entity and
  a non-empty explanation; or
- `VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE`, carrying the exact BUILD-lane
  finding shape: entity, operation, required storage column, and non-empty
  explanation.

The second shape intentionally matches the constructibility finding produced
by `release-verification-service.ts`; it is not a parallel vocabulary.
Derivation objects and reasons are closed. A count such as “32 unarrangeable”
cannot substitute for 32 scenario-bound records.

Full execution remains `northstar.verification-result-set/v1` with precisely
its previous fields and digest domain. Supplying no derivation callback follows
that path unchanged. An executed-and-derived partition uses
`northstar.verification-result-set/v2`, adds a separately typed `derivations`
array, and includes it in the result-set digest. V2 requires at least one
derivation; callers use v1 when every scenario executes.

## Durable representation

Migration 0018 only widens the existing immutable evidence header. It creates
no relation, column, mutable path, or second verification reader.

- v1 evidence retains `execution_scope = 'FULL'` and a null
  `impact_analysis_derivation`.
- v2 evidence uses `execution_scope = 'EXACT_PARTITION'` and stores a closed
  `northstar.verification-impact-analysis/v1` document containing the non-empty
  per-scenario derivation array.
- `skipped_scenario_ids` remains exactly `[]` for both versions. Derived
  scenarios are evidence, not skips.
- `result_count` continues to count only genuinely executed PostgreSQL results;
  the derivation count is the durable array length.

The existing verification reader reconstructs the compiler result-set
contract and runs the same conformance validator before release admission.
Admission does not query the new JSON independently and does not create a
second partition authority. It can report executed and derived counts from the
validated result set.

## Consequences

Inventory can record seven real PostgreSQL executions and 32 explicit
derivations without claiming that 39 probes ran. A later generic arrangement
capability can move a scenario from derived to executed without changing the
plan or admission rule; the next result set simply carries a different exact
partition.

The closed verification command remains unchanged. `skipVerification`,
`sampleSize`, and `timeBoxMs` are not derivation inputs and continue to fail
before any scenario runs.

Federated evidence must preserve the identical v1 full result or v2 exact
partition, including its result-set digest and derivation document. Federation
cannot derive a new partition in the target environment.

## Enforcement

- Compiler construction binds every derivation to the scenario currently being
  visited and never invokes the provider executor for that derived scenario.
- Compiler conformance rejects missing, overlapping, duplicate, undeclared, or
  malformed dispositions after independently validating the result-set digest.
- Three separate controls prove skip, sampling, and time-box command fields
  fail before the execution counter advances.
- PostgreSQL constraints preserve v1/FULL evidence, require a non-empty closed
  derivation document for v2/EXACT_PARTITION, and keep the skipped-ID array
  empty.
- The release repository continues to admit only through its existing durable
  verification-reader call.

## References

- ADR-0020, especially its enforcement rule permitting only recorded
  impact-analysis derivations for unexecuted scenarios.
- `packages/compiler/src/verification.ts`, the sole plan/result conformance
  authority.
- `db/migrations/0013_release_verification_evidence.sql`, the original
  full-execution-only durable constraint widened by migration 0018.
