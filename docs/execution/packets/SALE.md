# SALE — usable sales-order intent through the governed product

Status: evidence_ready; draft PR handoff. Tier: Behavioral. Critical paths touched: none. Stops: 0.
Base: `c30e951f56f7ead4b2e3d9e228208dd639e5a461`.
Executable head: `66ac1cb5e267e6565d7753bad4fe14cbabd6a41a`.

## Claims

1. The composed application has a real **More → Sales → Sales order** entry and compiled list, detail and form surfaces for orders and parent-scoped lines.
2. An authorized local operator can create and edit a draft, add an exact-decimal line, release it, and cancel a draft or otherwise-unfulfilled released order through the ordinary operation forms and human confirmation.
3. Order updates are server-refused outside draft; line mutations inherit the order guard through the existing `parentScopedChild` runtime rule. Current revision checks and the installed audit path are reused unchanged.
4. Thirteen exact Sales permission contracts are governed by the installed current-policy evaluator. The explicit local/test role receives those grants; missing or revoked permission and foreign legal-entity scope both deny.
5. Sales-order operations declare no posting, inventory-movement, reservation or shipment effect. The browser journey compares all movement and posted-balance rows after every operation and observes byte-equal business snapshots.
6. The order uses existing party/item identifiers, exact-decimal quantity and price, unit code, currency, and the existing exactly-one legal-entity scope contract.

## Decisions

- This pass stops at order intent. Reservation allocation, shipment/posting/correction, shipped quantity, packing, invoicing, tax and payments remain future work.
- `released` is the accepted-order state requested by the owner; it does not mean allocated or reserved.
- Party and item are existing identifiers, matching accepted Purchasing. The selected demo values are proved to exist, but customer-role and item eligibility validation are not added in this increment.
- No migration is authored or rewritten. A disposable SALE database materializes the governed release; the receipt database and ports are untouched.
- Shared correctness-sensitive boundaries changed additively: the legal-entity family/relation contract and compiler mirror, composed builder/navigation, release lineage, and governed permission bindings. Posting kernel, AUTH evaluator, trust substrate, migrations and release activation logic are unchanged.
- The PostgreSQL composition correction changes tests and the generated full-replay schema oracle only; it changes no production or shared correctness-sensitive boundary.

## Slices

- Order intent: navigation, order/line forms, lifecycle, policy/scope refusal, and stock non-effect are delivered and exercised together because the checkpoint is the usable operator flow.

## Gates

- `pnpm format`, `pnpm typecheck`, `pnpm lint`, and `pnpm check:app-release`: PASS.
- `pnpm test:unit`: 163/163 PASS.
- `pnpm test:compiler`: 175/175 PASS. The added Sales compiler scenario reads
  emitted non-empty input fields and their refinements, exact operation
  effects, and the semantic effects of the pre-Sales → Sales storage
  transition.
- PostgreSQL CI run 34009435238 exposed three stale composition fixtures. The
  exact three-test filtered reproduction was 0/3 before correction; the two
  complete affected files then passed 39/39 under the exclusive test lock.
  The regenerated full-replay oracle was additive in every catalog collection
  (two tables, 30 columns, six constraints, nine indexes and eight policies;
  zero removals).
- `check:app-release`, focused Sales definition contracts (7/7), formatting,
  lint and typecheck: PASS. The focused Sales product browser smoke passed 1/1
  with quantity 10, unchanged-state permission denial, released-line refusal,
  permitted cancellation, foreign-scope denial and unchanged stock.
- `pnpm test:architecture`: 191/191 PASS after this record update; record checks also PASS.
- Focused composed-application navigation/form regressions: 2/2 PASS on their
  unchanged 20s/60s budgets. The navigation asserts the exact five primary
  entries, opens More, enumerates Purchasing and Sales, and reaches Purchase
  order through More → Purchasing; the existing form/relation-picker journey
  remains intact. The More-aware `--b500` focus-ring control also passes 1/1.
- Focused Playwright product journey: 1/1 PASS in 1.9 minutes. It created quantity 10, edited draft, observed stale-revision refusal, revoked update and observed unchanged state, released, observed server refusal of a line edit, confirmed cancellation, narrowed scope and observed foreign-scope denial, with stock unchanged throughout.
- `check:language-coverage`: PASS (2,050 obligations; 464 first-party
  observations) after the unit producer manifest was corrected to name the
  already-executed Sales definition test. This remains the gate's stated
  decision-bound result, not a claim that declarations are mutation execution.
- The first governed release build without the Sales bindings failed closed on all 13 unbound permissions; adding only the exact bindings made the release build pass. This is compile-time refusal evidence, not mutation execution.
- Isolated dev smoke: `COMPOSED_APPLICATION_READY` at port 4318, database port 55442, container `dev-sale-postgres`, release root `dad3d1fcfe1c209f97acca82c0c87a3243add27cef8bd3e254943706c0d5839d`; `dev-receipt-postgres` remained running.
- Full CI is required on the pushed draft-PR tip and its current status is reported in the handoff; no local focused run is presented as full-matrix acceptance.

## Test it yourself

From `/home/rvham/2rain-greenfield-sale`:

```sh
NORTH_STAR_DEV_DATABASE_CONTAINER=dev-sale-postgres NORTH_STAR_DATABASE_PORT=55442 PORT=4318 NORTH_STAR_TENANT_SLUG=local-sale corepack pnpm dev
```

1. Open `http://127.0.0.1:4318`, select the **DEFAULT** legal entity, then open **More → Sales → Sales order**.
2. Create an order using a unique number, customer party `71000000-0000-4000-8000-000000000001`, current ISO timestamps, and currency `CAD`.
3. Open the order, choose **Add line**, select the order, and enter line 1, item `71000000-0000-4000-8000-000000000011`, unit `EA`, ordered quantity `10`, and unit price `12.5`.
4. Edit the draft notes and save. Open the detail, choose **Release**, then try changing its line: the server refuses the update. Return to the order and choose **Cancel → Confirm Cancel**.
5. Stop with Ctrl-C. The lane container is stopped; the separate receipt demo is unaffected.

Reproduce the isolated governed browser journey:

```sh
corepack pnpm exec playwright test --config apps/web/playwright.config.ts --project=composed-application --no-deps sales-order.composed-application.spec.ts
```

## Remaining

- Released-line forms still render the generic Save control; submitting it is refused server-side and cannot mutate the line.
- Customer-role and item eligibility are not independently validated; ordinary forms accept existing identifiers, as Purchasing does today.
- No totals projection, availability promise, reservation, shipment, correction, packing or downstream financial document exists in this increment.
- Local-demo grants are development/test authorization, not production authentication. There is no external login, deployment, acceptance, main merge or self-approval claim.
- Program review is not due: this partial SALE increment is not a stage boundary.

Review: not owed — the final diff is outside the repository's current Critical set. The explicit owner instruction also forbids self-approval and main integration in this pass.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "SALE",
  "base": "c30e951f56f7ead4b2e3d9e228208dd639e5a461",
  "head": "66ac1cb5e267e6565d7753bad4fe14cbabd6a41a",
  "changedPaths": [
    "apps/api/src/composition-root.ts",
    "apps/web/package.json",
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/release/current-policy-bindings.json",
    "apps/web/src/component-registry.ts",
    "apps/web/src/sales-section.ts",
    "apps/web/test/browser/composed-application.spec.ts",
    "apps/web/test/browser/sales-order.composed-application.spec.ts",
    "package.json",
    "packages/compiler/src/conformance.ts",
    "packages/dev-tooling/src/predicate-dispatch-tripwire/index.ts",
    "packages/domain/src/app/builder.ts",
    "packages/domain/src/inventory/contracts.ts",
    "packages/domain/src/sales/definition.ts",
    "packages/domain/src/sales/index.ts",
    "test/architecture/module-press-law.test.ts",
    "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.baseline.ts",
    "test/architecture/surface-grammar-conformance.test.ts",
    "test/compiler/g2-module-conformance.test.ts",
    "test/compiler/inventory-contract.release.golden.json",
    "test/helpers/reachability-producers.ts",
    "test/postgres/composed-application.test.ts",
    "test/postgres/fresh-tenant-full-replay-schema.snapshot.json",
    "test/postgres/module-storage-transition.test.ts",
    "test/unit/purchasing-definition.test.ts",
    "test/unit/sales-definition.test.ts"
  ],
  "symbols": [
    { "path": "packages/domain/src/sales/definition.ts", "name": "SALES_IDS" },
    { "path": "packages/domain/src/sales/definition.ts", "name": "salesModuleDefinition" },
    { "path": "packages/domain/src/app/builder.ts", "name": "composedApplicationDefinition" },
    { "path": "apps/web/src/sales-section.ts", "name": "COMPOSED_APPLICATION_SURFACE_RUNTIME_EXTENSION" }
  ]
}
```
