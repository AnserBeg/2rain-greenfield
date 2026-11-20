# BILLING-1 — period and usage billing

The narrow Fable re-read accepted [ADR-0083](../../decisions/ADR-0083-period-and-usage-billing.md) with amendments and required A3–A6 in [ADR-0084](../../decisions/ADR-0084-receivables-billing-origin-drafts.md). All R1–R13 were resolved. The orchestrator accepted the amendments on 2026-11-20.

## Design decisions

- Service start anchors best price, minimum and cap across invoices. Civil days use the pinned zone. A 09:00-to-09:00 day earns one daily charge across either clock change.
- The compiled plan names component kind, base, stage, schedule, pause and proration policies, explicit allowance basis and source bindings. Only Billing operations may version amounts, overrides, assignments and enrollments.
- Arrears drafts carry Billing’s rounded net, first-class service dates and the platform’s tax determination. Advance awaits credit-on-account or refunds.
- Receivables owns entered adjustments, consolidation, credit exposure and human issue. Slice 2 requires its v2 ruling, the complete BOOKING-1 owner projection and the [cross-capability transaction admission](posting-kernel-admission.md#billing-and-receivables-transaction-admission).
- WORKFLOW-1 can schedule an arrears draft proposal. Its Tier B write requires approval under ADR-0073.
- The customization proofs cover equipment hire, a usage-only subscription without Booking, and a service contract with a fixed fee.

## Gates

- A1 gates slice 1. The calculation version pins first-valid-after-gap and earlier-offset overlap anchors.
- A3–A6 gate slice 2. Delivered arrears count toward exposure, void reserves occurrence cents and fences dependents, and correction credits require bound confirmation.
- A7 gates slice 3. An advanced source cursor raises due work for issued coverage even after enrollment ends.

## Slice 1 · quote a service

- A released structure and immutable, company-scoped price versions govern period, meter and fixed charges. The explanation query reads the declared source under its own grant and the pinned release.
- Half-up rounding happens on the cumulative exact entitlement. Prior allocated and reserved cents are deducted once. Each line identifies its occurrence, rate version, coverage and derivation.
- Price publication, overrides and assignments use registered operations with exact revision, permission, audit, outbox and idempotent replay. Migration 0049 enables RLS and grants append access. Reader 29 gates billing declarations.
- Controls `billing-immutable-price` and `billing-tenant-price` exercise a real update and a cross-tenant read through the serving role.
- The docs amendment merged at `886f84f2`. Slice 2 (billing-origin drafts and human issue) is the next implementation boundary.

## Test it yourself

Run `node --import tsx --test test/integration/billing-quote.test.ts` from the repository root. Expect twelve passing proof groups, including CAD 100 + 30, 110 + 20, 490 + 100, 100 + 140 and a CAD 30 credit. The Edmonton spring and autumn examples bill one civil day each.

```record-claim
{
  "schemaVersion":"northstar.record-claim/v1",
  "packet":"BILLING-1",
  "base":"238b98a6cbb88171983f395ec23179eb4d73b24e",
  "head":"81d2ff204962be3cf391106b9edefd153e963890",
  "changedPaths":["apps/api/src/erp-capabilities.ts","db/migrations/0049_billing_rate_tables.sql","db/schema.snapshot.json","packages/canonical-model/src/billing-evidence.ts","packages/canonical-model/src/billing.ts","packages/canonical-model/src/normalize.ts","packages/canonical-model/src/schemas.ts","packages/compiler/src/billing.ts","packages/compiler/src/compiler.ts","packages/compiler/src/projections.ts","packages/domain/src/billing/calendar.ts","packages/domain/src/billing/cover.ts","packages/domain/src/billing/fraction.ts","packages/domain/src/billing/occurrences.ts","packages/domain/src/billing/quote.ts","packages/domain/src/billing/terms.ts","packages/postgres-provider/package.json","packages/postgres-provider/src/billing-quote.ts","packages/postgres-provider/src/billing-terms.ts","packages/postgres-provider/src/release-repository.ts","packages/postgres-provider/src/serving-gateways.ts","packages/runtime/src/request-runtime-view.ts","test/architecture/release-persistence-boundary.test.ts","test/evidence/BILLING-1.expected-red.json","test/integration/billing-quote.test.ts","test/integration/billing-release.test.ts","test/postgres/billing-terms.test.ts","test/postgres/inventory-storage.test.ts","test/postgres/migrations.test.ts","test/postgres/module-storage-transition.test.ts","test/postgres/request-runtime-view.test.ts","test/postgres/trust-substrate.test.ts"],
  "symbols":[{"path":"packages/domain/src/billing/quote.ts","name":"quoteBillingService"},{"path":"packages/postgres-provider/src/billing-quote.ts","name":"billingQuoteReadModel"},{"path":"packages/postgres-provider/src/billing-terms.ts","name":"BILLING_TERMS_FACTORY"}]
}
```
