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
- Migration 0057 revokes direct runtime access to rates and assignments. Publication validates the accepted receipt, audit, released operation, current company grant and proposal in one transaction. Reads require the released quote and source grants plus company scope. The application grant allowlist removes all four Billing table exceptions.
- Rate selection uses effective and publication time at each occurrence opening. Saved explanations contain the plan, evidence and calendar required for replay. The service-end fee selects rates at the end instant.
- Publication retries discover their recorded company before checking the proposal and repeat authorization. Allocated and reserved cents admit every entitlement within the fraction precision bound.
- The compiler refuses notes as evidence with `BILLING_SOURCE_FIELDS_REQUIRED`. Reader 30 covers declarations and reader 36 covers typed interval bindings.

Slice 1 passed its [full CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44831287787).

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44981275903

At `eda6d12f`, the regression tests caught direct grants, the notes binding, the archived retry, negative split, schedule-dependent fee and rejected large allocation. Removing minimum pricing, calendar-month handling, table currency validation or the archived loader check made the corresponding proof fail.

## Slice 2 checkpoint · review the first earned cycle

- The released quote query reviews one closed arrears cycle. Coverage ends at that cycle even when the review is late. Recurrence uses the original anchor and zone. The quote records the operands, prices and service dates needed to replay its net lines and identifies the review by digest.
- Equipment hire uses tracked possession and pause evidence from the released Booking owner query. A metered subscription uses two stored readings in the same unit without Booking. A fixed-fee service contract uses the agreed interval. All three use the same rating and rounding code.
- A reader compares every Booking owner and cursor in one fence call. Pending meter readings identify the missing fields. A company-scoped buyer can review its own record. A correct record and company ID from a different company are refused.
- Customize can draft a structural rate-plan version and replay it on upgrade. The schema-generated drafter registry and its equipment, subscription and contract eval cases keep prices and live bindings under the existing governed operations.
- General blocks are civil-time schedules, interval and meter evidence, scoped release queries, exact-fraction rating and versioned plan declarations. Equipment hire, copy subscriptions and recurring service contracts exercise them.
- The unchanged bound release has identical serialized bytes at reader 41. Its archived serving process answers an item query and refuses the new binding at provisional surface rung 42. The stored release rows and artifact bytes survive both probes.
- Negative controls caught early cycles, excess coverage, foreign owners, cursor drift, mixed quantities, dropped pauses, a decreasing meter, mismatched units and duplicate owners.
- The first slice 2 packet run failed declaration emit at the exported arrears result. Billing now exports its quote-line type.
- The next run failed the language coverage check. The optional `arrearsSource` binding adds five ledger obligations: its presence, its absence and the `agreedInterval`, `periodMeter` and `bookingActuals` kinds. No first-party coverage package declares a billing plan, so all five are recorded under the unused-shape exemption. The two observed-set decisions are re-recorded unchanged against the new ledger. A new billing-terms test compiles each kind at reader 42 with calculation v3 and keeps an unsourced plan at reader 41 with v2. It also refuses a meter on an agreed-interval source and an unknown kind such as advance. Before this test, `agreedInterval` had no test.
- This review creates no invoice, allocation or accounting entry. Enrollment, cutover carry, archive protection for unbilled use, quote-digest allocation, human issue and void/reissue belong to the atomic Receivables v2 writer. Advance awaits an admitted credit or refund path.

## Test it yourself

Run `node --import tsx --test test/integration/billing-quote.test.ts`. The three-business test expects CAD 100.00 for hire after a pause, CAD 8.25 for usage above allowance and CAD 15.50 for a prorated contract.
Run `node --import tsx --test --test-name-pattern='^a period meter reviews' test/postgres/billing-terms.test.ts` to publish terms, review a service, withhold a reading and exercise company isolation.

```record-claim
{
  "schemaVersion":"northstar.record-claim/v1",
  "packet":"BILLING-1",
  "base":"86a28ed55f25bd9b6428a6596d36ad6830a64612",
  "head":"68f8c7b18c33b6346c04182931e354295edb8326",
  "changedPaths":["docs/execution/packets/BILLING-1.md","packages/canonical-model/src/billing-evidence.ts","packages/canonical-model/src/billing.ts","packages/compiler/src/billing.ts","packages/compiler/src/projections.ts","packages/customization/src/ai-draft-kinds.ts","packages/customization/src/apply.ts","packages/customization/src/patch.ts","packages/customization/src/render.ts","packages/customization/src/upgrade-diagnostics.ts","packages/customization/src/upgrade-replay.ts","packages/domain/src/billing/arrears.ts","packages/domain/src/billing/quote.ts","packages/postgres-provider/src/billing-booking-usage.ts","packages/postgres-provider/src/billing-quote.ts","packages/postgres-provider/src/customization-service.ts","packages/postgres-provider/src/release-repository.ts","packages/runtime/src/request-runtime-view.ts","test/agent/build-bakeoff-run.ts","test/agent/build-eval-cases.ts","test/agent/build-eval.ts","test/fixtures/g2/language-conformance/coverage-decisions.json","test/helpers/archived-billing-probes.ts","test/integration/billing-quote.test.ts","test/postgres/billing-terms.test.ts","test/postgres/booking-commitments.test.ts","test/postgres/request-runtime-view.test.ts","test/unit/customization-ai-draft-slice2.test.ts","test/unit/customization-upgrade.test.ts"],
  "symbols":[{"path":"packages/domain/src/billing/arrears.ts","name":"reviewArrearsCharges"},{"path":"packages/postgres-provider/src/billing-booking-usage.ts","name":"fenceBillingBookingOwners"},{"path":"packages/postgres-provider/src/billing-quote.ts","name":"billingQuoteReadModel"}]
}
```
