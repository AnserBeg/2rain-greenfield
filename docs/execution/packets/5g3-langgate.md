# 5g3-langgate — derived language conformance instrument

Status: evidence ready; exhaustive relation corpus split into its own packet

Tier: Critical

Base: `5bdf511d652009b962cf0ad0983ab993ea0e96c3`

## Checkpoint outcome

The acceptance instrument now derives an exact obligation ledger from two
independent specifications:

1. `VersionedAuthoredApplicationPackage` in
   `packages/canonical-model/src/schemas.ts`, which describes what an author
   can submit; and
2. `StorageTargetPayloadV1` in `packages/compiler/src/storage.ts`, including
   reachable imported output types and the physical field-type table, which
   describes what downstream consumers can receive after lowering.

The derived ledger contains 394 exact-path axes and 1,894 value obligations:
300 authored-language axes and 94 lowered-storage axes. The lowered set
includes the compiler-synthesized relation marker
`$.relations[].relationColumn.origin.$presence = absent | present`, its
`origin = field` value, relation nullability, ownership, archive behavior,
fixed UUID physical type, column nullability, field-contract choices, index
kinds, and the complete compiler-owned PostgreSQL field-type table. The
phase-1 graph classification adds ten schema-induced topology obligations and
the `1 / 2 / 80` lineage work corridor.

The five first-party definitions (the composed Party/Catalog/Location/
Inventory application plus Platform) currently exercise 376 obligations. The
other 1,518 obligations are not called covered. Three written decisions name
the exact current partitions in
`test/fixtures/g2/language-conformance/coverage-decisions.json`:

- observed relation values remain execution debt pending the sibling corpus;
- observed non-relation values remain execution debt pending later axis
  packets; and
- unused values are exempt only while unused.

Each decision binds both the full ledger digest and the digest of the exact
obligation set it covers. The decision document also carries an exact compact
bitset of the observed/unobserved partition that produced those set digests.
Adding an axis or value invalidates the ledger digest. Using a previously
unused existing value no longer matches that snapshot, so the old decision
cannot stretch to cover it. A wildcard label therefore cannot inherit
coverage.

## Gate and claims mechanism

`check:language-coverage` is wired into the root test path, the repository
matrix, and hosted CI. A receipt claim alone does not discharge an obligation.
The gate requires a current-run receipt whose integrity digest is valid, whose
producer test file has successful executed-file credit, whose obligation
exists in the freshly derived ledger, and whose outcome matches the claim's
declared `executed` or `typedRefusal` kind. The only alternative is one of the
exact, digest-bound written decisions above.

The five mandatory negative controls are observed in
`test/unit/language-conformance-ledger.test.ts`:

- `phantom-axis` refuses `LANGUAGE_COVERAGE_PHANTOM_OBLIGATION`;
- `evidence-tamper` refuses `LANGUAGE_COVERAGE_RECEIPT_TAMPERED`;
- `entry-skip` refuses `LANGUAGE_COVERAGE_UNCLAIMED_ENTRY` and names the entry;
- `refusal-distinguisher` refuses
  `LANGUAGE_COVERAGE_OUTCOME_MISMATCH` when a typed refusal is offered for an
  execution claim; and
- `first-use-transition` starts with the real first-party obligation
  `authoredLanguage:$.fields[].classification="public"` in the unobserved
  partition, changes the composed first-party package to use that value,
  normalizes and lowers the changed package, and observes
  `LANGUAGE_COVERAGE_OBSERVATION_CHANGED` naming that exact obligation. The
  control then moves the snapshot while retaining the old decisions and
  observes `LANGUAGE_COVERAGE_STALE_DECISION_SET`; the gate returns green only
  after a new exact decision is recorded.

A separate mechanism control proves that either a valid execution receipt or
a stable typed-refusal receipt can instead take over a moved obligation while
the old decision remains unchanged. Another proves a written decision cannot
survive a ledger digest change.

## Why the corpus is split here

The addendum's second derivation source materially changed the foundation: it
added 94 axes and 176 lowered-output obligations that a schema-only ledger
could never see. The combined exact partition is 1,894 obligations, of which
94 are relation-specific (82 authored/topology and 12 lowered). Building the
required sibling corpus is a separate PostgreSQL fixture and execution
corridor: it must pack the supported finite relation combinations, every graph
topology, typed authoring refusals, the lineage work corridor, and independent
stored-fact witnesses. That is materially larger than adding a few claims to
the gate and would cross the charter's explicit split condition. No existing
fixture was extended and no behavior was baselined.

The receipt-claims file therefore remains empty. All 1,894 entries are
explicit decisions at this checkpoint, not execution coverage. This is a real
gate over obligation and exemption drift, but it is not yet the relation
execution corpus. The gate itself prints this limitation on every successful
run: green currently proves that the exact shape and decision partitions have
not drifted; with zero receipts it proves nothing about execution coverage.

## Calibration against the escaped defects

The table distinguishes what this checkpoint proves now from what the complete
relation corpus can prove. A derived entry by itself never catches a runtime
defect.

| Escaped defect | Complete-instrument mechanism | This checkpoint |
|---|---|---|
| Fresh install reverified every historical release | Execute lineage lengths `1`, `2`, and `80`; assert exactly `N-1` transitions and one serving-release verification. This is an operation-count invariant, not a timer. | The three lineage obligations exist, but no work-count receipts exist yet; not caught. |
| Optional self-reference recursed forever | Execute verification with the optional self-edge blank and observe bounded arranged-record count and termination. | Obligation exists; not caught until the corpus executes it. |
| Restore refused a blank optional link | Persist a null FK, archive, restore, and observe active stored state; keep this subject independent from arrangement. | Obligation exists; not caught until the corpus executes it. |
| Equal-depth diamond identities collided | Arrange both equal-depth paths, observe two distinct persisted parent identities, and retain the depth-only collision negative. | Topology obligation exists; not caught until the corpus executes it. |
| CI sampled its own decaying load average | None. This is measurement-instrument validity and belongs to the direct `/proc/stat` performance admission gate. | Correctly out of scope. |
| 4,739 artifact loads where 17 sufficed | A small-N activation load counter could enforce one validated load per exact pinned artifact key, but that counter belongs to provider cost/cache behavior rather than a language shape. | Not caught; no duplicate counter was added. |
| Field-origin relation demanded two authorities | Execute a required field-origin create, observe one physical INSERT column and the arranged target UUID in the stored field; separately observe optional field-origin null. | The synthesized `origin`, presence, nullability, and UUID obligations now exist; not caught until receipts replace the relation decision. |
| Unsupported resolve authority | Pair every declared `resolve` key with its lowered storage column and require successful generic execution or the ADR-0042 compile-time refusal. | The authored resolve and lowered physical-type obligations are visible, but the cross-contract execution/refusal receipt is not yet present; not caught at this checkpoint. |

The honest current score against runtime escapes is zero: the foundation
prevents obligation and exemption staleness but does not pretend that a
declaration executed. With the chartered sibling receipts, defects 2, 3, 4,
and 7 become direct stored-fact observations; defect 8 becomes an exact
execution/refusal cross-contract observation; defect 1 becomes a work-count
invariant. Defects 5 and 6 remain outside this instrument.

## Focused verification

- `corepack pnpm typecheck` — PASS
- `corepack pnpm test:unit` — first run observed the new ledger control red
  because the authored optional-boolean union was not enumerated; the walker
  was corrected to retain finite members beside `undefined`; final PASS,
  63/63. The first-use transition control observed the old exact decision red
  when a real first-party package first used `classification="public"`, then
  observed the new explicit decision green. The receipt takeover control
  separately passed for both execution and typed-refusal receipts.
- `corepack pnpm test:architecture` — the exhaustion run first exposed the new
  root check missing from the exact aggregate-command inventory; that
  add-only inventory was re-derived; final PASS, 106/106.
- `corepack pnpm check:language-coverage` — PASS: 1,894 obligations, 0
  receipts, 1,894 explicit decisions, 376 first-party observations. Its next
  line states that green proves exact shape/decision partition stability, not
  execution coverage.
- `corepack pnpm format`, `corepack pnpm lint`, and `git diff --check` — PASS.

The exhaustive relation corpus is intentionally absent from this packet. It
was split by ruling after the second derivation source materially grew the
foundation; this packet matrices the frozen gate and decision mechanism only.
