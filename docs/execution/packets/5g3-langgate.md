# 5g3-langgate — derived language conformance instrument

Status: REVISE round 1 candidate; exhaustive relation corpus remains split

Tier: Critical

Base: `5bdf511d652009b962cf0ad0983ab993ea0e96c3`; current main
`5679cd2186a06864070a21563cace39df62877da` merged before the revision

## Checkpoint outcome

The acceptance instrument now derives an exact obligation ledger from two
independent specifications:

1. `VersionedAuthoredApplicationPackage` in
   `packages/canonical-model/src/schemas.ts`, which describes what an author
   can submit; and
2. `StorageTargetPayloadV1` in `packages/compiler/src/storage.ts`, including
   reachable imported output types and the physical field-type table, which
   describes what downstream consumers can receive after lowering.

The corrected derived ledger contains 399 exact-path axes and 1,899 value
obligations: 301 authored-language axes / 1,719 obligations and 98
lowered-storage axes / 180 obligations. The lowered set
includes the compiler-synthesized relation marker
`$.relations[].relationColumn.origin.$presence = absent | present`, its
`origin = field` value, relation nullability, ownership, archive behavior,
fixed UUID physical type, column nullability, field-contract choices, index
kinds, and the complete compiler-owned PostgreSQL field-type table. The
phase-1 graph classification adds ten schema-induced topology obligations and
the `1 / 2 / 80` lineage work corridor.

The five first-party definitions (the composed Party/Catalog/Location/
Inventory application plus Platform) currently exercise 380 obligations. The
other 1,519 obligations are not called covered. Three written decisions name
the exact current partitions in
`test/fixtures/g2/language-conformance/coverage-decisions.json`:

- observed relation values remain execution debt pending the sibling corpus;
- observed non-relation values remain execution debt pending later axis
  packets; and
- unused values are exempt only while unused.

Each decision binds the full ledger digest, the digest of the exact obligation
set it covers, and an exact decision identity derived from that complete
record, including its rationale and revisit condition. The decision document
also carries an exact compact bitset of the observed/unobserved partition that
produced those set digests. Adding an axis or value invalidates the ledger
digest. Using a previously unused existing value no longer matches that
snapshot. Recomputing the bitmap and both digests while retaining the old
decision ID now fails with `LANGUAGE_COVERAGE_STALE_DECISION_IDENTITY`; passing
with a decision requires a new identity visible to source review.

This is the exact limit of the mechanism rather than an approval claim. A
source editor can author a new decision identity, because no repository gate
can cryptographically distinguish adjudication from an authorized source edit.
Repository review decides whether that new written decision was ruled. The gate
proves that the *existing* decision record did not stretch silently; it does
not claim to replace review authority.

## Gate and claims mechanism

`check:language-coverage` is wired into the root test path, the repository
matrix, and hosted CI. A receipt claim alone does not discharge an obligation.
The gate requires a current-run receipt whose integrity digest is valid, whose
producer test file has successful executed-file credit, whose obligation
exists in the freshly derived ledger, and whose outcome matches the claim's
declared `executed` or `typedRefusal` kind. The only alternative is one of the
exact, digest-bound written decisions above.

The six mandatory negative controls are observed in
`test/unit/language-conformance-ledger.test.ts`:

- `phantom-axis` refuses `LANGUAGE_COVERAGE_PHANTOM_OBLIGATION`;
- `missing-axis` names one authored and four lowered `null` branches declared
  beside open `string` or `number` members. It failed against the reviewed
  walker because the axes were absent, then passed only after finite union
  members were emitted independently of their non-finite siblings;
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
  observes `LANGUAGE_COVERAGE_STALE_DECISION_SET`. It next reproduces the
  reviewer's stronger attack by mechanically updating the bitmap and exact-set
  digests while retaining the old decision IDs; that is refused with
  `LANGUAGE_COVERAGE_STALE_DECISION_IDENTITY`. The gate returns green only after
  a new exact decision identity is recorded.

A separate mechanism control proves that either a valid execution receipt or
a stable typed-refusal receipt can instead take over a moved obligation while
the old decision remains unchanged. Another proves a written decision cannot
survive a ledger digest change.

## Why the corpus is split here

The addendum's second derivation source materially changed the foundation: it
now contributes 98 axes and 180 lowered-output obligations that a schema-only
ledger could never see. The combined exact partition is 1,899 obligations, of which
94 are relation-specific (82 authored/topology and 12 lowered). Building the
required sibling corpus is a separate PostgreSQL fixture and execution
corridor: it must pack the supported finite relation combinations, every graph
topology, typed authoring refusals, the lineage work corridor, and independent
stored-fact witnesses. That is materially larger than adding a few claims to
the gate and would cross the charter's explicit split condition. No existing
fixture was extended and no behavior was baselined.

The receipt-claims file therefore remains empty. All 1,899 entries are
explicit decisions at this checkpoint, not execution coverage. This is a real
gate over obligation and exemption drift, but it is not yet the relation
execution corpus. The gate itself prints this limitation on every successful
run: green proves the derived specification choices, observed partition, and
exact decision identities match their reviewed records; with zero receipts it
proves nothing about execution coverage. It also states that changing a
decision record requires a new identity.

## Critical review round 1 corrections

The reviewed union walker emitted finite members only when every sibling was
finite or `undefined`. Consequently `string | null` and `number | null` lost
their `null` member. The missing obligations were the authored assertion
diagnostic and the lowered maximum-length, precision, scale, and index-predicate
members. The missing-axis control was observed red before the repair. Emitting
each finite member independently adds exactly five axes and five obligations;
four are first-party-observed and one remains unobserved.

All ledger ordering now uses Unicode code-point comparison. The same synthetic
values sorted differently under `LC_ALL=C` and `LC_ALL=sv_SE.UTF-8` with the old
`localeCompare` mechanism; the replacement yields one specified order, and two
independent child-process derivations under those locales are byte-identical.

The corrected ledger digest is
`f32d5fa17f1e5ddaf0f0a28d61d3eb5447af0235e8301bc2952231624d52f5cb`.
All three decision ledger/set digests and decision identities were re-derived
from that corrected ledger; none of the pre-review digests was carried forward.

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
  was corrected to retain finite members beside `undefined`. Review round 1's
  missing-axis control then independently failed against the reviewed walker
  for the mixed open/null unions before passing after its repair; final PASS,
  65/65 on a quiet slot. The first-use transition control observes the old
  exact decision red, the snapshot-and-digest-only retarget red, and a new
  explicit decision identity green. The receipt takeover control separately
  passes for both execution and typed-refusal receipts. Two locale-separated
  derivations are byte-identical. An earlier 65/65 unit run overlapped KERNEL's
  matrix because the lane check and suite were incorrectly chained; it is not
  credited here. The reported unit result is the subsequent quiet rerun.
- `corepack pnpm test:architecture` — the exhaustion run first exposed the new
  root check missing from the exact aggregate-command inventory; that
  add-only inventory was re-derived; final PASS, 106/106.
- `corepack pnpm check:language-coverage` — PASS: 1,899 obligations, 0
  receipts, 1,899 explicit decisions, 380 first-party observations. Its next
  line states the narrower reviewed-record/identity meaning and the absence of
  execution coverage.
- `corepack pnpm format`, `corepack pnpm lint`, and `git diff --check` — PASS.

The exhaustive relation corpus is intentionally absent from this packet. It
was split by ruling after the second derivation source materially grew the
foundation; this packet matrices the frozen gate and decision mechanism only.
