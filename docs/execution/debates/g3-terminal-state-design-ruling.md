<!--
Design ruling for queue row `5g3-term`, produced 2026-07-30 by a read-only
Fable design lane under an explicit no-implementation charter.

Adopted by the orchestrator after independently re-verifying its load-bearing
claims: the precondition spelling in `schemas.ts`, the `reject-operation`
profile at `predicate-kernel.ts:182`, the one-argument kernel fence at
`semantic-operation-gateway.ts:513-536`, and the `derivedStateFields` merge at
`module-storage-materializer.ts:4255-4259` that corrects an earlier
orchestrator error.

Two things this ruling changed rather than confirmed:
  - Option B was refuted on its own premise. `periodLockOperations` is generic
    press execution, not capability routing.
  - The orchestrator's claim that the materializer discards derived state
    fields on compatible merge was wrong.
-->

All verification is complete — every load-bearing claim checked against the landing branch, the composed app, the kernel, and the sibling branches. Here is the full deliverable.

---

# 5g3-term — Design ruling: terminal-state operation preconditions

**Outcome up front:** The defect is real and confirmed at every cited line, with **one evidence correction** (the materializer merge-path claim is wrong in a way that does not weaken the defect). The ruling is **Option A**, in a sharper form than the prompt sketched: the mechanism is not a new concept and not the `stateMachines` concept — it is the **already-canonical, already-ruled, never-evaluated `operationDefinition.precondition`**, plus one generic parent-aggregate rule. No canonical language version event. No migration. ADR-0034 requested.

---

## 1. Verification

Line numbers cite `packet/g3-p4b-v2` (the landing branch, head `f6b7463`) for files G3-P4b touches, and this worktree (`packet/g3-p6a`, `d4de157`) for everything else.

**Confirmed:**

- **`stock_count.state` is an ordinary enumeration** over `draft | counting | reviewed | posted` — p4b-v2 `packages/domain/src/inventory/definition.ts:418-423`. `stock_count` and `stock_count_line` sit in `standardEntities` (`definition.ts:146-147`), and `definition.ts:694-697` routes every standard entity except `inventory_period_lock` through the generic `operations()` helper, which emits **create, update, archive, restore** (`definition.ts:981-992`). So the press admits UPDATE of posted evidence (including `state` `posted → draft`) and ARCHIVE of posted lines.
- **`posted` is terminal evidence.** ADR-0017 ("Capture the inputs. Compute nothing.", `docs/decisions/ADR-0017-cost-capture-without-valuation.md:35`) and ADR-0029 (p4b-v2, `docs/decisions/ADR-0029-inventory-stock-count-correction-posting.md`) make the posted session + lines the persisted inputs justifying immutable movements; corrections **append** superseding sessions, never mutate.
- **Inventory is unmounted.** The composed application is party + catalog + location only (`packages/domain/src/app/builder.ts:30-39`), and mounting merges `operations` into the release (`builder.ts:88` region), which the runtime view loads as the `operationCatalogPayload` (`packages/postgres-provider/src/request-runtime-view-service.ts:160-163`) — so mounting registers the operations regardless of UI. The `readOnly` flag claim also confirmed: it gates permissions (p4b-v2 `definition.ts:1099-1102`) and form surfaces (`:1117-1129`), and count entities are registered **not** read-only (`:796-803`, `f6b7463` "register stock count surfaces") — so nothing above the press closes the hole.
- **Escape 1 (appendOnly) closed correctly.** p4b-v2 `packages/compiler/src/conformance.ts:1291-1299`: `appendOnly` + any operation effect → `COMPILER_DESTRUCTIVE_OPERATION_UNSUPPORTED`. And `:1300-1312` shows the reverse ratchet: a non-appendOnly, non-period-lock entity **must** declare all four generic effects — relevant to Option B below.
- **Escape 2 (stateMachines) — "compiled but not enforced" confirmed.** `packages/compiler/src/storage.ts:750-773` turns a machine into a `derivedStateFields` column carrying `stateMachineId`; `packages/runtime/src/**` contains **zero** references to `derivedStateFields` or `stateMachine` (verified with per-file counts, all 0). Every first-party module declares `stateMachines: []` — the concept has zero users.
- **Escape 3 (special-casing) ban confirmed** — ADR-0011 lines 8 and 341 ("No module-specific Q0/O0 handler, SQL, route, tool, kernel branch, or registry"), restated as binding in G3-P4b's own record ("No partial inventory-specific runtime guard is admitted", p4b-v2 `docs/execution/packets/G3-P4b.md:99`).
- **The packet record and queue row** — the post-posting-hole section and the completeness ruling this packet also owes are at p4b-v2 `G3-P4b.md:85-108`; row `5g3-term` is on **main** `docs/execution/current-plan.md:221` (it is absent from this stale branch copy — trivial). The posting capability "accepts only an already-persisted reviewed session and complete line set" — confirmed at `G3-P4b.md:87-90` and ADR-0029's Decision section. Dependency-set v4 declares `transition:northstar.inventory:stock_count.state` (ADR-0029, v4 event section; pinned roots recomputed at p4b-v2 `conformance.ts:2505-2547`).
- **`LEGAL_ENTITY_FAMILY_RULES`** lives in `conformance.ts:40` with zero occurrences in `packages/canonical-model/` — the pinned-contract pattern is real, and the storage-discipline pins (`resolvePinnedInventoryFactStorage` / `resolvePinnedInventoryPeriodLockStorage`, p4b-v2 `conformance.ts:623-657`) already work exactly this way.

**Corrected:**

- **The `module-storage-materializer.ts:4098-4107` claim is wrong.** `void _derivedStateFields` in `withoutAdditive` excludes derived state fields **only from the base-shape conflict comparison**, identically to columns, indexes, uniqueKeys, checkConstraints and foldedColumns — and `mergeCompatibleEntity` then **merges them into its return value** (`derivedStateFields: mergeNamed(prior.derivedStateFields, next.derivedStateFields, …)`, `module-storage-materializer.ts:4255-4259`). The materializer also actively consumes them (`:1309`, `:3111`, `:3963`). This is **not** the `abiFunctionChecks` silent-omission shape. The defect stands unchanged — the storage layer faithfully materializes what the runtime then never enforces — but the row's evidence sentence should be corrected when transcribed.
- **One refinement to Option B's framing:** `periodLockOperations` is **not** a capability-routing precedent. Those two operations carry ordinary `updateRecordEffect` (p4b-v2 `definition.ts:1016-1047`) and execute through the **same generic press** — they differ only in operation IDs, permissions, and confirmation. There is no entity today whose lifecycle is executed by a capability through any transport; ADR-0029's Boundaries explicitly withhold a transport route from the posting capability. This matters for the ruling.

---

## 2. The ruling: Option A — and the mechanism already half-exists

While verifying, I found that the platform already contains almost the entire Option A mechanism, canonical and ruled, with only the enforcement wiring missing:

1. **The spelling exists.** `operationDefinition.precondition` is a typed v3 `PredicateExpression` (`packages/canonical-model/src/schemas.ts:855-873`), normalized with a literal-`true` default (`normalize.ts:199-211`), type-checked against the target field — enum fields compare against text literals (`normalize.ts:1446-1455`, `:2209-2231`) — with query-parameter references explicitly rejected in this position (`:1456-1463`).
2. **The semantics are ruled.** `operationPrecondition` is a first-class predicate binding position whose position profile already fixes `falseDisposition: 'reject-operation'` with ADR-0021-total absence semantics (`packages/canonical-model/src/predicate-kernel.ts:148-187`). The kernel's two-argument mode already **evaluates** predicates, owning composition and absence while the caller resolves present-value comparisons (`predicate-kernel.ts:203-212, 252-292`).
3. **The data already flows to the runtime.** The compiler emits `precondition` into the `operationCatalogPayload` (`packages/compiler/src/projections.ts:400`), the view service loads it (`request-runtime-view-service.ts:160-163`), and `RegisteredOperationDefinition.precondition` reaches the gateway (`packages/runtime/src/semantic-operation-gateway.ts:82`, asserted at `:748`, `:771`).
4. **The only thing missing is evaluation.** The gateway calls the kernel in one-argument mode — the v0 fence that admits **only literal `true`** and refuses anything else with typed `SEMANTIC_OPERATION_PRECONDITION_UNSUPPORTED` (`semantic-operation-gateway.ts:513-536`). No component ever evaluates a precondition against a record. Note the safety property: an authored precondition today **fails closed**, never open.

**The ruling:** declare the terminal guard as an authored precondition on `stock_count`'s four generic operations, and make the generic press evaluate operation preconditions. Concretely:

- **Declaration** (existing v3 spelling, no grammar change): each of `stock_count_create/update/archive/restore` declares
  `precondition = notPredicate(fieldComparison(equals, stock_count.state, textValue("<namespace>:option.stock_count_state_posted")))` — the stored value is the option ID (`definition.ts:919-931`; the enum-domain constraint admits option IDs, `storage.ts:727-748`). The predicate language has no or-composition (only `notPredicate`), so the negative spelling is the only expressible form; its absent-operand edge (`not(equals)` over an absent field would pass) is unreachable because `state` is a required field, and the conformance pin below asserts that requiredness.
- **Evaluation semantics** (ADR-0034 rules this): the precondition must hold on **every record image the effect consumes or produces** — the candidate image for create, the prior **and** projected images for update, the prior image for archive/restore. This one rule closes, with a single declared predicate: mutating posted records (prior image), un-posting (`posted → draft`, prior image), **forging** posted state via press (`reviewed → posted` fails the projected image; create-with-`state=posted` fails the candidate image), and archiving posted evidence. The capability's own `reviewed → posted` transition is untouched — it is direct SQL inside `#post`, not a press operation, and remains the sole sanctioned writer per ADR-0026/0029.
- **The parent-aggregate rule** (generic, closes `stock_count_line` with zero line-level declarations): a mutating operation on an entity that is the source of an active `parentScopedChild` relation is a mutation of the parent aggregate, and must also satisfy **the parent entity's update-operation precondition** evaluated on the parent's current image. The line→session relation is `parentScopedChild, required` — declared at p4b-v2 `definition.ts:774-779` and **already pinned** by conformance (p4b-v2 `conformance.ts:958-964`). The interpreter has everything it needs: relation ownership and FK columns are in the storage payload it holds (`storage.ts:217-259`, ownership at `:1055`), the parent row is **already loaded** on child-create (`requireRelationTarget`, `module-runtime-interpreter.ts:513-530`), and the prior record supplies the parent ID otherwise. `reference`-ownership relations are deliberately exempt — a correction session **must** be able to reference a posted prior (`stock_count_supersedes` is `reference`).
- **Enforcement location:** the **generic interpreter is the authority** — it evaluates at `prepareMutation` (`module-runtime-interpreter.ts:303-345`), where the prior record is already loaded, below the API, module-blind, driven purely by compiled release data. The **compiler conformance pin is the ratchet**, not a second authority: a new pinned count-contract rule requires those exact preconditions (and `state` requiredness), so a definition that drops or weakens the guard fails compilation. The gateway keeps a **structural fence** (parse-admission; unparseable predicates still refuse `SEMANTIC_OPERATION_PRECONDITION_UNSUPPORTED`). **No database constraint or trigger**: it would bind the sanctioned capability writer, and compiled-DDL changes ride the storage payload and materializer — a payload version event and G3-P6a's files — for no added authority. Defence in depth is the pin plus the capability's already-landed digest recheck.
- **The `stateMachines` concept is neither extended nor adopted.** Its `stateField` is **derived by normalization from the machineId** (`normalize.ts:299-302`, `:1681-1689`; stripped from authored form at `:427-428`) — it cannot bind G3-P4b's authored `state` field without changing normalization rules, which is precisely ADR-0029's stated line for a canonical-language event. Adopting it would mean a second state column or a rework of G3-P4b's landed storage, digest evidence, and contract. It stays compiled-and-unenforced with zero declarations. **Routed observation for the orchestrator:** that concept is now a proven member of this program's worst defect class — compiled but unenforced — and deserves its own enforce-or-retire row; this packet must not silently absorb that decision.
- **The completeness ruling G3-P4b routed here** (`G3-P4b.md:101-108`): draft authoring **remains the lifecycle-restricted generic press**. Draft/counting/reviewed sessions stay editable through the operations G3-P4b already declared and surfaced; posted is unreachable and untouchable through the press. No capability-owned authoring path is required before `5g3-ui` integrates.

**Why not B, and what A gives up.** B's premise — "no new runtime mechanism" — is false twice over: the period-lock precedent is generic-press execution, not capability routing (§1 correction), and ADR-0029 withholds a transport route from the posting capability, so B needs new invocation plumbing before anything can author a draft. B must then build the entire draft lifecycle as bespoke capability commands (create/edit session, add/edit/remove lines, review), duplicating what the press provides free — permissions, receipts, trust writes, read-backs — while a conformance carve-out (a third class beside `appendOnly` and `periodLockStorage`, `conformance.ts:1300-1312`) and the deletion of G3-P4b's just-registered count surfaces rework a packet that is mid-landing. Dependency-set v4 survives B (the capability's declared `transition` is unchanged), but B is strictly larger than A and grows linearly with every future module. **What choosing A forfeits:** B's single-writer purity — under A the press remains a legitimate writer for pre-posted phases, so pre-posting tampering is bounded by permissions plus the capability's validate-against-persisted digest rather than eliminated; and A's refusal correctness rests on the new evaluation wiring, which is why the controls in §5 are mutation-keyed rather than happy-path. **Generalization:** A is the generic answer — the second module with terminal evidence authors one predicate and one conformance pin, zero new mechanism, and the same lever expresses any record-state guard ("no edits once approved"), not just terminality. B is a per-module point fix forever. A is also this program's shape-of-record: the enforcement follows declared data through compiled projections into one generic interpreter, exactly ADR-0011.

---

## 3. Canonical language version event: **not required** — argued, not assumed

The test ADR-0029 itself applied: a language event is changing grammar or normalization rules. This design changes **neither**. The spelling (`operationDefinition.precondition`, v3 predicate), the normalization (default, comparison type-checking, scalar restriction), and — decisively — the **semantics of falsity in this position** (`falseDisposition: 'reject-operation'`, `predicate-kernel.ts:183`) are all already in the released language. What changes is runtime behavior only: widening a v0 execution **fence** to the evaluation mode the kernel already ships. That is Q1-P1's exact precedent — the query-filter fence admitted only literal `true` until lowering was built, and widening it was ruled a runtime capability event, not a language event (ledger, Q1-P1 row).

The counter-precedent the prompt warns about — the orchestrator wrongly assuming `LEGAL_ENTITY_FAMILY_RULES`-style pinning transferred to a runtime operand — is row 4 item (2) of `current-plan.md` (main): stock identity and `atTime` needed **typed `queryParameterDefinition`/`queryParameterReference` grammar**, discovered by Q1-P3a, because they are **per-request inputs** that must enter through a typed request slot that did not exist; pinning could not conjure the slot. That failure mode does not apply here on exactly that axis: there is **no per-request operand**. The precondition is release-static declared data, and its typed channel already exists end-to-end (schema → normalize → `operationCatalogPayload` → `RegisteredOperationDefinition.precondition` → kernel). Nothing is smuggled through a provider channel and no second authority is created: the domain definition declares, the compiler pins and transports, one generic runtime evaluates. Where q1-p4 needed new grammar, this packet needs a fence opened onto grammar that has been waiting behind it.

---

## 4. File-by-file implementation plan

**Sequencing constraint:** land **after G3-P4b integrates** (owns files 1–2) and **after G3-P5 integrates** (owns file 5), and **before G3-P6a integrates** — matching the binding gate in `G3-P4b.md:94-99`. Within the packet, the only fail-open partial order is gateway-widened-before-interpreter-evaluates; the commit order below forbids it. (Authored preconditions under the unwidened fence merely fail closed, and G3-P4b's fixtures seed count rows via SQL, not the press, so nothing existing breaks at any intermediate commit.)

1. `packages/domain/src/inventory/definition.ts` — **held by G3-P4b (landing)** — `operations()` (`:981`) gains an optional per-entity precondition argument; the factory passes the not-posted predicate for `stock_count` (namespace-interpolated option ID). ~15 lines.
2. `packages/postgres-provider/src/module-runtime-interpreter.ts` — **held by G3-P5; this packet rebases onto its landing** — the authority. In `prepareMutation` (`:303-345`): evaluate `definition.precondition` via `inspectPredicateForExecution(pred, {bindingPosition:'operationPrecondition', resolveComparison})` bound to the prior image (update/archive/restore) and the candidate/projected image (create/update); throw a new typed `failure('MODULE_OPERATION_PRECONDITION_REFUSED', …)`; a rejected kernel receipt throws the unsupported variant (fail-closed). Parent rule: on create, extend the `requireRelationTarget` pass (`:513-530`) to evaluate each `parentGuard` (below) against the loaded parent image; on update/archive/restore, resolve the parent ID from the prior record's relation column (`storage.relations`, ownership `parentScopedChild` only) and evaluate likewise. ~80 lines.
3. `packages/runtime/src/semantic-operation-gateway.ts` — **free** (only semantic-**query**-gateway is G3-P5's) — replace the one-arg fence at `:513-536` with parse-only structural admission (unparseable → existing `SEMANTIC_OPERATION_PRECONDITION_UNSUPPORTED` refusal, receipt still observed); map the interpreter's new refusal into a typed non-accepted result + receipt; compute `parentGuards` for the request — for the effect entity's active `parentScopedChild` source-relations, the parent entity's update-operation precondition + relationId, resolved from the pinned view — and pass them on `SemanticOperationExecutionRequest`. ~60 lines. **Must not merge before file 2.**
4. `packages/canonical-model/src/predicate-kernel.ts` — **free** — export a parse-only entry (structural admission without evaluation) beside `inspectPredicateForExecution` (`:259`). **No changes to `schemas.ts` or `normalize.ts` — that is the no-language-event invariant made visible in the diff.** ~20 lines.
5. `packages/compiler/src/conformance.ts` — **held by G3-P4b** — new pinned rule beside `validatePinnedInventoryCountEntity` (`:873`): `stock_count`'s four generic operations must declare exactly the pinned not-posted precondition; `state` must be pinned required; new diagnostic (e.g. `INVENTORY_TERMINAL_GUARD_MISSING`). ~60 lines.
6. `packages/postgres-provider/src/request-runtime-view-service.ts` — **free** — expected no-op (semanticModel + operation families already loaded, `:151-175`); touch only if the pinned view lacks a relations accessor for step 3 (then a small accessor in `packages/runtime/src/request-runtime-view.ts`, also free).
7. New tests — `test/postgres/inventory-terminal-state.test.ts` (new file, free) for controls C1–C7, C9–C10; conformance controls (C8) beside G3-P4b's count-contract compiler tests; kernel parse-entry unit tests.
8. `docs/decisions/ADR-0034-terminal-state-operation-preconditions.md` — new; plus orchestrator-owned execution records.

**Explicitly untouched, by design:** `module-storage-materializer.ts`, `apps/web/**`, `builder.ts` (G3-P6a's); `semantic-query-gateway.ts`, `release-verification-service.ts` (G3-P5's); `inventory-posting-service.ts` (G3-P4b's); `storage.ts`/`protocol.ts` (no payload version event); canonical schemas/normalization (no language event).

---

## 5. Controls, each with the victim whose deletion turns it red

Line anchors are current-tree; they will shift under G3-P5, so victims are named by function + purpose.

| # | Control | Victim line |
|---|---|---|
| C1 | Seed a **posted** session by SQL fixture (G3-P4b's pattern); press update of `expectedQuantity`/`state` through the **real gateway** refuses with `MODULE_OPERATION_PRECONDITION_REFUSED`, asserted **by code**, not by mere failure | the prior-image evaluation call added in `prepareMutation` beside the `loadRawRecord` at `module-runtime-interpreter.ts:317` |
| C2 | The identical update on a **`counting`** session **succeeds** — proves C1's refusal is state-keyed, not a blanket or misrouted refusal | the comparison-resolution binding (a resolver that always returns false makes C2 red) |
| C3 | Press update `reviewed → posted` refuses (projected image); press **create** with `state=posted` refuses (candidate image) — forgery closed | the projected/candidate-image evaluation branch, a **separate** victim from C1's prior-image branch |
| C4 | Archive of a posted session and restore of an archived posted line both refuse | the evaluation on the archive/restore preparation path (`module-runtime-interpreter.ts:331-337` region) |
| C5 | Press create of a `stock_count_line` under a posted session refuses | the parent-guard evaluation added in `requireRelationTarget` (`:513-530`) |
| C6 | Press update/archive of an **existing** line of a posted session refuses | the prior-record parent-ID resolution block (distinct from C5's create path) |
| C7 | Creating a correction session whose `supersedes` **references** a posted session still succeeds — proves the parent rule keys on `parentScopedChild` ownership only | the ownership filter in the gateway's `parentGuards` resolution (widening it to all relations turns C7 red) |
| C8 | A count definition with the precondition **removed**, and one comparing the **wrong option** (`draft`), each fail compilation with the new diagnostic | the new pinned rule block in `conformance.ts` |
| C9 | A registered operation carrying a kernel-unparseable precondition still refuses `SEMANTIC_OPERATION_PRECONDITION_UNSUPPORTED` | the gateway's parse-admission call replacing `semantic-operation-gateway.ts:513-536` |
| C10 | G3-P4b's full `postStockCount` suite stays green — the press guard must not leak into `#post`'s direct-SQL path | regression guard; no new victim |

C2 + C7 + C10 are the non-vacuity half the predecessor packet was sent back for missing: together they prove the refusal is keyed, scoped, and does not over-reach.

---

## 6. Ordinals

- **Migration: none needed, and I deliberately do not claim 0020.** No DDL, no receipt-shape change, no payload version event; enforcement is runtime evaluation of already-persisted release data, refusals ride the existing semantic-operation receipt path. (Verified free: no branch has an 0018 beyond G3-P7a's `0018_release_verification_derivations.sql`; 0019 is G3-P5's claim; no 0020 anywhere.)
- **ADR: request ADR-0034** — "Terminal-state operation preconditions" (ruling §2 + §3 above). Verified claims: 0029 = G3-P4b (on p4b-v2 and main), 0030 = compiled-navigation-grouping (main), 0031 on `packet/q1-p5-gateway`, 0033 on `packet/g3-p7a`, 0034 absent from every branch.

---

## 7. What I could not verify

- **Migration 0019 and ADR-0032**: `packet/g3-p5` predates authoring either (its `db/migrations` ends at 0016); both claims are taken from the prompt/plan, not observed on a branch.
- **The `abiFunctionChecks` incident record**: I located the identifier (`storage.ts`, materializer) but did not excavate the original finding; moot, since §1 shows `derivedStateFields` do not share its shape.
- **Enum literal membership validation**: `validateComparisonValue` maps enum→textValue (`normalize.ts:2223`); I did not read the full switch to confirm it also checks membership in the option set. C8's wrong-option control covers the gap either way.
- **Stored state values are option IDs**: inferred from the enum-domain constraint (`storage.ts:727-748`) and the posting service's `requiredEnumOption(stockCountState, 'posted')` contract resolution (p4b-v2 `inventory-posting-service.ts:1066`); I did not trace one INSERT parameter end-to-end.
- **G3-P5's exact interpreter diff**: unknowable from here; the plan's anchors in `prepareMutation`/`requireRelationTarget` may need mechanical rebasing, which is why victims are named by function.
- **The full `current-plan.md` row 4 text** was read from main; the Q1-P3a stop record itself (the operand incident's primary source) was not opened — the row's own account was sufficient to argue the distinction in §3.

**No stop is warranted:** the defect is real, Option A is right and smaller than the prompt feared, and the one corrected evidence line (§1) changes the record, not the packet.
