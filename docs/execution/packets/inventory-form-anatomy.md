# inventory-form-anatomy — the anatomy that renders a form

Date: 2026-08-17
Base: `39fef80c21db604e54c0ffe3c7c55b8f2c32993b` (current `origin/main`; fetched
and confirmed unmoved before cutting)
Branch: `packet/inventory-form-anatomy`
Tier: Critical (raised by the round-1 reachability finding)
Status: **ACCEPTED.** Reviewed candidate
`9d478e4a3e18f5f48a5e92baa866fd6e0f39ab01`; full-matrix tree
`56eb2c7d4cfc82a308b1f135fff65a9b0a663142`; integrated by the required
packet-to-main `--no-ff` merge at
`d048dc0625d5215bb3f6edd1000cd2aba3b4b820`. The integrated executable tree is
byte-identical to the matrix-green tree. Codex and independent user-run Fable
max Critical reviews both returned PASS on the identical reviewed candidate.

## Packet definition

Goal: rule and land the record anatomy an Inventory form gets, so that a scoped
Inventory form renders with its fields and a save control. Ruled in
[ADR-0054](../decisions/ADR-0054-a-record-form-declares-the-anatomy-that-renders-it.md).

Owned paths and the measured disjointness check are recorded in
[lanes.md](../lanes.md) at this branch's first commit, `e4f82b9`.

## The prompt's claims, tested against disk

Every claim was re-located by symbol and re-measured. Three are exact, one is
wrong in a way worth recording, and one neighbouring record is corrected.

| Claim | Verdict |
|---|---|
| The record family is exactly five and there is no `record:activity` | **CONFIRMED** |
| `party/definition.ts` authors the five working slots | **CONFIRMED** |
| `inventory/definition.ts` authors `['breadcrumb','titleStatus','activity']` | **CONFIRMED** |
| The nine-surface `sections`/`activity` split table | **CONFIRMED, exactly**, decoded from the shipped `app.compiled.json` |
| "registers exactly **eight** surface components" | **WRONG — it is eleven.** `surfaceSlotRegistry` holds three `list`, five `record` and three `task` entries; a separate `componentRegistry` holds three shell `contentReferenceId` renderers. The load-bearing half of the claim — a five-member record family with no `activity` — is correct, so the ruling is unaffected. |

**A neighbouring record is corrected.** `relation-scoped-enumeration`'s stop
record (branch `packet/relation-scoped-enumeration` at `fa83edb`) tabulates
**all four** required-relation forms as `breadcrumb, titleStatus, activity`,
including `party_role_form`. `party_role_form` carries the full five and renders,
and did at that branch's base. Its conclusion — that the scoped Inventory forms
are the blocker — is unaffected and correct.

## What was ruled, and why it is not the obvious answer

**Question 1 — what anatomy does an Inventory record form get?** The five
registered record slots. This was verified rather than assumed, and the check
found that the obvious answer is *not* the conformant one:

- `SURFACE_SLOTS.record` in `packages/canonical-model/src/constants.ts` is
  **exact anatomy — all seven slots are required**, and the conformance checker
  observes that floor (`SG003_REQUIRED_SLOT`, `SG009_COMPACT_SLOT`). So the
  five-slot shape is *debt*, not conformance. It is the **maximum renderable**
  set, and it is what catalog, location and party already carry.
- `record:sections` is the only registration in the repository carrying
  `mutationIntents: { form: [...] }`, so it is not one slot among five — a form
  without it is inert before any renderer runs.
- `commandBar` was included deliberately. `renderSections` emits a fallback Save
  when no `commandBar` slot is present, so a save control exists either way;
  declaring `commandBar` puts it in the grammar's slot for a primary action.
  `sections` is what makes the related form operable and thereby re-admits New,
  Edit, archive and restore on the paired surfaces.
- **Is a slot wrong for these surfaces?** Checked against `ux-grammar`, and no.
  An inventory transaction is a posted document, and the grammar's rules for
  posted documents govern *inline grid editing* and *confirm weight on posting* —
  neither is a form slot, and the posting confirm already lives on the detail
  surface's `commandBar` via `renderCapabilityCommand`. Creating a draft
  transaction is not the posting.
- **`childTables` is the one genuinely apt missing slot** — an inventory
  transaction has lines, and `childTables` is the grammar's slot for exactly
  that. It is **not** declared, because no `record:childTables` renderer is
  registered and declaring it would reproduce this defect. Filed, not taken.

**Question 2 — what happens to `activity`? It is removed.** The declaration is
accepted through authoring and compilation, then explicitly causes a late
whole-surface runtime refusal; it is not ADR-0041's accepted-and-ignored state.
The G2-composition program review nevertheless found that **the language cannot
express "declared, intentionally unregistered"**, so retaining the declaration
re-arms the defect. Registering a renderer is a different packet —
the activity rail renders trust-substrate change documents, which is a second
data binding on the surface, and `ux-grammar` makes a second binding the explicit
trigger to re-rule which unit resolves. Removal is expressible **because the
conformance checker already refuses the absence by name**, per slot per surface,
counted in a reviewed baseline that cannot move silently.

**No default was materialized**, and no scripted control was added (ADR-0036 §2).

## Measurements

### Anatomy, before and after — executed

Both runs use the **identical** registry and renderer; the only property varied
is the authored slot list. `party_form` is the unchanged in-run twin.

`surfaceHasUnsupportedComponent` / `surfaceSupportsRuntimeIntent`, read against
the real compiled release:

| surface | BEFORE unsupported / create | AFTER unsupported / create |
|---|---|---|
| `inventory_transaction_form` | `true` / `false` | `false` / `true` |
| `inventory_transaction_line_form` | `true` / `false` | `false` / `true` |
| `legal_entity_form` | `true` / `false` | `false` / `true` |
| `stock_count_form` | `true` / `false` | `false` / `true` |
| `stock_count_line_form` | `true` / `false` | `false` / `true` |
| `party_form` (twin) | `false` / `true` | `false` / `true` |

Rendered through the real `renderSurfaceRuntime` against the real release, with
no provider:

    BEFORE  inventory_transaction_form   UNSUPPORTED=true   record:breadcrumb,record:titleStatus,record:activity
    AFTER   inventory_transaction_form   UNSUPPORTED=false  record:breadcrumb,record:titleStatus,record:commandBar,record:keyFacts,record:sections

**Evidence classification, stated plainly: this was an ad-hoc scratch probe, not
a committed gate.** It was written during Stop 1, when Docker was down and the
browser suite could not run. It is real execution against real artifacts and it
is *not* a regression control. It is retained here because it isolates the
registry-level fact cleanly, and it is **superseded as evidence** by the
committed browser controls and their negative control below.

### Relation census — which repaired forms can actually complete

Read from the compiled operation catalog. Four create operations carry relation
inputs; **`inventory_transaction_create` and `legal_entity_create` carry none.**

| form | scoped | required relations | OBSERVED outcome |
|---|---|---|---|
| `legal_entity_form` | no | none | **renders and creates a record** |
| `inventory_transaction_form` | yes | none | renders; refuses on `legalEntityId` |
| `inventory_transaction_line_form` | yes | `..._transaction` → `inventory_transaction` | renders; refuses |
| `stock_count_form` | yes | `stock_count_transaction` → `inventory_transaction` | renders; refuses |
| `stock_count_line_form` | yes | `..._session` → `stock_count`, `..._transaction_line` → `inventory_transaction_line` | renders; refuses |

**The relation census alone predicted `inventory_transaction_form` would save,
and the browser refuted it.** Scope, not relations, is what stops it — see the
new finding below. This row is left visible rather than rewritten, because the
prediction being wrong is the reason the browser control exists.

**What the repaired forms do NOT yet do.** Four of the five render, submit, and
are refused by the provider rather than refusing at composition with
`UNSUPPORTED_COMPONENT`. **That is expected and is
`relation-scoped-enumeration`'s to close** — the refusal simply moved from "the
page cannot exist" to "this one input has no picker", which is the whole point
of unblocking that packet. It is stated here rather than left for a reviewer to
discover.

### Lineage delta

**10 → 11 entries.** Entries 1–10 are byte-unchanged: entry 10's root
`57f0837e098d76c0…` and normalized digest `a45bd8c905074bbe…` are identical
before and after. Entry 11 is new — profile `northstar.compiler-semantic/v2`,
root `309a03427bc1a5e9…`, normalized digest `2c3f177d0baf9303…`.

The edge is an **ordinary authored-source edge**, not a profile-only edge: the
normalized definition changed, and both sides sit at v2.

**`check:app-release` exits 0**, which is the observation that every prior entry
still reproduces under its own recorded profile (ADR-0047 §5).

**Round-1 correction: 11 → 12 entries.** Entries 1–11 remain byte-unchanged;
entry 11 retains root `309a03427bc1a5e9…` and input-definition digest
`2c3f177d0baf9303…`. Entry 12 records the new transaction operation predicates:
profile `northstar.compiler-semantic/v2`, root `ee788f8c75c9857…`,
input-definition digest `15a000615b8f2ed1…`.

## Bridges taken

The first two were pre-authorized ("any test, fixture or golden your
regeneration makes red, bounded to preserving each assertion's meaning"). The
third is the bounded round-1 review bridge. **Count: three.**

1. **`test/architecture/surface-grammar-conformance.baseline.ts`** — Inventory
   `124 → 104`, **measured by compiling the module**, not derived. The recorded
   arithmetic (five Form surfaces × two fewer missing slots × two rules) is in
   the comment so a later reader can tell which surfaces moved. No other
   module's count changed: catalog 13, location 13, party 23, platform 33.
2. **`test/compiler/compiler-semantic-profile.test.ts`** — one control went red,
   and **it is a real test-design defect this change exposed rather than
   caused.** It located the v1→v2 adoption pair by `applications.at(-1)` /
   `.at(-2)`, which names the edge only while the v2 entry is last; appending
   one ordinary entry put a v2 entry at both indices and the straddle assertion
   failed while nothing it protects had moved. The **sibling test immediately
   above it was already rewritten for this exact class** by `profile-v2-adoption`,
   whose comment reads *"a control whose subject moves when the tree grows is not
   observing the fact it names"* — the class survived one test over. Repaired in
   that test's own idiom: the edge is found as a property (first v2 entry and
   its predecessor), with a non-vacuity guard that the index exceeds zero. Every
   assertion's meaning is preserved; the pair is now stable for all future
   entries.
3. **`apps/web/src/component-registry.ts` and
   `test/postgres/inventory-terminal-state.test.ts`** — granted after the
   Critical review finding, bounded to compiled-precondition-aware Edit/Save
   affordances and executed transaction lifecycle admission twins. No new
   predicate language, surface-runtime input, picker or detail-anatomy work was
   taken. The empirical branch sweep found both paths free.

**No other domain module needed the identical fix.** The enumeration was run:
`grep -rn "'breadcrumb'" packages/domain/src/` returns catalog, location and
party all already authoring the five working slots, and `inventory` alone
authoring the broken shape. **Count of other modules changed: zero.**

## Review round 1 — REVISE, anatomy upheld and lifecycle activation corrected

The fresh review of frozen candidate `860c9ca` returned **REVISE** with one
Critical defect. The five registered slots were judged correct and must not be
reverted. The defect was the operation set the repaired `sections` slot made
reachable: a posted `inventory_transaction` still exposed generic Edit, its
state field could be patched back to draft, and Post then emitted another
movement set because replay identity includes the later source revision.

The correction uses ADR-0034's existing carrier rather than inventing a state
machine:

- create requires a draft candidate;
- update requires both prior and projected images to remain draft;
- archive/restore carry no transaction-state predicate because they preserve
  state and cannot make Post reappear; independent relation restrictions still
  apply;
- parent-scoped transaction lines inherit the transaction update predicate;
- Edit and update Save use the compiled predicate evaluator already used for
  commands, and a direct posted-record form URL emits no update form; and
- the browser journey captures a valid draft update form before posting, posts
  once, attempts that operation-addressed rewind, then observes revision 2,
  Post/Edit absent, one movement and on-hand 8 unchanged.

The review also corrected two explanations. A declared `activity` slot is
accepted through compilation and then explicitly refuses the whole surface at
runtime; it is not ADR-0041's accepted-and-ignored state. And `sections`, not
`commandBar`, is what makes the related form operable and re-admits lifecycle
affordances.

## Filed and left

- **The Inventory `detail` surfaces have the same shape of gap and it is NOT
  fixed here.** `inventory_movement_detail`, `inventory_period_lock_detail`,
  `inventory_transaction_line_detail`, `legal_entity_detail`,
  `stock_count_detail` and `stock_count_line_detail` declare
  `breadcrumb, titleStatus, keyFacts` with no `sections`. They **render** — every
  declared slot is registered — but `renderSections` is the only record-role
  renderer that shows field values, so those pages show identity and revision
  and none of the record's data. That is a different defect (a thin page, not a
  refusing one), it is outside this packet's ruled question, and it is filed
  rather than taken.
- **`record:childTables` and `record:activity` are unregistered platform-wide.**
  Catalog, location and party carry the identical two-slot gap; it is the whole
  of the residual conformance debt on every module's Record surfaces.
- **There is no static gate binding "every declared slot has a registered
  renderer."** The conformance checker reads compiled definitions and has no
  view of the web registry, whose slot keys are not exported. The review bridge
  edits `component-registry.ts` only for predicate-aware mutation affordances;
  it does not build that cross-registry gate. **This is the residual and it has
  the shape of the original defect** — the fix is observed per surface, the
  prevention is not mechanized.

## Gate results, honest

Initial run at reviewed SHA `860c9ca`. **The full matrix is NOT run yet** — per
`git-workflow`'s 2026-08-14 ruling it runs once, after review converges, at the
SHA that integrates. The revised-candidate focused and blast-radius table is
recorded separately below once frozen.

| gate | result |
|---|---|
| `typecheck` | **PASS** |
| `lint` | **PASS** |
| `format` | **PASS** |
| `check:app-release` | **PASS** (required, cross-layer) |
| `check:demo-release` | **PASS** |
| `check:boundaries` | **PASS** (160 files) |
| `test:unit` | **PASS** 120/120 |
| `test:compiler` | **PASS** 150/150 |
| `test:integration` | **PASS** 137/137 |
| `test:contracts` | **PASS** 16/16 |
| `test:architecture` | **PASS** 141/141 |
| `test:browser` | **PASS** 90/90 |
| `test:postgres` | **PASS** 203/203 (required, cross-layer) |
| full matrix | **owed after review converges** |

### Revised candidate at executable commit `3e89d9c`

No executable byte changed after these runs. The final branch-head commit is a
narrative-only checkpoint stamp.

| gate | result |
|---|---|
| `typecheck` | **PASS** |
| `lint` | **PASS** |
| `format` | **PASS** |
| `check:app-release` | **PASS**; entries 1–11 reproduce, entry 12 is current |
| `check:demo-release` | **PASS** |
| `check:boundaries` | **PASS** (160 files) |
| `test:unit` | **PASS** 120/120 |
| `test:compiler` | **PASS** 150/150 |
| `test:integration` | **PASS** 137/137 |
| `test:contracts` | **PASS** 16/16 |
| `test:architecture` | **PASS** 141/141; Inventory ratchet 104/104 |
| `test:browser` | **PASS** 90/90, unfiltered |
| `test:postgres` | **PASS** 203/203, unfiltered, required cross-layer consumer |
| full matrix | **NOT RUN; owed after fresh review converges** |

The first unfiltered PostgreSQL attempt finished 201/202: the packet's new
terminal-state test passed, but an earlier composed fresh-tenant activation
returned `NO_SWAP_TERMINAL`. Its nested semantic, create, posting-replay and
latency checks had passed. The exact composed test then passed 8/8 in isolation,
and a second complete unfiltered suite passed 203/203, including that activation
and the new terminal-state test. No code or deadline changed between attempts;
the packet did not claim the provider gate until the complete green run.

## Stop 1, and how it was cleared

Docker Desktop was not running: `/usr/bin/docker` symlinks into
`/mnt/wsl/docker-desktop/`, which did not exist. **It did not fail — it hung.**
`test/architecture/dependency-boundaries.test.ts` spawns
`test/fixtures/postgres-leak-victim.ts parent`, which waits on stdout for a
container name that never arrives and holds itself open with
`process.stdin.resume()`, with no timeout on that wait. The suite ran 32 minutes
at load average 0.26 before being killed. Killing it left an empty reachability
artifact, which then failed `check:language-coverage` with
`LANGUAGE_COVERAGE_EMPTY_REACHABILITY_EVIDENCE` — a consequence of the kill, not
a finding.

The packet stopped rather than claiming a candidate, because every piece of its
central evidence needs a container. **The user started Docker Desktop and the
packet resumed**; all of that evidence is now recorded above. No product code
was changed while blocked, and no gate was widened or skipped.

## What the browser controls actually observe

- **Every repaired surface renders**: five grammar slots, a
  `form#surface-record-form` with field controls, and a Save carrying
  `form="surface-record-form"`. `party_form` runs the identical helper as the
  untouched twin, so a regression in the helper cannot read as an Inventory
  repair.
- **`legal_entity_form` creates a record end to end** — "Create complete", zero
  diagnostics. This is the packet's claim discharged: a surface that could not
  render at all now persists an operator's input through the real provider.
- **Three assertions in the pre-existing `scopedInventoryJourney` were
  INVERTED**, each a contract on the defect rather than on a requirement: the
  form's `UNSUPPORTED_COMPONENT` alert with zero textboxes and zero buttons; the
  absent `New` link on the transaction list; and the absent Archive/Restore on
  the transaction detail. **The last two were not predicted from the diff** —
  `renderListTitle` and `renderLifecycleOverflow` reach their affordances only
  through `relatedSurface(context, 'form')`, which returns the form solely when
  it supports create or update. One line in the module restored three
  affordances the module had always declared.
- **The posting journey now crosses the newly reachable boundary.** It captures
  the real draft update form, posts once, proves terminal Edit and direct-URL
  Save are absent, sends the captured operation-addressed update around the UI,
  and observes a 422 refusal. The transaction remains revision 2 with Post
  absent, exactly one matching movement, and on-hand exactly 8.

### A kept assertion is relabelled, because it never proved what it was read to prove

`scopedInventoryJourney`'s forged write asserts 422 `OPERATION_UNSUPPORTED`.
**Measured: it does not discriminate the anatomy defect at all.** The payload
carries `intent` and no `operationId`, and ADR-0051 made the write path
operation-addressed, so it is refused for being unaddressed whatever the surface
declares — green before the repair and green after it. It is kept on its own
terms, with the reason recorded, and is no longer counted as anatomy evidence.

## NEW FINDING — a scoped create cannot carry its legal entity

**This is not the anatomy defect, it is not fixed here, and it blocks the
inventory path independently.**

`operationInput` (`apps/web/src/surface-runtime.ts`, re-locate by symbol) returns
`{recordId, relations, values}` for a create. Every legal-entity-scoped create
contract declares `legalEntityId` in `closedArgumentKeys`, and
`requiredSystemInput` (`module-runtime-interpreter.ts`) raises
`MODULE_REQUIRED_SYSTEM_INPUT_MISSING` when the input omits it. **So every scoped
create refuses, on every surface, regardless of relations.**

**Measured by a discriminating pair, not inferred.** `legal_entity_form` and
`inventory_transaction_form` were both driven through the real UI with all
required fields filled. They differ in that one is unscoped and the other is
scoped. The unscoped one returned "Create complete"; the scoped one returned
`OPERATION_UNAVAILABLE`.

**Why it matters beyond this packet:** `relation-scoped-enumeration` is
chartered to make a required relation fillable, and `PUR-1` waits on that. **A
record picker will not make a scoped inventory create succeed** — the write will
still refuse on `legalEntityId`. That is a third blocker on the same path, in the
same shape as `required-relation-uncreatable`, and it had no row.

**Secondary observation:** the operator sees an unattributed *"Save
unavailable"*. The provider names its subject and the web boundary drops it,
which is `relation-refusal-unnamed`'s class and `provider-refusals-erased-at-the-web-boundary`'s.

## Also observed, and filed

Appending a lineage entry whose definition is older than the head is refused at
startup with `ReleaseReverseTransitionRefusal` — *"rollback requires the verified
forward activation that established the current release."* Encountered while
building the negative control. It is consistent with the open `rollback-release-edge`
row and is **not** investigated here.

## Stop count

**1**, cleared.

## Program-review trigger evaluation

No program review is proposed. This accepted packet still does not complete the
first office-worker write:
`relation-scoped-enumeration` and `scoped-create-missing-legal-entity-input`
remain explicit blockers. The first-end-to-end-slice trigger becomes live when
those compose into a real write, before any module fan-out.

## Critical reviews and acceptance

The fresh Critical confirm reviewed frozen candidate
`9d478e4a3e18f5f48a5e92baa866fd6e0f39ab01` and returned **PASS**: all eleven
numbered claims closed and no new executable defect. Two precision notes are
accepted in this record:

- removing `activity` removes its rendered unsupported-slot failure card; the
  old whole-surface refusal was an operability/mutation refusal, not a page
  rendering short-circuit;
- the literal `124 -> 104` movement is 30 violations removed and 10 added,
  net 20. The checked-in wording "two fewer missing slots" remains accurate.

The user then ran the bounded Fable max Critical confirmation against the same
candidate and reported **PASS**. Only the verdict was supplied in this thread,
so this record adds no unreported findings or claims. No executable content
changed between the two reviews; together, the Codex and Fable results complete
the required Critical review sequence.

After review converged, the exact reviewed packet was merged into a staged
integration tree at `56eb2c7d4cfc82a308b1f135fff65a9b0a663142` and the full
matrix was run there. The first attempt reached PostgreSQL and recorded one
environmental startup failure: the container reported ready internally while
its Docker-published localhost endpoint remained unavailable until the helper's
deadline; the test assertion never ran. Every later PostgreSQL case passed. No
file changed. A complete rerun from the same SHA passed:

- unit 120/120; compiler 150/150; integration 137/137; agent 3/3;
  architecture 141/141; contracts 16/16;
- PostgreSQL 203/203; locale 1/1; browser 90/90; observability 11/11;
- language coverage PASS (2,050 obligations, 429 first-party observations);
- reachability PASS (104/104 test files, 10 producer artifacts).

Main then received the packet through `git merge --no-ff
packet/inventory-form-anatomy`, producing
`d048dc0625d5215bb3f6edd1000cd2aba3b4b820` with first parent
`2fd28a42e6578e7cbb984858f667862b213792cc` and second parent the exact reviewed
candidate `9d478e4a3e18f5f48a5e92baa866fd6e0f39ab01`. The executable diff from the
matrix-green staged merge to the real integration merge is empty. The review
record gate passes on that topology, so AGENTS.md §6's identical-tree rule
carries the matrix to the integrated merge without rerunning the same bytes.

The checkpoint-only `scripts/check-parked-work.sh` audit is red on six
pre-existing, unrelated branches aged 9–11 days: `packet/proj-disc`,
`packet/ps-0`, `packet/ps-1`, `packet/ps-2`, `packet/pur-1`, and
`packet/u5-design`. This packet neither deleted preserved evidence branches nor
rebased another lane's work. The failed audit is surfaced for an explicit user
disposition; it does not change the green executable matrix above.
