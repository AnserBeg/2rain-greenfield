# inventory-form-anatomy — the anatomy that renders a form

Date: 2026-08-17
Base: `39fef80c21db604e54c0ffe3c7c55b8f2c32993b` (current `origin/main`; fetched
and confirmed unmoved before cutting)
Branch: `packet/inventory-form-anatomy`
Tier: Behavioral
Status: **STOP 1 — Docker is not running on this machine, so the packet's
central evidence cannot be produced.** The product change is complete and
green on every gate that does not need a container.

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
  declaring `commandBar` puts it in the grammar's slot for a primary action, and
  `surfaceSupportsRuntimeIntent`'s `record` branch requires a form supporting
  create or update, so a working form is also what re-admits archive/restore on
  the paired `detail` surface.
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

**Question 2 — what happens to `activity`? It is removed.** The trap was the
third option and it was refused on the record that names it: the G2-composition
program review found that **the language cannot express "declared, intentionally
unregistered"**, so a declared-unregistered slot is indistinguishable from this
defect and shipping one re-arms it. Registering a renderer is a different packet —
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

**Evidence classification, stated plainly: this is an ad-hoc scratch probe, not
a committed gate.** It was written because Docker is down and the browser suite
cannot run; it is real execution against real artifacts, and it is *not* a
regression control. The committed control is owed and is not yet written — see
the stop.

### Relation census — which repaired forms can actually complete

Read from the compiled operation catalog. Four create operations carry relation
inputs; **`inventory_transaction_create` and `legal_entity_create` carry none.**

| form | required relations | expected outcome after this packet |
|---|---|---|
| `inventory_transaction_form` | none | **renders and saves** |
| `legal_entity_form` | none | **renders and saves** |
| `inventory_transaction_line_form` | `..._transaction` → `inventory_transaction` | renders, then refuses at the provider |
| `stock_count_form` | `stock_count_transaction` → `inventory_transaction` | renders, then refuses at the provider |
| `stock_count_line_form` | `..._session` → `stock_count`, `..._transaction_line` → `inventory_transaction_line` | renders, then refuses at the provider |

**What the repaired forms do NOT yet do.** Three of the five carry a required
relation with no rendered control, so they render, submit, and are refused by
the provider with `MODULE_REQUIRED_RELATION_MISSING` rather than refusing at
composition with `UNSUPPORTED_COMPONENT`. **That is expected and is
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

## Bridges taken

Both were pre-authorized ("any test, fixture or golden your regeneration makes
red, bounded to preserving each assertion's meaning"). **Count: two.**

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

**No other domain module needed the identical fix.** The enumeration was run:
`grep -rn "'breadcrumb'" packages/domain/src/` returns catalog, location and
party all already authoring the five working slots, and `inventory` alone
authoring the broken shape. **Count of other modules changed: zero.**

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
  view of the web registry, whose slot keys are not exported. Building one needs
  `apps/web/src/component-registry.ts`, deliberately read as authority here and
  not edited. **This is the residual and it has the shape of the original
  defect** — the fix is observed per surface, the prevention is not mechanized.

## Gate results, honest

Run at `693bc3f`. **The matrix was NOT run and is not claimable.**

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
| `test/architecture/surface-grammar-conformance.test.ts` | **PASS** 25/25 |
| `test:architecture` (full) | **CANNOT RUN** — hangs |
| `test:postgres` | **CANNOT RUN** (required, cross-layer) |
| `test:browser` | **CANNOT RUN** |
| `check:schema`, `check:reachability`, `check:language-coverage` | **CANNOT RUN** |
| full matrix | **NOT RUN** |

## Why this is a stop

**Docker is not running, and nothing in this repository can start it.**

    $ docker ps
    The command 'docker' could not be found in this WSL 2 distro.
    $ ls -la /usr/bin/docker
    /usr/bin/docker -> /mnt/wsl/docker-desktop/cli-tools/usr/bin/docker
    $ ls /mnt/wsl/docker-desktop
    No such file or directory

The WSL integration symlinks exist from a prior session, so integration is
configured; the Docker Desktop VM is simply not up. `/var/run/docker.sock` is
absent.

**How it presents, which is worth recording because it does not look like its
cause.** `test:architecture` does not fail — it **hangs indefinitely**. It ran
32 minutes at load average 0.26 before being killed.
`test/architecture/dependency-boundaries.test.ts` spawns
`test/fixtures/postgres-leak-victim.ts parent`, which waits on stdout for a
container name that can never arrive; the parent holds itself open with
`process.stdin.resume()` and there is no timeout on that wait. Killing it left
`check:language-coverage` reporting
`LANGUAGE_COVERAGE_EMPTY_REACHABILITY_EVIDENCE: architecture`, which is a
consequence of the killed run and not of this change. The exclusive lock holder
file was cleaned up; `/tmp/north-star-matrix.lock.holders/` is empty. No
orphaned `north-star-*` container could be checked for, because there is no
Docker CLI to ask.

**What this blocks is exactly the packet's bar.** The charter is explicit that
*"a report that cannot show one rendering has not shown the packet"*, and the
committed evidence it requires — a browser control per repaired surface showing
the form renders, shows inputs and a save control, and submits successfully; the
negative control recorded red; `test:postgres` as a required gate; the full
matrix; and the `pnpm dev` walkthrough on port 4174 — **every one of them needs
a PostgreSQL container.** The scratch probe above is real execution and it is
deliberately not offered as a substitute.

**No product code was changed after this finding**, and no gate was widened,
skipped, or re-scoped to make a red look green.

## What resumes the moment Docker is up

In order, all inside the existing lease:

1. Write the browser controls in `apps/web/test/browser/**` — one per repaired
   surface, observing the rendered form, its inputs, its save control, and a
   successful submit on the two that carry no required relation.
2. Convert the existing `scopedInventoryJourney` assertions, which currently
   contractualize the broken state (`UNSUPPORTED_COMPONENT` visible, zero
   textboxes, zero buttons, 422 `OPERATION_UNSUPPORTED`), preserving each
   assertion's meaning.
3. Record the negative control: revert the anatomy on one surface, observe its
   control go red, restore.
4. Run the blast-radius suites, then freeze, emit the review prompt, and stop.
5. One full matrix after review converges, at the SHA that integrates.

**A review prompt is deliberately NOT emitted at this stop.** The product delta
is final, but step 1 adds committed test files, and `review-tiers` voids a review
on any code change after it — reviewing now would buy a verdict that step 1
immediately invalidates, and pay for the reading twice.

## Stop count

**1.**

## Program-review trigger evaluation

No program review is proposed. The packet is mid-flight with no integrated
candidate, which is an explicit anti-trigger. The first-end-to-end-slice trigger
becomes live once this and `relation-scoped-enumeration` compose into a real
office-worker write, and that is the point to propose one — before any module
fan-out.
