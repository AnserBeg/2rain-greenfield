# RAIN-META-SALES — metadata-composed fulfillment workspace

Status: P1/P2 correction evidence_ready for the same online reviewer; new hosted CI pending. One resolved stop.
Independent review online only; no local review, merge, deployment or acceptance.
Base: `fe97b63baedf8bdd42146318bb89d4be1aa948f6`; branch: `packet/RAIN-META-SALES`.
Draft PR: https://github.com/AnserBeg/2rain-greenfield/pull/5
Worktree: `/home/rvham/2rain-greenfield-rain-meta-sales`.
Reference: `AnserBeg/temp_inventory@d057daffd17a199309675a6b0a31c8bdbca05282`.
The dirty reference checkout was read only with `git show` at the pin; no code copied.

## Charter and claims

Outcome: released stocked order → reserve 8 of stock 10 → ship 5 → release 3 → packing.
Lease: canonical/compiler/domain/runtime/provider, web runtime/release, dev-tooling seam,
affected tests/inventories and execution records; accepted posting stays authoritative.
No receiving redevelopment, full order entry, finance, pricing or integrations.
1. v6 composition declares fields, exact child queries, inputs, contextual operation steps and packing navigation; shared SurfaceRuntime renders them without Sales dispatch.
2. Registered fulfillment read models use policy-governed dependency queries, exact relation/field restrictions and persisted projections; UI performs no stock arithmetic.
3. Tasks reauthorize display dependencies, redact denied responses, bind confirmation to an immutable preparation, and preserve revision checks, step keys and withheld-read-back stops.
4. Historical releases reproduce; new output carries capability floors. Two compiled presentation revisions and renamed non-Sales metadata share the runtime.
5. The real-gateway fixture covers 10/8/2 → 5/3/2 → 5/0/5, exact packing, input retention, keyboard selection and 390 px; agent-channel invocation/replay uses the same gateway without a model.

## Decisions and controls

- User approved bounded v6 composition: “yes go ahead with recomendation”, resolving the only stop.
- Existing five archetypes; each child resolves independently and failed bindings suppress dependent actions.
- Surface payload v2/capability 4; query read-model capability 2. Historical readers stay strict.
- v6 physical dispatch retains v5 scalar-default representation: no false retype, database reset or accepted lineage deletion.
- Tasks are sequential operations, not atomic transactions; earlier drafts remain after later refusal. Existing Edit/Release/Post/lifecycle commands remain alongside composition.
- Task tokens bind principal/tenant/environment/release/surface/record; monotonic one-hour lifetime, process-local journal.
- Read-model queries are independently authorized reads; posting rechecks authoritative stock, no atomic read-snapshot claim.
- Shipment probe first refused missing reason narrative; the metadata mapping supplies it through the accepted operation.
- Browser caught inherited top inset covering mobile controls; its original click now tests the corrected bottom navigation.
- Integration controls refuse invalid composition mappings and missing exact-scope receipts; retry/withheld tests observe gateway outcomes and stable inputs/keys.
- Repeated immutable query-catalog validation is cached per issued view, never authorization/results. Whole-catalog refusal, view isolation and policy revocation pass integration controls. Projection-only readers remain uncached and revalidate mutations.
- Full-app probe: 100 lookups 324 → 15 ms; five surface bindings 196 → 38 ms (diagnostic measurements, not a timing gate).
- Language inventory re-derived from schema: 2,050 → 2,269 obligations; 219 additions, no removals. Declaration coverage is not per-obligation execution proof.

## Consolidated correction — 2026-09-15

- P1 reproduced cached root/child and committed-withheld disclosure; complete-response sentinel controls now pass for root, child and independent label denial. Governed display refresh cannot mutate execution state; withheld repeats retain HTTP 200/receipt and dispatch no extra step.
- P2 reproduced old review dispatching replacement inputs; server-issued prepared identity now binds frozen normalized inputs. Missing/forged/stale forms dispatch zero; barriers prove delayed preparation cannot overwrite newer/confirmed state, while busy/duplicate/retry checks preserve effects and keys.
- Tests call `submitSurfaceRuntimeIntent` through the actual outer renderer and semantic gateways with controlled policy/executors; effect journals are fixture observations, not PostgreSQL persistence evidence. Reproduction exit 1; corrected focused 10/10, exit 0.

## Gates and evidence

- Correction local pass (all exit 0): complete affected file 47/47; full integration 163/163; surface contracts 29/29; typecheck, lint, format and both artifact-freshness checks. No generated artifacts changed.
- Reviewed candidate `6af24ff` passed full CI 307. Correction browser attempt exited 75 before execution: preserved demo PID 89544 holds the shared test lock. New pushed candidate requires its own hosted browser/matrix run; no old-run retry or polling loop.
- Final checks: https://github.com/AnserBeg/2rain-greenfield/pull/5/checks (exact published tip). Handoff reports the completed run; earlier red candidates are retained in PR history.
- `scripts/check-records.sh` passes. No full-matrix success claimed until the PR-tip run completes.
- Screenshots are emitted by `meta-sales.spec.ts`: fulfillment-desktop.png, fulfillment-mobile.png and packing-mobile.png.
- No local reviewer or program review ran; this unintegrated packet is not a stage boundary.

## Test it yourself

In Ubuntu/WSL, from `/home/rvham/2rain-greenfield-rain-meta-sales`:
```sh
corepack pnpm install --offline --frozen-lockfile
node scripts/run-with-test-lock.mjs shared -- node --import tsx test/helpers/meta-sales-fixture.ts --serve
```
Open printed `META_SALES_URL`; Ctrl-C closes only this disposable fixture.
Select line → Reserve stock → 8, Calgary warehouse → Review → Confirm; return: 10/8/2.
Select reservation → Ship reserved stock → 5 → Review → Confirm; return: 5/3/2.
Release remainder → Review → Confirm; return: 5/0/5. Select shipment → Open packing.
Packing shows its location and every exact line; Back returns to the same order.
Repeat at 390 px; no customer/item/location/line identifier typing is required.

## Limits and online review prompt

Process loss requires record inspection before a new task; earlier committed steps are not rolled back.
No live customization UI, real-model execution or production deployment. Nine new messages have
catalog census coverage; busy/expiry paths lack separate browser drivers.
Same online reviewer: inspect correction from `6af24ff7e85bb133114bc084fff87f35a6955dbc` to the executable SHA below.
Recheck P1/P2 and the affected shared task/surface callers; independent online review only.
Read docs/architecture/posting-kernel-guarantees.md for unchanged posting authority.
Focus on complete-response read safety, prepared identity and async transitions. Identify production defects under these claims, separating
future scope/evidence limits. Say plainly if this prompt steers you. Do not merge or deploy.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "RAIN-META-SALES",
  "base": "fe97b63baedf8bdd42146318bb89d4be1aa948f6",
  "head": "3142474685f769ff83a0f196a7f54e634ce854d9",
  "changedPaths": [
    "apps/web/release/app.authored.json",
    "apps/web/release/app.compiled.json",
    "apps/web/src/component-registry.ts",
    "apps/web/src/message-catalog.ts",
    "apps/web/src/surface-composition.ts",
    "apps/web/src/surface-contract.ts",
    "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/message-catalog.spec.ts",
    "apps/web/test/browser/meta-sales.spec.ts",
    "apps/web/test/browser/sale-fulfillment.composed-application.spec.ts",
    "apps/web/test/browser/sales-order.composed-application.spec.ts",
    "apps/web/test/surface-runtime-contract.test.ts",
    "packages/canonical-model/src/constants.ts",
    "packages/canonical-model/src/index.ts",
    "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/schemas.ts",
    "packages/canonical-model/src/surface-composition.ts",
    "packages/compiler/src/compiler.ts",
    "packages/compiler/src/index.ts",
    "packages/compiler/src/projections.ts",
    "packages/compiler/src/protocol.ts",
    "packages/dev-tooling/src/surface-runtime-seam.ts",
    "packages/domain/src/app/builder.ts",
    "packages/domain/src/catalog/definition.ts",
    "packages/domain/src/inventory/definition.ts",
    "packages/domain/src/location/definition.ts",
    "packages/domain/src/party/definition.ts",
    "packages/domain/src/platform/definition.ts",
    "packages/domain/src/purchasing/definition.ts",
    "packages/domain/src/sales/definition.ts",
    "packages/domain/src/sales/workspace.ts",
    "packages/postgres-provider/src/composed-application-runtime.ts",
    "packages/postgres-provider/src/fulfillment-read-model.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/runtime/src/list-behavior/cursor.ts",
    "packages/runtime/src/list-behavior/index.ts",
    "packages/runtime/src/request-runtime-view.ts",
    "packages/runtime/src/semantic-query-gateway.ts",
    "test/architecture/surface-grammar-conformance.baseline.ts",
    "test/architecture/surface-grammar-conformance.test.ts",
    "test/architecture/surface-runtime-seam.test.ts",
    "test/compiler/g2-module-conformance.test.ts",
    "test/fixtures/g2/language-conformance/coverage-decisions.json",
    "test/helpers/meta-sales-fixture.ts",
    "test/integration/surface-data-binding.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/request-runtime-view.test.ts",
    "test/unit/canonical-model/normalization.test.ts",
    "test/unit/purchasing-definition.test.ts",
    "test/unit/sales-definition.test.ts"
  ],
  "symbols": [
    {
      "path": "apps/web/src/surface-composition.ts",
      "name": "loadSurfaceComposition"
    },
    {
      "path": "packages/domain/src/sales/workspace.ts",
      "name": "salesWorkspace"
    }
  ]
}
```
