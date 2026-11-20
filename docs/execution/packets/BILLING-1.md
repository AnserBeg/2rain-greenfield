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

- The calculator rates periods, meter allowances and fees using exact fractions. The served agreed-interval binding reads one unit, customer, currency and dates from an exact company-scoped query. Booking and meter source adapters belong to slice 2.
- Migration 0056 revokes direct runtime access to rates and assignments. Publication validates the accepted receipt, audit, released operation, current company grant and proposal in one transaction. Reads require the released quote and source grants plus company scope. The application grant allowlist removes all four Billing table exceptions.
- Rate selection uses effective and publication time at each occurrence opening. Saved explanations contain the plan, evidence and calendar required for replay. The service-end fee selects rates at the end instant.
- Publication retries discover their recorded company before checking the proposal and repeat authorization. Allocated and reserved cents admit every entitlement within the fraction precision bound.
- The compiler refuses notes as evidence with `BILLING_SOURCE_FIELDS_REQUIRED`. Reader 30 covers declarations and reader 36 covers typed interval bindings.

## Test it yourself

Run `node --import tsx --test test/integration/billing-quote.test.ts`. Expect 17 proofs, including CAD 100 + 30 after a backdated publication, the capped three-day minimum of CAD 70, and a CAD 100 month from Jan 31 to Feb 28.
Run `node --import tsx --test test/postgres/billing-terms.test.ts` for direct SQL denial, company isolation, archived retries, served replay and the historical reader’s refusal.

```record-claim
{
  "schemaVersion":"northstar.record-claim/v1",
  "packet":"BILLING-1",
  "base":"55543d77236871ce7b9f09dc5b44ef1ae812859c",
  "head":"e4400e06f91cdcdfcaf81377f80098686559f9a3",
  "changedPaths":["db/migrations/0056_billing_publication.sql","db/schema.snapshot.json","learnings.md","packages/canonical-model/src/billing-evidence.ts","packages/canonical-model/src/billing.ts","packages/compiler/src/billing.ts","packages/compiler/src/projections.ts","packages/domain/src/billing/quote.ts","packages/domain/src/billing/terms.ts","packages/postgres-provider/src/billing-quote.ts","packages/postgres-provider/src/billing-terms.ts","packages/postgres-provider/src/release-repository.ts","packages/postgres-provider/src/trust/postgres-trust-service.ts","packages/runtime/src/request-runtime-view.ts","packages/runtime/src/semantic-operation-gateway.ts","test/architecture/release-persistence-boundary.test.ts","test/evidence/BILLING-1.expected-red.json","test/fixtures/g2/language-conformance/coverage-decisions.json","test/integration/billing-quote.test.ts","test/integration/billing-release.test.ts","test/postgres/application-grants.tsv","test/postgres/billing-terms.test.ts","test/postgres/inventory-storage.test.ts","test/postgres/migrations.test.ts","test/postgres/module-storage-transition.test.ts","test/postgres/request-runtime-view.test.ts","test/postgres/trust-substrate.test.ts"],
  "symbols":[{"path":"packages/domain/src/billing/quote.ts","name":"quoteBillingService"},{"path":"packages/postgres-provider/src/billing-quote.ts","name":"billingQuoteReadModel"},{"path":"packages/postgres-provider/src/billing-terms.ts","name":"BILLING_TERMS_FACTORY"}]
}
```
