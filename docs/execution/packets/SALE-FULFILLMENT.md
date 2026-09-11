# SALE-FULFILLMENT — reservation through shipment and correction

Status: accepted and integrated on `main` at `44bef7a36e5c0342671444595733ea725b4dd64b` (PR #4). Tier: Critical, Band A for stored reservation/shipped projections. Stops: 0.
Base: `4c058aa6487ae5196982e505fc82327f9e3d2ee6`. Reviewed candidate: `d8f8d644c634f368405aeb2e745b9c859ce54327`, integrated as the merge's second parent. All seven CI jobs passed in hosted run `34643875446`, attempt 2; the independent review is closed. The earlier executable head `9ba0f7fcebae31534bbabc8c41c30b09b7fba900` is superseded by the F1/F2/F3 corrections the arm required.

## Claims for the Critical review

1. Reserve rechecks the current active customer at execution, including orders created before the role exists.
2. Shipment posting rechecks that customer after acquiring canonical locks.
3. Reserve/release carries the caller's idempotency key into the trust transaction: exact retry replays, conflict refuses.
4. Adjustment, transfer and other stock reductions refuse a final on-hand quantity below live reservation coverage without replacing zero-coverage negative-stock policy.
5. Reservation admission enforces ordered minus net-shipped minus live-reserved across every location on the line.
6. Initial shipment accepts only selected live reservations and refuses over-consumption under contention.
7. Linked correction/reversal preserves original facts and never resurrects an explicitly released reservation; unexpected writes are refused before commit.
8. Reservation and shipped projections are independently reconstructed and quantity discrepancies are observed before scoped repair.

## Delivered business loop

- Registered reserve/release, shipment post, order cancel/close operations; exact decimal quantities and server-side scope, revision, party-role, item, location, base-unit, availability and order checks.
- One posting-kernel transaction commits movements, reservation consumption, order progress, immutable source links, idempotency, audit/change/event/outbox evidence and truthful committed/null read-back.
- Server read models provide on-hand/reserved/available and ordered/reserved/net-shipped/open-to-ship. The Sales composition supplies manual forms, confirmation, partial shipment, linked correction/reversal and a printable packing document from committed shipment facts.
- Automatic allocation, expiry and unreserved shipment are absent by design. Invoice, tax, payment, advanced pricing, agent and customization work remain out.

## Gates and controls

- `format`, `lint`, `typecheck`, `check:app-release`, `check:schema` (28 migrations), `check:boundaries` (190 files), unit 163/163, compiler 175/175, integration 150/150 and contracts 29/29: PASS.
- Architecture 191/191 PASS at the first executable checkpoint; the required narrative-tip rerun follows this record commit and belongs in the handoff result.
- Focused PostgreSQL fulfillment control PASS: competing reserve and ship each one winner; stale revision, shortage, cross-location excess, adjustment/transfer bypass, conflicting retry and released initial shipment refused; exact retry replayed; current customer required at reserve and ship; correction did not resurrect coverage; reconciliation was read-only and repair discrepancy-first.
- Eight SALE-FULFILLMENT expected-red mutations reproduced and restored: six in the first selected run, then correction and reconstruction after binding correction to the stronger pre-commit writer-verification refusal. Static gate: 137 live entries in 12 manifests. No inherited mutation population was rerun.
- Browser: fulfillment 1/1 PASS with `10/8/2 -> 5/3/2 -> 5/0/5`, packing, correction +2, reversal +3, cancellation and independent fully-shipped closure; retained SALE 1/1 and RECEIPT 1/1 PASS, including permission/scope refusal, revocation and withheld read-back.
- Existing inventory-posting file: every test except its first passed in the complete affected run; after correcting the zero-reservation guard, that first test passed focused. Inventory reconciliation 26/26 and migrations 9/9 PASS.
- Full pushed-tip CI is pending because the installed GitHub token can push this branch but GitHub refuses Pull Requests API access; no local subset is called acceptance.

## Test it yourself

```sh
cd /home/rvham/2rain-greenfield-sale-fulfillment
NORTH_STAR_DEV_DATABASE_CONTAINER=dev-sale-fulfillment-postgres NORTH_STAR_DATABASE_PORT=55443 PORT=4319 NORTH_STAR_TENANT_SLUG=local-sale-fulfillment corepack pnpm dev
```

Open `http://127.0.0.1:4319`, select DEFAULT, and use More → Inventory to post +10 EA. In More → Sales create/release an order line for 10, add an active customer Party role, reserve 8, post a shipment for 5, and release the remaining reservation. The detail rows must read `10/8/2`, `5/3/2`, then `5/0/5`; open the posted shipment and print its packing document. Create linked correction/reversal shipments from its committed movement, then cancel the net-zero order. Stop with Ctrl-C; this uses its own container and ports.

## Review and limits

Review is owed: one fresh naive online Critical arm, user-run, against the frozen executable SHA. No verdict, acceptance, merge, deployment, external login or production-authentication claim exists. Program review is not run mid-packet or before integration; evaluate the G4/stabilized-correctness trigger after this vertical is accepted.

Independent brief (22 lines):

```text
Repository: AnserBeg/2rain-greenfield
Branch: packet/SALE-FULFILLMENT
Base: 4c058aa6487ae5196982e505fc82327f9e3d2ee6
Frozen executable SHA: 9ba0f7fcebae31534bbabc8c41c30b09b7fba900
Question: is there a production-code defect under claims 1-8 above?
Read docs/architecture/posting-kernel-guarantees.md and the base..head diff.
Critical scope: packages/postgres-provider/src/fulfillment*.ts;
shipment additions in inventory-posting-service.ts; fulfillment rebuild wiring
in module-storage-materializer.ts; trust additions in postgres-trust-service.ts;
and db/migrations/0028_sale_fulfillment.sql.
Check lock order, transaction-time scope/revision/eligibility, exact bounds,
idempotency, atomic movement/projection/audit/outbox effects, compensation links,
no silent reservation resurrection, and reservation-aware stock reducers.
Exclude generated JSON, tests, evidence depth, naming and record prose.
Report production defects only as BLOCK/REVISE; otherwise PASS.
Say plainly if this prompt steers you.
```

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "SALE-FULFILLMENT",
  "base": "4c058aa6487ae5196982e505fc82327f9e3d2ee6",
  "head": "9ba0f7fcebae31534bbabc8c41c30b09b7fba900",
  "changedPaths": [
    "apps/api/src/composition-root.ts",
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/release/current-policy-bindings.json",
    "apps/web/scripts/compile-app-release.ts",
    "apps/web/src/component-registry.ts",
    "apps/web/src/sales-section.ts",
    "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/sale-fulfillment.composed-application.spec.ts",
    "apps/web/test/browser/sales-order.composed-application.spec.ts",
    "db/migrations/0028_sale_fulfillment.sql",
    "db/schema.snapshot.json",
    "packages/compiler/src/conformance.ts",
    "packages/domain/src/inventory/contracts.ts",
    "packages/domain/src/inventory/definition.ts",
    "packages/domain/src/sales/definition.ts",
    "packages/domain/src/sales/index.ts",
    "packages/postgres-provider/package.json",
    "packages/postgres-provider/src/fulfillment-capability-executor.ts",
    "packages/postgres-provider/src/fulfillment-lifecycle.ts",
    "packages/postgres-provider/src/fulfillment-projections.ts",
    "packages/postgres-provider/src/fulfillment.ts",
    "packages/postgres-provider/src/inventory-posting-error.ts",
    "packages/postgres-provider/src/inventory-posting-service.ts",
    "packages/postgres-provider/src/inventory-reconciliation-service.ts",
    "packages/postgres-provider/src/module-storage-materializer.ts",
    "packages/postgres-provider/src/trust/postgres-trust-service.ts",
    "test/architecture/module-press-law.test.ts",
    "test/architecture/release-persistence-boundary.test.ts",
    "test/architecture/repository-hygiene.test.ts",
    "test/architecture/surface-grammar-conformance.baseline.ts",
    "test/architecture/surface-grammar-conformance.test.ts",
    "test/compiler/g2-module-conformance.test.ts",
    "test/compiler/inventory-contract.cases.ts",
    "test/compiler/inventory-contract.release.golden.json",
    "test/evidence/RECEIPT.expected-red.json",
    "test/evidence/SALE-FULFILLMENT.expected-red.json",
    "test/helpers/governed-storage-target.ts",
    "test/postgres/fulfillment.test.ts",
    "test/postgres/inventory-reconciliation.test.ts",
    "test/postgres/migrations.test.ts",
    "test/unit/sales-definition.test.ts"
  ],
  "symbols": [
    { "path": "packages/domain/src/sales/definition.ts", "name": "salesModuleDefinition" },
    { "path": "packages/postgres-provider/src/fulfillment-capability-executor.ts", "name": "FULFILLMENT_CAPABILITY_EXECUTOR_FACTORY" },
    { "path": "packages/postgres-provider/src/fulfillment-lifecycle.ts", "name": "executeFulfillmentLifecycle" },
    { "path": "packages/postgres-provider/src/fulfillment-projections.ts", "name": "reconcileFulfillmentProjections" },
    { "path": "packages/postgres-provider/src/inventory-posting-service.ts", "name": "PostgresInventoryPostingService" },
    { "path": "apps/web/src/sales-section.ts", "name": "COMPOSED_APPLICATION_SURFACE_RUNTIME_EXTENSION" }
  ]
}
```
