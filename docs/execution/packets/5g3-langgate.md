# 5g3-langgate — derived language conformance instrument

Status: authoring candidate; exhaustive relation corpus remains split

Tier: Critical

Original base: `5bdf511d652009b962cf0ad0983ab993ea0e96c3`

Integrated base: `1962b10e45bd0e4d126d4c603056fc031a09144c` (merged at
`c163c5c7dc83d317298ac63d29650171553d45b2`)

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
Inventory application plus Platform) currently contain 396 obligations. The
other 1,503 obligations are not called covered. Three written decisions name
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

The phase-1 relation scope contains 94 obligations and is partitioned exactly:
**0 supported-and-exercised + 89 supported-but-unexercised + 5
accepted-but-unhonored**. The five defect-inventory entries are the three
accepted relation-cardinality values and the two accepted join-eligibility
values identified by phase 1. With no current-run receipts, the gate credits no
shape as exercised even where older tests exist; those tests become coverage
only when a producer emits a current-run receipt tied to executed-file evidence.

Merging current main moved exactly 16 obligations from `unobserved` to
`observedOutsideRelationScope`, with none moving in the reverse direction and
no ledger-axis change: assertion `fails`; operation invocation/reference and
their v4 stamps; `appendFact`; registered-capability effect/reference and its
v4 stamp; field-comparison precondition/reference/value shapes and their v4
stamps; `equals`; text value; O1 tier; and `transition` permission action. The
gate first failed on the stale 380-observation snapshot with
`LANGUAGE_COVERAGE_OBSERVATION_CHANGED`; the refreshed 396-observation snapshot
and both affected decision identities are recorded as an explicit merge
attribution, not treated as execution evidence.

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
declared `executed`, `typedRefusal`, or defect-only `unhonored` kind. The only
alternative is one of the exact, digest-bound written decisions above.

The mandatory negative controls are observed in
`test/unit/language-conformance-ledger.test.ts`:

- `phantom-axis` refuses `LANGUAGE_COVERAGE_PHANTOM_OBLIGATION`;
- `missing-axis` names one authored and four lowered `null` branches declared
  beside open `string` or `number` members. It failed against the earlier
  walker because the axes were absent, then passed only after finite union
  members were emitted independently of their non-finite siblings;
- `evidence-tamper` refuses `LANGUAGE_COVERAGE_RECEIPT_TAMPERED`;
- `observation-snapshot` separately refuses an absent snapshot with
  `LANGUAGE_COVERAGE_OBSERVATION_SNAPSHOT_MISSING` and an empty snapshot with
  `LANGUAGE_COVERAGE_OBSERVATION_SNAPSHOT_EMPTY`;
- `entry-skip` refuses `LANGUAGE_COVERAGE_UNCLAIMED_ENTRY` and names the entry;
- `receipt-claim` refuses `LANGUAGE_COVERAGE_UNCLAIMED_ENTRY` when a checked-in
  claim names a receipt that the current run did not produce;
- `refusal-distinguisher` refuses
  `LANGUAGE_COVERAGE_OUTCOME_MISMATCH` when a typed refusal is offered for an
  execution claim; and
- `disposition` refuses `LANGUAGE_COVERAGE_DISPOSITION_MISMATCH` in both
  directions: an execution receipt for a shape recorded as
  accepted-but-unhonored, and an unhonored receipt for a shape recorded as
  supported;
- `defect-inventory-addition` refuses
  `LANGUAGE_COVERAGE_STALE_DEFECT_INVENTORY_SET` when a line is added without
  moving the bound decision identities;
- `language-growth` adds a derived obligation and refuses
  `LANGUAGE_COVERAGE_STALE_DECISION` against the old ledger digest;
- `product-deletion` removes the observed compiler-emitted relation `origin`
  fact and refuses `LANGUAGE_COVERAGE_OBSERVATION_CHANGED` rather than allowing
  the declaration-side path to keep it covered;
- `receipt-shape` refuses an output outcome the parser does not recognize with
  `LANGUAGE_COVERAGE_RECEIPT_OUTCOME_INVALID`; and
- `first-use-transition` starts with the real first-party obligation
  `authoredLanguage:$.fields[].classification="public"` in the unobserved
  partition, changes the composed first-party package to use that value,
  normalizes and lowers the changed package, and observes
  `LANGUAGE_COVERAGE_OBSERVATION_CHANGED` naming that exact obligation. The
  control then moves the snapshot while retaining the old decisions and
  observes `LANGUAGE_COVERAGE_STALE_DECISION_SET`. It next reproduces the
  stronger follow-on by mechanically updating the bitmap and exact-set
  digests while retaining the old decision IDs; that is refused with
  `LANGUAGE_COVERAGE_STALE_DECISION_IDENTITY`. The gate returns green only after
  a new exact decision identity is recorded.

A separate mechanism control proves that either a valid execution receipt or
a stable typed-refusal receipt can instead take over a moved obligation while
the old decision remains unchanged. Another proves a written decision cannot
survive a ledger digest change.

### Executed red ledger

The controls above catch and assert these exact failures:

- absent snapshot: `LANGUAGE_COVERAGE_OBSERVATION_SNAPSHOT_MISSING`
- empty snapshot: `LANGUAGE_COVERAGE_OBSERVATION_SNAPSHOT_EMPTY`
- accepted-but-unhonored but honored:
  `LANGUAGE_COVERAGE_DISPOSITION_MISMATCH: authoredLanguage:$.relations[].cardinality="manyToOne" is classified accepted-but-unhonored but receipt observed executed`
- supported but unhonored:
  `LANGUAGE_COVERAGE_DISPOSITION_MISMATCH: authoredLanguage:$.relations[].cardinality="manyToOne" is classified supported but receipt observed unhonored`
- grown derived ledger:
  `LANGUAGE_COVERAGE_STALE_DECISION: fixture-observedRelationScope@357ae32cd0ccb69c5f40cf38b84eedc2064d1291f6db57ab2dd2ab4d80ee1fe9 names fixture-ledger-digest, current ledger is grown-fixture-ledger-digest`
- claimed but unproduced receipt:
  `LANGUAGE_COVERAGE_UNCLAIMED_ENTRY: authoredLanguage:$.relations[].cardinality="manyToOne"`
- compiler output fact removed:
  `LANGUAGE_COVERAGE_OBSERVATION_CHANGED: loweredStorage:$.relations[].relationColumn.origin.$presence="present" moved from observedRelationScope to unobserved; add an execution/refusal receipt or record a new explicit decision`
- a bare defect-inventory line added:
  `LANGUAGE_COVERAGE_STALE_DEFECT_INVENTORY_SET: fixture-observedRelationScope@357ae32cd0ccb69c5f40cf38b84eedc2064d1291f6db57ab2dd2ab4d80ee1fe9 no longer binds the exact accepted-but-unhonored obligation set`

The last control does **not** make adjudication cryptographic. A future lane can
add a defect-inventory entry, recompute the set digest, and mint the resulting
new decision identities; the same unit control deliberately proves that such a
coherent rewrite passes. Nothing in this repository can distinguish that edit
from an orchestrator-authorized ruling. Source review and the lanes.md bridge
rule are therefore the only things that stop a future writer from laundering a
real defect through `coverage-decisions.json`. The gate prevents a silent or
partial reclassification and makes the full decision move visible; it cannot
authorize the move.

The product-deletion red observes a deletion that changes the compiler's
lowered output. With **zero receipts**, the gate cannot see deletion of runtime
semantics that leaves authored and lowered shapes byte-identical, and it does
not claim otherwise: such obligations remain supported-but-unexercised rather
than supported-and-exercised until the sibling corpus supplies stored-fact or
typed-refusal receipts with its own victim controls.

## Why the corpus is split here

The addendum's second derivation source materially changed the foundation: it
now contributes 98 axes and 180 lowered-output obligations that a schema-only
ledger could never see. The combined ledger is 1,899 obligations, of which 94
are relation-specific (82 authored/topology and 12 lowered) and form the exact
phase-1 partition. Building the
required sibling corpus is a separate PostgreSQL fixture and execution
corridor: it must pack the supported finite relation combinations, every graph
topology, typed authoring refusals, the lineage work corridor, and independent
stored-fact witnesses. That is materially larger than adding a few claims to
the gate and would cross the charter's explicit split condition. No existing
fixture was extended and no behavior was baselined.

The receipt-claims file therefore remains empty. All 1,899 entries are
decision-covered obligations at this checkpoint, not execution coverage. This is a real
gate over obligation and exemption drift, but it is not yet the relation
execution corpus. The gate itself prints this limitation on every successful
run: green proves the derived specification choices, observed partition, and
exact decision identities match their reviewed records; with zero receipts it
proves nothing about execution coverage. It also states that changing a
decision record requires a new identity.

## Pre-handoff correction history (not packet review)

The earlier union walker emitted finite members only when every sibling was
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
from that corrected ledger; none of the pre-correction digests was carried
forward.

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
- `corepack pnpm test:unit` — PASS, 73/73 after the main merge and vacuity
  controls. Earlier work observed the new ledger control red because the
  authored optional-boolean union was not enumerated; the walker was corrected
  to retain finite members beside `undefined`. The pre-handoff missing-axis
  control then independently failed against the earlier walker for the mixed
  open/null unions before passing after its repair. The first-use transition
  control observes the old
  exact decision red, the snapshot-and-digest-only retarget red, and a new
  explicit decision identity green. The receipt takeover control separately
  passes for both execution and typed-refusal receipts. Two locale-separated
  derivations are byte-identical. An earlier 65/65 unit run overlapped KERNEL's
  matrix because the lane check and suite were incorrectly chained; it is not
  credited here. The reported unit result is the subsequent quiet rerun.
- `corepack pnpm test:architecture` — pre-merge authoring evidence was PASS,
  106/106. The post-merge focused run is environmentally red before LANGGATE's
  architecture assertions: Docker Desktop is not mounted in this WSL distro,
  so leak-guard's real-container controls fail at `docker run` with `The command
  'docker' could not be found in this WSL 2 distro`; its parent-victim control
  then waits indefinitely after the worker exits, so the focused run was
  interrupted. No test was skipped or weakened. A frozen full matrix remains
  required after Docker is restored.
- `corepack pnpm check:language-coverage` — pre-merge authoring evidence only;
  the refreshed focused run reports PASS: 1,899 obligations, 0 receipts, 1,899
  decision-covered obligations, 396 first-party observations, and relation
  partition `94 = 0 + 89 + 5`. Its next
  line states the narrower reviewed-record/identity meaning and the absence of
  execution coverage.
- `corepack pnpm format`, `corepack pnpm lint`, and `git diff --check` — PASS.

The exhaustive relation corpus is intentionally absent from this packet. It
was split by ruling after the second derivation source materially grew the
foundation; this packet matrices the frozen gate and decision mechanism only.
