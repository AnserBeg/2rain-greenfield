# 5g3-write-scope — entity-owned create scope

Status: parked at the ruled fourth stop; Critical review and full matrix pending

Tier: Critical

Lane: FIX

Packet cut: `40bf00d`

Integrated base: `5fff8b6` (includes ADR-0039's experimental-lineage
regeneration ruling).

## Outcome

The operation-catalog projection derives one required `legalEntityId` system
input for the create operation of every storage entity classified as
legal-entity-owned. The descriptor is derived from the compiled storage target,
is immutable after create, and maps to `legal_entity_id`. Update, archive, and
restore operations do not receive it. Tenant-shared entities do not receive it.

The PostgreSQL module interpreter requires the derived UUID on create, refuses
its absence with `MODULE_REQUIRED_SYSTEM_INPUT_MISSING`, cross-checks the input
descriptor against the compiled storage target, and includes the supplied value
in the insert. No ambient session value or default is consulted.

No module identifier or Inventory family name is part of the compiler/runtime
mechanism. The end-to-end control uses Inventory because it is the first mounted
consumer, while the production path keys only on compiled storage
classification.

## Controls and negative evidence

The compiler control was first run without the projection change and failed
because the entity-owned create had no derived system input. On the restored
implementation it passes and proves all of the following:

- `inventory_transaction_create` receives the exact derived create-only
  descriptor;
- its update, archive, and restore operations do not;
- tenant-shared `item_create` remains on input-contract v1 with no system input;
- an author attempting to add `systemInput` is rejected by strict canonical
  parsing, so authored and derived arguments cannot become two authorities.

The real composed verification partition moves by exactly the previously
unconstructible population:

| Partition | Before | After | Movement |
| --- | ---: | ---: | ---: |
| Executed results | 56 | 129 | +73 |
| Derived results | 112 | 39 | -73 |
| Unconstructible-create-input derivations | 73 | 0 | -73 |
| No-generic-create derivations | 39 | 39 | unchanged |

The PostgreSQL operation-path control omits `legalEntityId`, observes the exact
typed refusal, and observes no inserted row. Its positive counterpart invokes
the real Catalog/Inventory operation gateway with an explicit seeded legal
entity and independently reads the stored `legal_entity_id` from PostgreSQL.

The read-scope question did not become an implementation dependency. This
packet neither validates the input through a picker nor derives it from issued
read scope; it adds no policy authority.

## ADR-0039 artifact event — historical lineage regeneration

This packet changes the compiler function rather than an authored module
definition. Historical definitions containing entity-owned creates therefore
emit input-contract v2 under the current compiler even though their normalized
definition bytes are unchanged. ADR-0039 §§1–4 authorizes regenerating those
entries while every entry records the experimental output protocol.

`apps/web/release/app.compiled.json` was regenerated through
`apps/web/scripts/compile-app-release.ts`. The temporary refresh invocation was
removed afterward; the unchanged script's `--check` mode recompiles the whole
lineage and accepts the checked-in bytes. No release bytes were edited by hand,
and `outputProtocolVersion` remains
`northstar.compiler-output/v0-experimental` throughout.

| Application entry | Before root | After root | Disposition |
| ---: | --- | --- | --- |
| 0 | `a9c37c7784e726977cd32cd106ea441cfa5442568726bf04c60a0ec4e261e486` | unchanged | definition has no affected output |
| 1 | `ba87d2155d9d8fcc2d7c12a058ccc44094857310f6bb2cf4c095955711e7aa05` | unchanged | definition has no affected output |
| 2 | `bf932f8a4a69edc23c7a62c4191e1e9cf92c9482d38fc8bcef90945461615783` | unchanged | definition has no affected output |
| 3 | `a8f6e2c14510a687a0eaa1e244d025dedc3062114d42d14861b26417e36e9420` | unchanged | definition has no affected output |
| 4 | `6bf235d970f0ffb12c676d5925dc18aa01f1ef04ea864f2c1c04aa60712325a1` | `74cedbb619cd725a91d657c744173f60d12d59df839a9572d4ebd5ede0cd1e00` | regenerated |
| 5 | `57f2649094526e0f7cad7ddca275537b2e41089c90755529bf95914d5a379699` | `b9b28e711eb8220ec8b389369590d5f91aba1d417e4bacdd0b701d33bc4a5266` | regenerated |
| 6 | `575ee2c33421dcdded6efba646f41695168e76acc5cabd3895abeb8a8989d66f` | `33b9387509f3a5adc2a5533e7bbc6cce2a318bd1870b21481b6de11c9b32d044` | regenerated |
| 7 | `9e3f36df340bc3db500929ca90f14a93238e0027799bcf782a9da6abda27d58d` | `98079a9a533c247103fe824a1ba99bdead1496eb323375e0367aea108c7ef974` | regenerated |

The compiled artifact file SHA moves from
`82c0b073fdd573da0709c5d2900f37727aa6b22518df58e48d6fa10d0e2da6bd`
to
`3b1e813ec6d39d5e9e5345268e4adb43996463ed769061ca1bde40a8651af605`.

## Gate evidence

- Focused compiler control: observed red before implementation, PASS after.
- `corepack pnpm typecheck`: PASS before the ADR-0039 integration.
- Full required gates and exact-SHA matrix: pending.

The first full-lineage composed run exposed the separately ruled journey-length
problem: two parent tests each reached their unchanged 300,000 ms timeout. No
timeout or budget was changed. Per the orchestrator's ruling, recurrence at the
full matrix is a stop rather than a write-scope fix.

## Budget re-derivation continuation — stopped before measurement

After the activation cache integrated, the terminal-state integration control
was repaired to supply the derived `legalEntityId` to both entity-owned create
arms. Its helper still requires the exact
`MODULE_OPERATION_PRECONDITION_REFUSED` code, and the focused terminal-state
suite passed 3/3. Validation remains ahead of precondition evaluation; neither
refusal was weakened or reordered.

Both composed-parent ceilings were then raised temporarily from 300,000 ms to
600,000 ms solely to measure the ruled coverage cost. The first parent did not
complete: on an otherwise quiet exclusive run it failed after 186,364.738 ms
with `MODULE_LEGAL_ENTITY_READ_SCOPE_REQUIRED` during release verification.
The temporary ceilings were restored to 300,000 ms. The failed duration is not
a budget sample, the second parent was not run after the common prerequisite
failed, and no budget was re-derived.

The newly executable entity-owned scenarios create scoped records and then run
positive row-query probes through
`PostgresReleaseVerificationService`'s single `#invokeQuery` dispatch. That
dispatch carries no issued legal-entity scope. Repairing it is not a test-budget
change: Q1-P4 records that verification cannot choose a tenant business operand
or fabricate an all-entities scope, so making the positive probes executable
requires a ruling about how verification obtains a legitimate scope. This
continuation expressly forbids product behavior beyond the terminal-state
control repair.

This is the third write-scope stop that revealed new scope, after the ADR-0039
compiler-regeneration event and the activation-cost/O(lineage) finding. Per the
mission-cadence convergence rule, the remaining verification-scope seam must be
re-scoped rather than absorbed into another continuation of this packet.

## Arrangement-owned read-back ruling — fourth stop

The user expressly continued the packet once more because leaving the 73
constructible scenarios derived would violate ADR-0020's rule that a derivation
is never a skip. Verification now records the legal entity created for its
derived create input and supplies that exact value when it reads the arranged
record back. Current query contracts receive the declared ADR-0031 operand;
historical lineage queries that predate that operand receive an issued
`LegalEntityReadScope`. Both paths use the same `VerificationAllowPolicy` object
and converge through `SemanticQueryGateway`; there is no second policy gateway
or bypass.

The boundary guard runs before either operand insertion or scope issuance. It
refuses `VERIFICATION_LEGAL_ENTITY_SCOPE_NOT_ARRANGED` when a record names a
legal entity absent from verification's own arrangement set. Its control was
observed red (`Missing expected exception`) with the membership predicate
removed and green after restoration. ADR-0031 §5 remains a separate raw-empty-
argument dispatch: both the empty-plan row-query omission control and the
scoped-aggregate omission control pass unchanged with the exact
`selection-omitted` refusal.

The first operand-only implementation exposed historical lineage and was
corrected: the first parent reached `MODULE_LEGAL_ENTITY_READ_SCOPE_REQUIRED`
after 179,892.047 ms because older query catalogs have entity-owned storage but
no declared operand. With the dual historical/current wiring in place, that
refusal disappeared. Two subsequent otherwise-quiet, exclusive runs advanced
to verification cleanup but did not complete: one surfaced a generic operation
failure after 183,544.308 ms; a metadata-only diagnostic identified the real
cause on the repeat run after 181,149.176 ms as PostgreSQL SQLSTATE `53100`,
`No space left on device`, while recording cleanup for the compiled
`inventory_transaction` entity. The diagnostic was removed immediately.

This is the fourth stop. `withEphemeralPostgres` mounts
`/var/lib/postgresql/data` on a 256 MiB tmpfs, and the genuinely executed
verification now exhausts that bound before either composed parent can produce
an admissible duration sample. Raising a shared database-capacity bound without
a ruling would repeat the timeout mistake in a different unit. Both temporary
600,000 ms measurement ceilings were restored to 300,000 ms; no duration was
treated as a sample, no budget was re-derived, and no matrix or Critical review
was run. The packet requires the promised re-scope before changing the
ephemeral database capacity or continuing measurement.

## Post-fresh-tenant integration measurement — capacity still blocks

Current `main` at `6ecc851` was merged without rebasing. ADR-0039's compiled
artifact event remained exact: `compile-app-release.ts --check` passed, entries
0–3 held, entries 4–7 retained the recorded regenerated roots, and the compiled
artifact SHA remained
`3b1e813ec6d39d5e9e5345268e4adb43996463ed769061ca1bde40a8651af605`.

Fresh-tenant's bounded lineage replay removed the historical-verification
multiplier, but did not make the write-scope head verification fit the unchanged
database capacity. The first composed parent failed after 219,031.439102 ms
with PostgreSQL SQLSTATE `53100`, `No space left on device`, while archiving
verification probe records. The 73 newly executable scenarios are all on the
serving head and therefore remain intentionally inside ADR-0040's full semantic
verification boundary.

This is not a duration sample: the parent did not complete. No timeout or tmpfs
was changed, no budget was re-derived, the second parent was not run after the
shared prerequisite failed, and no full matrix or Critical review was started.

## 5g3-fieldorigin continuation — ADR-0042 and ADR-0043

The generic create interpreter now treats a storage relation whose column has
`origin: 'field'` as metadata about the field's existing physical column, not as
a second operation input. It neither requires `input.relations` nor emits a
second INSERT column for that relation. Verification follows the same compiled
storage facts: a required field-origin reference arranges its target and writes
that target UUID through the field, while an optional field-origin reference is
left unset. The PostgreSQL control reads the archived verification rows and
joins every required source reference to its arranged target; it separately
observes both optional transaction-line references as SQL NULL.

ADR-0042 replaces unconditional resolve registration with a lowered-storage
rule. A declared key whose physical column is not text-backed is refused, and
an entity with a text-backed physical column is refused when it omits resolve.
The focused compiler suite passed 80/80. Disabling the lowered-type arm made the
canonically-text/physically-UUID negative fixture compile; disabling the
missing-resolve arm made the text-capable entity without resolve compile. Both
controls therefore observed independent reds. Inventory now selects deliberate
resolvable fields, and `inventory_period_lock` declares no resolver because its
only field is a timestamp. Its form/list/record surfaces contain no dependency
on the removed query.

### ADR-0039/ADR-0043 artifact event — invalid suffix truncated

The pre-event compiled artifact SHA was
`3b1e813ec6d39d5e9e5345268e4adb43996463ed769061ca1bde40a8651af605`.
Entries 0–3 recompiled under the current compiler with their roots unchanged.
Entries 4–7 could not: their stored normalized inputs declare all three
now-refused resolver keys, and no source generator for those historical inputs
exists. The explicit experimental-only `--truncate-invalid-lineage` compiler
mode recompiled and byte-verified the longest valid prefix, observed the first
compiler refusal at entry 4, dropped the invalid suffix, and compiled the
generated current authored application as the single successor. A subsequent
ordinary `--check` reproduced the complete result.

| Former entry | Dropped root |
| ---: | --- |
| 4 | `74cedbb619cd725a91d657c744173f60d12d59df839a9572d4ebd5ede0cd1e00` |
| 5 | `b9b28e711eb8220ec8b389369590d5f91aba1d417e4bacdd0b701d33bc4a5266` |
| 6 | `33b9387509f3a5adc2a5533e7bbc6cce2a318bd1870b21481b6de11c9b32d044` |
| 7 | `98079a9a533c247103fe824a1ba99bdead1496eb323375e0367aea108c7ef974` |

The replacement entry 4 root is
`ee5d474d50eb5243856fd11c7a3160f915b2fe6e1f85b57f2c443f6792e7e843`.
The compiled artifact SHA after the event is
`431f15d6a7e76c37641caacdd063f263567eb4079e6785a77c4c57af2e8bcd36`.
Every retained entry still records
`northstar.compiler-output/v0-experimental`.

The shortened lineage no longer continuously proves the three separate
Inventory transitions represented by former entries 4–7. It proves one exact
58-element transition from entry 3 to the current Inventory head instead. The
rollback control's `at(-2)` target consequently moves from an incremental
Inventory release to entry 3: it now proves rollback across the consolidated
transition, not across a small incremental step. The accepted fresh-tenant
packet record remains truthful about its own eight-head artifact and accepted
SHA; it is historical evidence, not a description of this new lineage.

ADR-0042 removes exactly one `resolverAuthority` scenario with
`inventory_period_lock_resolve`: that family count moves 11 → 10 and the total
moves 168 → 167 by attribution, not by fitting. The executed/derived partition
is recorded below only after real PostgreSQL verification observes which side
lost the now-absent scenario.

### Deferred search finding — recorded, not fixed

The static lowered-storage sweep found 11 required search queries, of which
five select no column carrying `searchMapping: 'normalizedTextIndex'` and can
therefore only return an empty set in the current interpreter:

- `northstar.app:query.inventory_movement_search`
- `northstar.app:query.inventory_period_lock_search`
- `northstar.app:query.inventory_transaction_line_search`
- `northstar.app:query.party_role_search`
- `northstar.app:query.stock_count_line_search`

This is the third observed instance of a universally required query declaration
whose runtime cannot perform the claimed job. ADR-0043 records the decision as
owed; this continuation does not change search conformance or execution.

The first real PostgreSQL execution of the 167-scenario head stopped before the
partition could be observed. Part B correctly leaves the optional
`inventory_transaction_line_from_location_id` value unset, but verification
scenario
`northstar.app:verification-scenario.2e92ca7a65a0702f3a527ea3aefd714528c2cea6582f9310526ca570e266c222`
is a `searchableExclusion` probe whose executor requires that same optional
field to have a value. It therefore refused
`VERIFICATION_EXCLUDED_FIELD_VALUE_MISSING` at plan index 30. The equivalent
`to_location_id` scenario
`northstar.app:verification-scenario.54ae86867f3eb6d49f0d3ecee4dece04d8749e5d6dd19af6f6c011d0c1c6145e`
remains later at index 52 and was not reached. The plan total is exactly the
attributed 167, but no executed/derived counts were produced. Per the charter's
explicit search exclusion, neither scenario was reclassified or repaired here;
the matrix was not started.

### On-demand optional arrangement and final partition observation

The follow-on ruling preserves optional relations as unset by default while
allowing a scenario that needs a value to arrange one explicitly. Before
creating its probe record, `searchableExclusion` now identifies a nullable
field-origin relation from compiled storage metadata, creates that target, and
passes its UUID through the existing `relationOverrides` seam. Both
`from_location_id` and `to_location_id` scenarios execute this path. The
ordinary-create control still observes a transaction line with both columns
NULL, proving blanket optional arrangement was not restored.

The first exhaustive run passed every verification scenario and then exposed
two downstream controls: the deliberately stale 39-derived pin and the
full-replay schema snapshot from the old resolver shapes. With only the schema
comparison bypassed diagnostically, the rest of the 130.3-second parent ran to
completion and found no additional failure. The exact observed partition was
**129 executed / 38 derived**. The executed side stayed at 129; the derived side
lost one. The compiled plan contains exactly 167 scenarios, contains 10
`resolverAuthority` scenarios, and contains no resolver-authority scenario for
`northstar.app:entity.inventory_period_lock`. The exact union assertion then
matches all 167 plan IDs and the independent constructibility partition. This
observes deletion rather than reclassification.

The full-replay schema oracle was regenerated by the checked-in
`test/helpers/generate-fresh-tenant-full-replay-schema.ts` generator. It starts
one fresh database, serves each retained application head in order through the
real composed runtime so every intermediate head receives semantic
verification, and only then calls the repository's `captureSchemaSnapshot`.
The snapshot SHA moved from
`15d9076789e2c5243542757c80de5e1ad5108f213f3bf91e562e46aa6b113880`
to
`bf0f6bfbe1307d370ce29341be2078b73328988bd9f3a58b2ed7623bd5b6f57b`.
With the diagnostic bypass removed, the complete parent passed 5/5 in
130,486.2 ms, including the regenerated full-replay comparison, 129/38 exact
partition, required arranged-reference joins, optional-null observation, and
second-tenant materializer boundary.
