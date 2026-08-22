# PUR-1 — the purchase order document, and the first declared state machine

Date: 2026-08-22

Base: `e8be8c31c286d92816146d595ef3e9114496208f` (`origin/main`, fetched and
verified this session)

Branch: `packet/pur-1-v2` — **not** `packet/pur-1`, which is 430 commits behind
and was read as REFERENCE only.

Tier: Critical

Status: evidence ready

## Goal

`purchase_order` + `purchase_order_line`: create, edit while draft, release,
cancel, close, reopen, browse. No inventory movement — nothing posts, nothing
touches stock.

The packet's real subject is narrower and larger than that list: **this is the
first first-party module to declare `stateMachines`.** ADR-0050:150 records what
that costs — *"Zero release roots move, because no first-party module declares a
state machine … That is what makes the cut cheap today and expensive the moment
any module adopts one."* This is that moment.

## Salvage admission — `packet/pur-1`, REFERENCE not merge

The parked branch was read and never merged or rebased. Per
`salvage-admission`, each decision is recorded:

| Subject | Mode | Reason |
|---|---|---|
| module skeleton (entity/field/query/operation/surface/permission helpers) | **RE-EXPRESS** | The shape is right and is the same shape `party` uses. Re-authored at v5 against current contracts; no body copied verbatim. |
| the not-released precondition on the four generic header operations | **PORT**, strengthened | The parked lane's own words — *"that guard is the half of the design that survives review."* Strengthened from one term to three; see the ruling below. |
| `parentScopedChild` line relation carrying the guard down with zero line declarations | **PORT** | Unchanged. It is the mechanism, and `parentGuardsFromCatalog` still derives from the parent's UPDATE precondition. |
| the three-place registry edit | **PORT** | Same entries, re-anchored: `posted_stock_balance` now sits where the parked diff expected `reservation`. |
| `const version = 'v4'` | **REJECT** | Every first-party module is `v5` / `northstar.normalization/v5`. Verified in `party` and `inventory`. |
| `stateMachines: []` and its justifying comment | **REJECT** | Reversed by ADR-0050, which did not exist when the lane stopped. Its comment — *"nothing in `packages/runtime/` reads it"* — was true then and is false now: the gateway carries four `transitionStateEffect` references. |
| `received_quantity` | **REJECT** | Plan §7.12. It ships no receipts, so the value can only ever be zero. |
| `closed` as a fourth enum value with nothing producing it | **REJECT, then RE-ADMITTED as a state** | See the lifecycle ruling. |
| the parked unit test | **RE-EXPRESS** | Its assertions are a specification; every one either survives or is consciously retired here. Two are retired: `stateMachines` is no longer empty, and `storageTransition` is not in the release manifest of a compile with no prior release (the parked assertion was wrong on current `main` — measured). |

## ADR

[ADR-0059](../../decisions/ADR-0059-a-document-declares-its-whole-lifecycle-at-adoption.md)
— proposed. It records the measured cost of adopting a machine (a lineage entry
per state or transition added later, refused by name as
`COMPILER_STORAGE_RETYPE_UNSUPPORTED`), rules that a module declares its whole
lifecycle in the release that adopts one, distinguishes that from plan §7.12's
`received_quantity` ruling rather than overturning it, and fixes the purchase
order's four states and four transitions with the four that are refused. `SAL-1`
and `PUR-2` both inherit it.

`0059` was chosen after enumerating ADR numbers across every branch, not just
`main`: `0058` is taken on `packet/expected-red-gate`. That is `lanes.md`'s
ADR-number-collision row applied.

## Rulings

### 1. The lifecycle is declared in full, including the parts this packet cannot drive

```
draft --release--> released --cancel--> cancelled
                       |  ^
                  close|  |reopen
                       v  |
                     closed
```

Four states, four transitions. Refused and asserted absent: `released → draft`
(draft asserts no commitments exist, and once released, receipts may),
`draft → cancelled` (a draft's exit is the generic ARCHIVE the four standard
operations already provide), `closed → cancelled` (reopen first), and
`cancelled → anything` (terminal; reissue instead).

**Cancel departs from `released`, not from `draft`.** A released order is
guarded against every generic operation, so cancel is its only exit; a draft
order still has archive. `transitionStateEffect` carries exactly one
`transition` reference, so one operation drives one transition and a cancel
reachable from two states would need two of each.

**Declaring the whole door at once was not a preference, and the cost was
measured rather than argued.** An earlier commit in this packet shipped a
three-state machine and minted lineage entry 14. Adding `closed` afterwards
raised

```
COMPILER_STORAGE_RETYPE_UNSUPPORTED
  $.fields.fieldType
  northstar.app:derived_state_field.machine.purchase_order_lifecycle
  "v1 storage transitions do not retype existing physical columns"
```

The premature entry was discarded, the lineage rebuilt from the accepted
13-entry head, and this packet mints exactly one. **Every state or transition
added after this release is a normalization event and a lineage entry of its
own.** That is ADR-0050's "expensive" made concrete on the first try.

### 2. `state` is not authored, and the compiler is why

ADR-0050 §2 binds the placement: *"normalization materializes each machine's
state field as an ordinary enum field on its entity, whose options are the
machine's states, and the parallel `derivedStateField` storage construct is
retired."*

So the module authors no `state` field. Measured: `materializeStateFields` mints
`northstar.purchasing:derived_state_field.machine.purchase_order_lifecycle` at
`orderKey: 0`, `presence: 'required'`, `defaultSemantics: 'declaredDefault'`
carrying `initialState`, with options that ARE the four states. The compiled
storage entity reports `derivedStateFields: []` — the retired construct stays
retired — and one ordinary text column.

The module must still ADDRESS that field, in preconditions and in query
selections, so `definition.ts` re-derives the id. That is a second spelling of a
compiler-owned rule, so a control renames the machine and observes the module's
constant stop resolving.

### 3. The header guard is `not(released) and not(closed) and not(cancelled)`

The charter said "not-released". Three terms ship, and the extra two are not
decoration: this module makes `closed` and `cancelled` reachable, and a lone
`not(released)` would leave an order in either fully editable — and, through the
parent-aggregate rule, its lines too. The negative-control run confirms the
difference is observable: reducing the guard to the charter's single term reds
exactly one test and no others.

**The NEGATIVE form is structurally forced, not stylistic.** `prepareMutation`
evaluates a create's precondition against the CANDIDATE image, which is the
caller's patch — and the state field is excluded from every caller-writable
contract, so it is absent there. Under ADR-0021 total-absence semantics
(`absentComparison: 'false'`) a positive `state equals draft` would evaluate
FALSE on that image and refuse every create. This is measured, not reasoned: the
guard is evaluated against an empty image and reported `holds`.

### 4. Currency sits on the header, unit price on the line

The bridge and plan §7.3 both read *"order lines carry currency and optional
unit price"*. The program plan's own catalog is more specific and is the
authority: `:1275` gives `purchase_order` "number, supplier party, state, order
date, expected date, **currency**, notes" and `:1276` gives
`purchase_order_line` "PO id, item, ordered quantity, received quantity read
model, **optional unit price**". Both monetary facts are retained, which is what
§7.3's correction requires; neither valuation, invoicing, tax nor AR appears.

## Stop 1 — the amend operation is not expressible in this lease

**The bridge instruction's item 3 asked for an amend operation writing ordered
quantity only, with a precondition of `state in (released, closed)`. Three
independent measurements say it cannot be built as specified, and each of the
three fixes is outside this packet's fence.**

**(a) `writableFieldIds` is entity-wide, not per-operation.** The bridge cited
`projections.ts:1191` as deriving it "from the operation's own declared fields,
all-or-nothing per operation". Measured, the first half does not hold:
`operationInputContract` receives
`fieldsByEntity.get(operation.effect.entity.targetId)` — the entity's whole
active field set, minus materialized state fields — and `operationDefinition` is
a `z.strictObject` with no per-operation field carrier at all. A second
`updateRecordEffect` on `purchase_order_line` compiles to

```
writableFieldIds = [item_id, line_number, ordered_quantity, unit_price]
```

identical to `purchase_order_line_update`. **The shipped precedent confirms it
rather than my probe alone:** `advance_period_lock` and `reopen_period` are two
distinct update operations on `inventory_period_lock` and both carry the same
entity-wide set. That entity happens to have exactly one writable field, which
is why the pattern reads narrow — it is not.

A quantity-only amend is therefore a full line update wearing a narrower name.
That is ADR-0050 §7's defect class one construct over: a record asserting a
restriction execution ignores.

**(b) The precondition cannot address the parent's state.** Ordered quantity is
a line field, and a line's record image has no state key. Under ADR-0021
absence semantics the comparison is false, so `any(equals released, equals
closed)` refuses ALWAYS. Measured: `refused`.

**(c) The parent-aggregate rule refuses it regardless.**
`parentGuardsFromCatalog` collects EVERY active `updateRecordEffect` on the
parent and `requireRelationTarget` requires all of them. Measured, the header
guard on each parent state: draft `holds`, released `refused`, closed `refused`,
cancelled `refused`. A guard-free amend on the line is still refused by the
platform in exactly the states the amend is for. Adding a second header update
operation makes this stricter, not looser — the guards are ANDed.

**What it would take:** a canonical carrier for a per-operation writable subset
(canonical-model + compiler), or a way for a child operation's precondition to
address the parent image (compiler + runtime), or an exemption from the
parent-aggregate rule (runtime). All three are beyond "registry entries", which
is the boundary the charter names as the important stop.

**Product consequence, stated plainly because it is now a shipped limitation:**
once a purchase order leaves `draft`, its ordered quantities cannot be changed
at all. The reopen returns a closed order to `released`, but `released` is still
guarded, and `released → draft` is refused by ruling. `PUR-2` inherits both the
amend and the received-quantity floor that belongs with it.

Stop count for this packet: **1**.

## ADR-0050 §6 — which owed items still reproduce

The charter omitted §6; the bridge added it. Measured against this tree:

| Item | Verdict |
|---|---|
| 1 — the read path: *"nothing yet admits it to query selections, so a released purchase order cannot be listed by state"* | **CLOSED.** The materialized field is in `packageRevision.fields`, and all four `purchase_order` queries select it and compile. Controlled: dropping the selection reds, and below v5 the selection is not expressible at all. |
| 2 — release verification cannot populate a field no caller may write | **CLOSED in the compiler.** `projections.ts` excludes materialized state fields from both `enumReject` and `searchableExclusion`, the two scenario kinds that probe THROUGH create, with a comment naming `VERIFICATION_EXCLUDED_FIELD_VALUE_MISSING`. Purchasing's verification plan carries no scenario whose subject is the state field. The end-to-end confirmation is `test:postgres`. |
| 3 — which layer owns the closed contract | **CLOSED, and decided at the gateway.** `semantic-operation-gateway.ts` now runs `assertClosedOperationArguments` for `isRegisteredCapabilityOperation(definition) \|\| isRegisteredTransitionOperation(definition)`; the interpreter's `assertAllowedKeys` still refuses one layer down. Both refuse; the placement is no longer inherited. |
| 4 — the per-entity field budget | Already withdrawn by ADR-0050 itself as a misattribution. |
| 5 — `operationIntent` returns `null` for the effect kind | **STALE**, as the bridge said. `surface-contract.ts` returns `'command'`. |

**Three of the five were stale.** The pattern is worth naming: ADR-0050's "what
is owed" section outlived its own closure by four packets.

## Registry edits — the three-place change

`purchase_order` and `purchase_order_line` are `entityOwned` in
`LEGAL_ENTITY_FAMILY_MAP_V1` (`inventory/contracts.ts`), in
`LEGAL_ENTITY_FAMILY_RULES` (`compiler/src/conformance.ts`), and the
`purchase_order_line → purchase_order` `sameEntity` relation is added to
`LEGAL_ENTITY_RELATION_SEMANTICS_V1` and `LEGAL_ENTITY_RELATION_RULES`.

Both arrays are ORDER-SENSITIVE — `conformance.ts` raises
`INVENTORY_CONTRACT_INVALID` with subject `'order'` when lengths match but
positions do not — so the entries sit at identical indices in both files.

**The compiler copy is the one that bites, and it was measured both ways.** With
only the domain rows, both entities compiled `legalEntity: undefined`. With the
compiler rows, both lower

```
{ column: 'legal_entity_id', familyClassification: 'entityOwned',
  immutableAfterCreate: true, nullable: false, postgresqlType: 'uuid',
  referencedFamilyId: 'legal_entity' }
```

`resolvePinnedLegalEntityFamily` is keyed on the family id, not the package, so
the standalone purchasing package does not need adding to
`LEGAL_ENTITY_GOVERNED_PACKAGES` — and it is not added.

The family map stays in `packages/domain/src/inventory/contracts.ts`. Moving it
is a declared stop condition and was not done.

## No migration, and none should be written

Plan §7.7. Module tables are created by `module-storage-materializer.ts` from
the compiled storage-transition projection at release activation;
`db/migrations/*.sql` is platform and kernel only. This is asserted rather than
argued: the packet compiles purchasing against an empty prior release and reads
the `storage-transition` envelope, which carries `createTable` for both
purchasing entities, `createIndex` and `addForeignKey`, and nothing matching
`delete|drop|truncate|destroy`. **`db/` is untouched.**

## Release lineage

13 → 14. Head `c2b05dcdd48ed9af3e927ddf9f3a90d0273cc6d3d3a47645548c5741f4113223`,
succeeding `37057e242725b9604cdfb2c73d6e8aed25edf4f93e5cebd3f54e733100c11685`.
`check:app-release` and `check:demo-release` both exit 0. The plan's stale "8
entries" was corrected separately at `4780efc`.

`app.authored.json` is verified PURELY ADDITIVE against the base: comparing both
sides member-by-member on identity keys reports 0 removed and 0 changed across
every collection, with exactly 2 assertions, 2 entities, 10 fields, 10
operations, 12 permissions, 8 queries, 1 relation, 1 state machine, 2 storage
mappings, 6 surfaces and 1 module added. The 975 "deleted" lines in the raw diff
are alignment artifacts.

## Surface-grammar baseline — measured, never hand-merged

First run of the ratchet against the new entry reported `purchasing=23/0`; 23 is
recorded. It is Party's 23 exactly, and for the same reason — six surfaces in
the same five-slot anatomy carrying the identical platform-wide
`childTables`/`activity` residual that catalog, location and party carry. No new
violation kind, no renderer exemption.

The navigation test needed a real repair rather than a number bump.
`MAX_PRIMARY_NAVIGATION_ENTRIES` counts navigation SURFACES, not modules, and
Purchasing adds two lists — so the without-Inventory fixture went from four to
six and GROUPED, leaving the flat arm with no flat manifest to observe. The
fixture now strips Purchasing too, through a `withoutModule` helper that keeps
the exactly-once removal assertions per module. The grouped arm reads five
module groups, exactly the budget, so Purchasing is a peer of Inventory and not
the first occupant of an overflow `More`; the six-module arm still observes the
collapse.

## Evidence

Band A — the state field, the transitions, the preconditions. One recorded red
per vacuity vector, each varying exactly one property of a deep copy. The
subject is never mutated, and `normalizationRefusal`/`compileRefusal` THROW when
a varied definition is accepted, so a control that observed nothing fails rather
than deep-equalling an empty list.

| Vector | Control |
|---|---|
| subject absent entirely | `stateMachines: []`; and separately one transition removed from the machine while its operation survives. Both refuse by name. |
| proxy satisfied while the fact does not hold | an authored field carrying the DERIVED state id → `CANON_STATE_FIELD_COLLISION`; and a second enum under a different id, which the compiler does NOT refuse and which the "exactly one enum on `purchase_order`" assertion is what stands against. |
| check reading zero input | the enum reader asserted to red on an empty package; and the guard evaluated against a WRONGLY KEYED image, which `holds` precisely because absence makes `not(equals)` true — that is what makes the correctly-keyed refusal observable. |
| output shapes the parser does not recognise | `projectionPayload` refuses an absent family rather than returning `undefined` into optional-chained assertions. |
| subject repaired before it is measured | the derived field id is spelled in `normalize.ts` AND re-derived in `definition.ts`. Renaming the machine moves normalization's field and leaves the module's constant behind; the package refuses with the `CANON_REFERENCE_UNRESOLVED` + `CANON_QUERY_FIELD_LOCALITY` pair ADR-0050 §1 measured. |

The guard and the command matrix are **observed, not asserted**: the COMPILED
precondition is evaluated through `evaluateRegisteredOperationPrecondition`, the
same kernel entry point the gateway and `prepareMutation` call, over images
built from the compiled enum option ids. Four transitions by four states is a
full truth table.

ADR-0050 §7's two owed controls ship together — a permission mismatch is refused
by name (`COMPILER_TRANSITION_PERMISSION_MISMATCH`) and the matched case still
compiles — because the first alone is satisfiable by refusing every transition.

### The negative-control run — each committed control dies alone

Mutating the SUBJECT and re-running the suite:

| Mutation (one property) | Reds |
|---|---|
| header guard reduced to the charter's single `not(released)` | 1 — the guard test |
| line relation `parentScopedChild` → `reference` | 1 — the parent-guard test |
| form regains the inert `activity` slot | 1 — the anatomy test |
| state field removed from every query selection | 1 — the read-path test |
| `received_quantity` authored on the line | 2 — the scope test and the caller-writable test |
| cancel departs from `draft` | 3 — lifecycle, compiled effect, command matrix |
| `stateMachines` retired entirely | 24 — the module-level subject-absent case |

The read-path mutation initially reddened three tests, because two controls
required the exact refusal PAIR and the second code only appears while the read
path exists. Corrected: the locality code is admitted but not required, any
third code still reds, and the mutation now dies alone.

Band B — surfaces, form anatomy, labels, list behaviour, mount. One
discriminating red per claim. **Vacuity vectors not individually controlled, and
why:** the RENDERED outcome of these declarations — that a `commandBar` slot
draws a Release button, and that ADR-0056's precedence orders it before Cancel —
is observed by `apps/web/test/browser/**`, not by the definition layer. This
packet controls the declaration each of those reads. A Band B failure here is
visible the first time an operator opens the form, which is the standard
`review-tiers` sets for that band.

## Lease

Three files outside the declared lease were edited, named here so they can be
revoked rather than discovered:

| File | Why forced | Held on branch by |
|---|---|---|
| `package.json` | `test:unit` names its files explicitly; a new `test/unit` file is unreachable until listed, and AGENTS.md §6 requires every `*.test.ts` be proven reachable | `packet/expected-red-gate` |
| `test/architecture/repository-hygiene.test.ts` | the reviewed suite inventory, same rule | `packet/record-claim-fidelity` |
| `test/architecture/module-press-law.test.ts` | `checkModulePressLaw` AUTO-DISCOVERS module directories, so a new module moves `moduleDirectories` and `modulesRead` with no edit possible to avoid it; and the routed `conformance.ts` debt shifted 2364 → 2371 because the family rows land above it | `packet/press-law-splice` |
| `test/helpers/reachability-producers.ts` | the THIRD suite inventory, which `check:reachability` reads. Missed on the first pass and caught by re-reading the `dev-environment` row, which records registering its own test file "in all three inventories". Measured unheld by the empirical disjointness check | none |

**Four, not three, and the fourth is the point of the open `suite-inventory-copies`
row:** a suite's file list is written by hand in three places and
`repository-hygiene` compares only two, so the third is caught by reading a
ledger row rather than by any gate.

Each is additive and mechanical — one array entry, one list entry, one line
number, one count — and none changes what those gates ASSERT. They were taken
rather than stopped on because the lease grants `test/unit/**` and a test file
that cannot be run is not a test. **The orchestrator's call, not the lane's.**

## R13 becomes visible on a new surface, and this packet does not fix it

The charter says *"do not fix R13 here; do not inherit it either."* The pattern
is not inherited — release, close, reopen and cancel take the operation path
ADR-0051 settled, and `renderCommandBar` evaluates each command's compiled
precondition against the record before offering it. **But mounting Purchasing
makes the open finding visible on a surface that did not exist before**, and
that is worth stating rather than leaving for an operator to find.

`renderLifecycleForm` (`apps/web/src/component-registry.ts`, re-locate by
symbol) picks its intent as `record.archived ? 'restore' : 'archive'` and never
consults the operation's precondition. So on a `released`, `closed` or
`cancelled` purchase order, **"More actions → Archive" renders and the press
fails** with `MODULE_OPERATION_PRECONDITION_REFUSED` — the archive operation
carries the same three-term guard as the other three generic operations, and the
interpreter enforces it correctly.

**Edit is not affected**: the command bar's Edit link is gated by
`operationAvailableForRecord(update, record)`, which does evaluate the
precondition, so it correctly disappears once an order leaves `draft`. The
defect is confined to the archive/restore overflow.

This is a **new instance of an existing open row**, not a new defect and not a
regression introduced here — every module with a terminal-state guard already
has it, `stock_count` included. It is named so the R13 row can record that
mounting a guarded document is what makes it operator-visible.

## What this lane did NOT verify

- **Anything requiring a running database or browser at the time of writing.**
  Another lane held the machine with a full `run-matrix.sh redgate` in a
  detached worktree throughout this packet's development; the gate results below
  are whatever the queued run reports.
- **That the parent-aggregate rule actually refuses a line mutation at runtime.**
  The unit test asserts both halves of the mechanism — the relation is
  `parentScopedChild`/`required`/`restrict`, and exactly one active
  `updateRecordEffect` targets `purchase_order` carrying the header guard — but
  it REPLICATES `parentGuardsFromCatalog`'s derivation rather than calling it.
  That is a proxy. The runtime fact belongs to `test:postgres`.
- **That the command bar renders Release before Cancel, or renders them at all.**
  ADR-0056's precedence and `operationLabel`'s derivation both live in
  `apps/web`, which this packet does not touch. Only the operation-id suffixes
  they read are controlled here.
- **Whether `close` and `reopen` land in a sensible position in the command
  bar.** ADR-0056 ranks `release` 0, `cancel` 2 and everything else 1, so they
  fall between — asserted nowhere.
- **The `humanRequired` confirmation on cancel end to end.** Only the declaration
  is controlled.
- **Purchasing's release verification against real PostgreSQL**, which is where
  ADR-0050 §6 item 2 is finally settled rather than merely structurally closed.
- **Whether `supplier_party_id` and `item_id` should be relations rather than
  text.** They are text, as the parked lane had them, because a cross-module
  relation would not resolve in the standalone purchasing package. Stated as a
  limitation, not defended as a design.
