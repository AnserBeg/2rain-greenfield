# PUR-1 — the purchase order document, and the first declared state machine

Date: 2026-08-22

Base: cut from `e8be8c31c286d92816146d595ef3e9114496208f`; rebased onto
`4780efc3dd65e0bae5bdcc0088b041ec8c68e2c4` (`origin/main`) before freezing, which
brought in the two `docs(purchasing)` commits that added plan §7.17.

Branch: `packet/pur-1-v2` — **not** `packet/pur-1`, which is 430 commits behind
and was read as REFERENCE only.

Tier: Critical

Status: **evidence ready — round 2.**

**Gate SHA: `3162356fc0d91e6a40fa67ec40ad92d890e425ac`.** All five suites green,
**zero reds, first run**: `test:unit` 155 · `test:compiler` 152 ·
`test:integration` 149 · `test:architecture` 178 · `test:postgres` 205, plus
`typecheck`, `lint`, `format`, `check:app-release`, `check:demo-release` and
`check:boundaries`.

The freeze SHA is the branch tip, which adds narrative only. Every commit after
the gate SHA touches `docs/` alone, so the tip's executable content is identical
— verify rather than take it:

```
git diff --name-only 3162356 <tip> -- . \
  ':!docs' ':!.agents' ':!CLAUDE.md' ':!AGENTS.md' ':!learnings.md'
```

**Round 1 (`a052965`) returned REVISE with three blocking findings. All three
were upheld; none was argued down.** See the round-1 section below. The prior
review is void — new SHA, fresh review.

Rebased onto `origin/main` after `main` moved 96 commits (`expected-red-gate`
and `press-law-splice` both integrated); the release lineage was rebuilt from
main's 13-entry head so the packet still mints exactly one.

## Goal

`purchase_order` + `purchase_order_line`: create and edit while draft, release,
cancel, browse. No inventory movement — nothing posts, nothing touches stock.

**Precisely what is operable, because an earlier version of this Goal said
"release, close, reopen, cancel" and that was wrong:** a four-state vocabulary
(`draft`, `released`, `closed`, `cancelled`) and **five declared transitions, of
which THREE are operable** — `release`, and a `cancel` from each of `draft` and
`released`. **`close` and `reopen` are declared edges with no operation**, and a
committed control fails if anything binds one. `closed` is therefore declared
and unreachable in this release, deliberately.

**Not delivered, and owed a ruling:** the post-draft amend operation plan §7.17
assigns to `PUR-1`. See Stop 1 — it is not expressible in this lease, and
proving the plan's premise wrong is not the same as amending the plan.

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
order's four states and five transitions with the three that are refused. `SAL-1`
and `PUR-2` both inherit it.

`0059` was chosen after enumerating ADR numbers across every branch, not just
`main`: `0058` is taken on `packet/expected-red-gate`. That is `lanes.md`'s
ADR-number-collision row applied.

## Rulings

### 1. The lifecycle is declared in full, including the parts this packet cannot drive

```
                    release                cancel
          draft ---------------> released ---------------> cancelled
            |                     |    ^                       ^
            |               close |    | reopen                 |
            |                     v    |                        |
            |                     closed                        |
            |                                                   |
            +---------------------- cancel ---------------------+
```

Four states, five transitions, four permissions. Refused and asserted absent:
`released → draft` (draft asserts no commitments exist, and once released,
receipts may), `closed → cancelled` (reopen first), and `cancelled → anything`
(terminal; reissue instead).

**Cancel departs from two states, so it is two transitions and two operations.**
`transitionStateEffect` carries exactly one `transition` reference, so there is
no spelling in which one operation reaches both. **An earlier commit in this
packet shipped only the released-side cancel** on the argument that a draft's
exit is the generic ARCHIVE; that was wrong and plan §7.17's table was right.
ARCHIVE is a lifecycle fact (`archived_at`, hidden from read-backs); `cancelled`
is a business state that stays reportable. They are not substitutes. The lane
raised the conflict rather than improvising, and the user ruled for the plan.

Both operation ids end in `_cancel` deliberately — ADR-0056 ranks on the final
verb and `operationLabel` derives the button text from it, so each presents as
"Cancel". They can never be offered together, because their preconditions are
disjoint, and ADR-0051 made the write path address an operation by id, so two
commands sharing a label post different operations correctly.

Both authorize on one `purchase_order_cancel` permission: ADR-0050 §7's equality
rule is per operation/transition pair, and §7 warns against buying a second
authorization decision in advance of a shape that needs one.

**Declaring the whole door at once was not a preference, and the cost was
measured rather than argued.** An earlier commit shipped a three-state machine
and minted lineage entry 14. Adding `closed` afterwards raised

```
COMPILER_STORAGE_RETYPE_UNSUPPORTED
  $.fields.fieldType
  northstar.app:derived_state_field.machine.purchase_order_lifecycle
  "v1 storage transitions do not retype existing physical columns"
```

The premature entry was discarded, the lineage rebuilt from the accepted
13-entry head, and this packet mints exactly one. **Every state added after this
release is a normalization event and a lineage entry of its own.** Adding the
fifth TRANSITION later did not retype the column — states retype, transitions do
not — but it still moved the normalized bytes and the release root, so the
lineage was rebuilt from the accepted head a second time for the same reason.

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

## Two corrections owed to the plan, and one decision owed BEFORE freeze

`main` moved two commits under this packet while it was in flight — `1aae9d8`
and `4780efc`, both `docs(purchasing)`, adding §7.17 to the plan. §7.17 is the
ruling the bridge instruction relayed, and reading it directly rather than
through the relay surfaces two things the lane cannot settle for itself.

### A. §7.17's `writableFieldIds` claim is measurably false, and it is load-bearing

§7.17 rules the amend admissible on this basis:

> `packages/compiler/src/projections.ts:1191` derives `writableFieldIds` from
> the operation's own declared `fields`, all-or-nothing per operation. **So a
> named amend operation whose `fields` is the quantity alone yields
> `writableFieldIds` of exactly that quantity.**

**`operationDefinition` has no `fields` member.** It is a `z.strictObject`
carrying exactly `confirmation`, `effect`, `kind`, `lifecycle`, `module`,
`operationId`, `permission`, `precondition`, `readBack`, `schemaVersion` and
`tier`. There is nothing for an author to declare. `operationInputContract`
receives `fieldsByEntity.get(operation.effect.entity.targetId)` — the ENTITY's
whole active field set, minus materialized state fields — and `writableFieldIds`
is `fields.map(f => f.fieldId).sort()` over that.

"All-or-nothing per operation" is right; it is all-of-the-entity or nothing.
Evidence beyond this lane's probe: the shipped `advance_period_lock` and
`reopen_period` operations on `inventory_period_lock` compile to identical
writable sets. That entity has one writable field, which is why the pattern
reads narrow.

**`PUR-2` inherits this section as a ratified plan ruling and will build against
it.** The plan is the program authority and outside this packet's owned paths,
so the correction is reported rather than made.

### B. The plan and the bridge disagreed on `draft → cancelled` — RESOLVED for the plan

| Source | `draft → cancelled` |
|---|---|
| plan §7.17's table (`:713`) | **yes** — *"`draft → cancelled` · `released → cancelled` — abandoning an order is ordinary"* |
| the bridge instruction's table | not listed, and it endorsed the opposite: *"Keep your cancel-departs-from-released reasoning — it is sound and the generic archive still owns a draft's exit."* |

The lane shipped one cancel, raised the conflict rather than resolving it, and
**the user ruled for the plan.** Both cancels now ship. The lane's own reasoning
was wrong for the reason it had already suspected: ARCHIVE is a lifecycle fact
and `cancelled` is a business state, so they are not substitutes.

Recorded because the mechanism worked and is worth repeating: `AGENTS.md` §1
says a conflict with the plan is surfaced rather than resolved by the lane, and
ADR-0059 made getting it wrong cost a lineage entry. Raising it cost one round
trip; discovering it after acceptance would have cost a release.

**AND THE ROUTING IS NOT YET AUTHORISED — review round 2, upheld.** Plan §7.17
says the post-close editing requirement *"changes `PUR-1` rather than a later
packet"*. The three measurements above prove the plan's IMPLEMENTATION PREMISE
is wrong; **they do not amend the plan.** Stop 2 carries a direct user ruling.
Stop 1 carries only the lane saying "routed to `PUR-2`", which is the lane
resolving a plan conflict on its own authority — exactly what `AGENTS.md` §1
forbids. ADR-0059 cannot supply it either: it is `proposed`, and it decides
lifecycle width rather than packet ownership of the amend.

**What is owed, from the user or the orchestrator, before this packet can be
accepted under its own identity:** an explicit ruling that `PUR-1` is accepted
without post-draft quantity amendment, that the carrier and the amend operation
move to `PUR-2`, and that §7.17, the queue row and this record are amended to
say so. Until that exists, this is a partial implementation carrying the
original packet identity as though the obligation were complete.

Stop count for this packet: **2**. Stop 2 is settled by user ruling. Stop 1 is
NOT settled — it is measured, reported, and awaiting the ruling above.

## Review round 2 — REVISE, and the authority gap it named

Reviewed at `08fcaf1`. Round 1's three findings were confirmed materially
addressed and **no new defect was found in the lifecycle implementation or the
registry refactor.** Three items remained.

**Finding 2 (Critical evidence gap) — the vertical did not cover `restore`.**
Upheld and fixed. The test claimed *"every line mutation"* while never invoking
`purchase_order_line_restore`, which is a distinct generic operation reaching a
distinct interpreter branch — so the claim exceeded the evidence, and the
reviewer named the exact survivor: archive a line while the parent is draft,
release, delete only the `requireExistingParentGuards` call from the
`restoreRecordEffect` branch, restore. The vertical now archives a second line
as its own admission twin, requires typed refusal on restore after release, and
reads BOTH rows back. **The named mutation was run against production:
`Missing expected rejection.`, and the control died alone.** Production reverted
untouched.

**Finding 3 (Major) — the active queue row was stale and self-contradicting.**
Upheld and fixed. It said the packet ships *"release/close/reopen/cancel"* when
close and reopen have no operation, and said six out-of-lease files in one
sentence and three in another. `current-plan.md` is what `PUR-2` reads to learn
what exists, so a row claiming close/reopen shipped is worse than a wrong
number. The Goal above carried the same error and is corrected too.

**The evidence-count correction is upheld and it was the lane's error.** The
round-2 review prompt said the ADR-0033 partition closes at *"205 + 47"*. `205`
is the number of TESTS in the PostgreSQL suite; the partition is **151 executed
+ 47 derived = 198 planned scenarios**. The checked-in record said this
correctly throughout — only the lane-written prompt conflated the two, and a
prompt that misstates a count invites a reviewer to verify the wrong identity.

**Finding 1 is not the lane's to close.** See Stop 1 immediately below.

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
every collection, with exactly 2 assertions, 2 entities, 10 fields, 13
operations, 14 permissions, 8 queries, 1 state machine, 1 relation, 2 storage
mappings, 6 surfaces and 1 module added. The "deleted" lines in the raw diff
are alignment artifacts; the member-by-member comparison is the measurement.

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
built from the compiled enum option ids. The command matrix is the three DRIVEN transitions against all four states,
plus a separate control proving the two declared-only edges are invocable by
nothing.

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

## Review round 1 — REVISE, three blocking findings, all correct

Reviewed at `a052965`. **Every finding was upheld and none was argued down.**

### Finding 1 (Critical) — `close` and `reopen` were ACTIVE operations

The transition table mapped every row into an operation, so `released → closed`
and `closed → released` were executable through the semantic operation gateway
with no receipt rule, no open-to-receive calculation and no `PUR-2` mechanism
behind them. **ADR-0059 said three of four states were presently producible;
the code made all four producible.** The ADR contradicted its own
implementation, which is precisely the defect class this programme keeps filing.

The reviewer's distinction is the right one: **a state names a DESTINATION; an
active transition operation grants a PRESENT BEHAVIOUR**, and the retype
measurement prices only the first. Measured in response:

| change to an already-materialized machine | result |
|---|---|
| add a **state** | `COMPILER_STORAGE_RETYPE_UNSUPPORTED` |
| add a **transition** | compiles, **no retype** |
| declare a transition no operation references | **compiles** |

Fixed: both edges stay declared, neither gets an operation, and two committed
controls prove the edges exist while nothing can invoke them — one of which
binds an operation to `close` and requires the check to notice.

ADR-0059 narrowed accordingly: states forced by measurement, transitions a
product choice, operations only where this packet can supply semantics.

### Finding 2 (Critical evidence gap) — the parent-aggregate rule was a proxy

Upheld. The lane had flagged it itself, and the reviewer correctly said that is
not sufficient for a Band A claim about a stored-value boundary.

Fixed with a real PostgreSQL vertical, and it carries the admission twin the
reviewer asked for. **Its discriminating mutation was run:** changing the
relation to `ownership: 'reference'` makes the post-release line update
**succeed**, and the control reds with *"Missing expected rejection"* — alone,
no other test moved. The guard is therefore observed rather than replicated.

### Finding 3 (Major) — the builder registry refactor was not performed

Upheld, and the miss is the lane's. Plan §7.2 assigns the refactor to *"the
first packet that mounts anything"* and §7.5's `PUR-1` row repeats it. **The
charter told the lane to update the tuple, the guard, the error string, the map
array and the capability loop — i.e. to do exactly what the plan says to stop
doing — and the lane followed the charter without checking it against the plan.**
`AGENTS.md` §1 puts the plan first.

Fixed: one ordered `MODULE_REGISTRY`; instantiation, ordering, capability
consistency and count all derive from it. Verified a pure refactor — the
regenerated artifact differs from the reviewed one **only** by the two removed
operations, member-by-member across every collection.

### On the prompt-steering finding

Also upheld. The lane's reading list cited plan §§7.3, 7.7, 7.12 and 7.17 —
the sections it had read — and omitted §7.2 and the `PUR-1` row that carry the
builder obligation. **A reading list assembled from what the author consulted
reproduces the author's blind spot**, which is a sharper failure than the
disclaimer can offset. The round-2 prompt cites the plan generally and names
§7.2 explicitly.

## What `test:postgres` found, which nothing else could

The charter made `test:postgres` a required gate because the packet moves
release output. It earned that: four reds, two distinct causes, and **neither
was reachable from any compiler or unit gate.**

### 1. A text field shorter than about eight characters is non-deterministic under the release-verification prober

```
ReleaseVerificationIntegrityError
  VERIFICATION_SEARCH_EXCLUSION_FAILED
  excluded field value was searchable: northstar.app:field.purchase_order_currency
```

`verificationFieldValue` seeds every text field with `V-` plus a sha256 hex
digest **truncated to `maximumLength`**, and the search predicate is a SUBSTRING
match (`LIKE '%' || value || '%'`). At `maximumLength: 3` the generated value is
`V-<one hex char>` — a prefix, hence a substring, of every sibling text value on
the same record. It matches whenever a searchable sibling's digest happens to
start with the same hex character: roughly **one run in eight** with two
searchable siblings. At length 2 it would match every time.

**`purchase_order_currency` is the application's first text field below 32
characters**, which is why this has never fired. It is a platform weakness
rather than a property of currency, it is not this packet's to fix
(`packages/postgres-provider/**` is out of scope), and it is filed rather than
worked around.

`currency` is now `searchable: true`, which removes the scenario — and the
justification stands on the field's own nature rather than on the defect: a
currency code is a short, human-typed, controlled identifier of the same class as
`party_number`, `item_sku`, `location_code` and
`inventory_transaction_line_unit_id`, every one of which is searchable here.

Two of the four reds were this. A third —
*"a same-profile successor over one revision is not named a profile-only edge"* —
raised its `ReleaseVerificationIntegrityError` from the same `createRuntime`
call before reaching the rollback it was written to observe, so it is the same
cause seen from a third site.

### 3. The bounded-fresh-tenant-install evidence count, which is a pin rather than a defect

`assertBoundedFreshTenantInstallEvidence` pins the serving release's scenario
count. 174 → 198, and the 24 were enumerated from the compiled plan rather than
inferred: 12 `declaredEvidence`, 6 `searchableExclusion`, 2 `resolverAuthority`,
2 `typedErrorSurface`, 1 `uniquenessFold`, 1 `archiveRestrict`.

**The materialized state field contributes ZERO, and that absence is the
interesting half.** It is an enum on a searchable entity, so it would otherwise
mint an `enumReject` and a `searchableExclusion` — but both probe a field
THROUGH the create operation, and a machine's state field is structurally
excluded from that contract. This is ADR-0050 §6 item 2 visible in a number.

**And the ADR-0033 partition moved with it: executed 127 → 151, derivations
unchanged at 47.** All 24 purchasing scenarios EXECUTE and none is derived, so
the partition still closes — 151 + 47 = 198, exactly the planned count above,
as 127 + 47 = 174 was before this packet.

That every one is arrangeable is a fact about the module rather than an
accident. Inventory contributes derivations precisely because some of its
scenarios are emitted-but-unarrangeable; purchasing declares no operationless
entity, no provider-written read model, and no field a generic create cannot
populate. **The state field would have been the one exception, and it is not
emitted at all.**

### 4. The full-replay schema oracle, REGENERATED rather than edited

`assertBoundedInstallMatchesFullReplaySchema` compares the bounded fresh-tenant
install's `north_star_module` schema against
`test/postgres/fresh-tenant-full-replay-schema.snapshot.json`. It reported **987
added lines and zero removed** — the bounded install materializes purchasing's
two tables and the oracle did not know they exist. Traced through the compiled
storage target rather than guessed: `nsm_t_brja23…` is
`northstar.app:entity.purchase_order`.

**That file is a GENERATED oracle, not a pin, and hand-editing it would destroy
the property it exists to prove.** `test/helpers/generate-fresh-tenant-full-replay-schema.ts`
stands up an ephemeral PostgreSQL and activates every lineage entry from the
serving floor onward, one at a time, capturing the real schema that results —
an independent full replay, which is the whole content of ADR-0040's Control B.
It was run, exit 0.

Precedented: `stock-balance-read-model` regenerated the same artifact when it
added an entity.

**The regenerated oracle is verified PURELY ADDITIVE**, member-by-member across
all twenty collections: `relations` 21 → 23, `columns` 379 → 407, `indexes`
119 → 127, `policies` 49 → 57, `constraints` 156 → 162, privileges to match, and
**zero removals in every one.** The 94 "deleted" lines in the raw diff are
alignment artifacts.

### 2. Purchasing is `entityOwned`, so a release carrying it must carry Inventory

```
ModuleStorageMaterializationError
  LEGAL_ENTITY_MASTER_TARGET_INVALID
  expected one compiled legal-entity master, received 0
```

`createManagedTable` requires exactly one compiled legal-entity master for any
entity-owned table, and `legal_entity` is declared by the **Inventory** module.
`module-storage-transition.test.ts`'s ABI fixture builds a prior release as
*"the composed application without Inventory"* — which, after this packet, still
carries Purchasing. Before `PUR-1` that composition had **no entity-owned entity
at all**, so the check was never reached.

**This is the gate working, and it is a real architectural consequence of the
charter's `entityOwned` ruling that deserves recording:** Purchasing is now
coupled to Inventory at the storage layer, not merely at the file layer where
the family map lives. The same repair was already needed in
`surface-grammar-conformance.test.ts` for an unrelated reason (the navigation
budget), so two independent fixtures now strip Purchasing to stay valid. **A
third will appear.**

## Lease

SEVEN files outside the declared lease were edited, named here so they can be
revoked rather than discovered. **They are not all "additive" and the earlier
version of this section wrongly said they were** — the classification column
says what each actually is:

| File | Kind | Why forced | Held on branch by |
|---|---|---|---|
| `package.json` | additive pin | `test:unit` names its files explicitly; a new `test/unit` file is unreachable until listed, and AGENTS.md §6 requires every `*.test.ts` be proven reachable | `packet/expected-red-gate` |
| `test/architecture/repository-hygiene.test.ts` | additive pin | the reviewed suite inventory, same rule | `packet/record-claim-fidelity` |
| `test/architecture/module-press-law.test.ts` | **moved expectations** — a count and eight line numbers | `checkModulePressLaw` AUTO-DISCOVERS module directories, so a new module moves `moduleDirectories` and `modulesRead` with no edit possible to avoid it; and the routed `conformance.ts` debt shifted 2364 → 2371 because the family rows land above it | `packet/press-law-splice` |
| `test/helpers/reachability-producers.ts` | additive pin | the THIRD suite inventory, which `check:reachability` reads. Missed on the first pass and caught by re-reading the `dev-environment` row, which records registering its own test file "in all three inventories". Measured unheld | none |
| `packages/dev-tooling/src/predicate-dispatch-tripwire/index.ts` | additive registration | the tripwire flags any file mentioning three or more distinct predicate kinds. A definition file CONSTRUCTS predicates rather than dispatching on them, and the heuristic cannot tell the two apart — `inventory/definition.ts` is registered for the same reason. Authoring the editing guard at all trips it | none |
| `test/postgres/module-storage-transition.test.ts` | **scope-preserving fixture correction** — adds a removal helper and strips Purchasing from the prior release; not a one-entry edit | its ABI fixture builds "the composed application without Inventory", which after this packet still carries Purchasing and therefore fails `LEGAL_ENTITY_MASTER_TARGET_INVALID`. See the `test:postgres` findings above | none |
| `test/postgres/fresh-tenant-full-replay-schema.snapshot.json` | **regenerated oracle** — logically additive member-wise across all twenty collections; its TEXTUAL diff is not | **regenerated, not edited** — a generated full-replay oracle whose own generator was run. Same category as `apps/web/release/**`, which the lease already grants as regenerated | none |

**Seven, not three, and every one after the first three was found by a gate
rather than by reading the charter.** Four are hand-written registries a new
module must be added to, and no single place lists them — the
`suite-inventory-copies` row names three of those four and the predicate
tripwire is a fourth of the same shape. The seventh is a GENERATED oracle
re-produced by its own generator, which is the `apps/web/release/**` category
the lease already grants.

**Four are additive pins.** One moves expectations (a count and eight line
numbers, all read from the tool rather than computed). One is a fixture
correction that adds a helper. One is a regenerated oracle. **None changes what
its gate ASSERTS**, and that is the property that matters — but calling all
seven "additive" was wrong and review caught it. They were taken
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

**Corrected after review round 1, which found this section contradicting the
evidence section.** It previously said purchasing's release verification against
real PostgreSQL was unverified, while the evidence section reported that same
verification discovering the short-text defect and moving the ADR-0033 partition.
Both could not stand. **Release verification IS executed** — that is where the
currency defect surfaced. The unverified fact was the parent-line mutation
refusal, and **it is no longer unverified either**: round 2 added the runtime
vertical.

- **The rendered browser surface.** `test:browser` was not run by this lane at
  any point.
- **That the command bar renders Release before Cancel, or renders them at all.**
  ADR-0056's precedence and `operationLabel`'s derivation both live in
  `apps/web`, which this packet does not touch. Only the operation-id suffixes
  they read are controlled here.
- **Nothing about `close` and `reopen` at runtime**, because neither has an
  operation. They are declared edges; a committed control proves nothing can
  invoke them.
- **The `humanRequired` confirmation on either cancel, end to end.** Only the
  declaration is controlled. The PostgreSQL vertical does exercise a
  confirmation grant, but on `purchase_order_line_archive` rather than a
  cancel.
- **Whether `supplier_party_id` and `item_id` should be relations rather than
  text.** They are text, as the parked lane had them, because a cross-module
  relation would not resolve in the standalone purchasing package. Stated as a
  limitation, not defended as a design.
