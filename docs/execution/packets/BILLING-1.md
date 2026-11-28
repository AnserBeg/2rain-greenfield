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
- The unchanged bound release has identical serialized bytes at reader 41. Its archived serving process answers an item query and refuses the new binding at surface rung 45 (first recorded as 42; renumbered after REPORTS-1 took 42-44). The stored release rows and artifact bytes survive both probes.
- Negative controls caught early cycles, excess coverage, foreign owners, cursor drift, mixed quantities, dropped pauses, a decreasing meter, mismatched units and duplicate owners.
- The first slice 2 packet run failed declaration emit at the exported arrears result. Billing now exports its quote-line type.
- The next run failed the language coverage check. The optional `arrearsSource` binding adds five ledger obligations: its presence, its absence and the `agreedInterval`, `periodMeter` and `bookingActuals` kinds. No first-party coverage package declares a billing plan, so all five are recorded under the unused-shape exemption. The two observed-set decisions are re-recorded unchanged against the new ledger. A new billing-terms test compiles each kind at the arrears reader (now 45) with calculation v3 and keeps an unsourced plan at reader 41 with v2. It also refuses a meter on an agreed-interval source and an unknown kind such as advance. Before this test, `agreedInterval` had no test.
- This review creates no invoice, allocation or accounting entry. Enrollment, cutover carry, archive protection for unbilled use, quote-digest allocation, human issue and void/reissue belong to the atomic Receivables v2 writer. Advance awaits an admitted credit or refund path.

## Slice 2 checkpoint · fix round (Fable review REVISE, 2026-11-22)

- **Merged main 5710c05a.** The four conflicts, in canonical-model `billing.ts`, `release-repository.ts`, `request-runtime-view.ts` and its test, repeated main's 72e4988d. The packet side contains main's version plus rung 42 in each, so it was kept.
- **Merged main 37bfd473 (TRAIN-H).**
  - REPORTS-1 holds surface rungs 42 to 44, so the arrears reader is now 45.
  - The runtime ceiling and the capability comparison test list main's three floors, then 45.
  - `patch.ts` and `render.ts` keep both the Billing and the Report imports.
  - The coverage decisions start from main's records and add the arrears-source note against the merged ledger.
  - The older-reader proofs now pin the preceding serving binary to main 37bfd473. It answers an item query on the unchanged bound release, and refuses the arrears release by name: "requires version 45 and this runtime supports 44".
  - After CI-6, shard 8 runs agent-tasks, billing-terms and board-policy, so billing-terms stays there.
- **Finding 1, Booking precision.** Booking stamps its clock in microseconds. The adapter now truncates every Booking instant to the millisecond instead of refusing it. Truncation preserves order, and a sub-millisecond span becomes empty and is accepted. ADR-0083 states the rule under calculation v3.
- **Finding 2, possession past the agreed end (owner ruling).** Under `bookingActuals`, billing follows actual possession. Possession is read through the review instant. A live leg keeps the service open, and the final cycle ends at the recorded return. An agreed five-day hire returned on day nine at CAD 30 a day reviews CAD 270.00. Before this fix it reviewed CAD 150.00.
- **Rule 16.** The compiler no longer requires the customer and currency field IDs to end in `_customer_party_id` and `_currency`. Each role the plan declares must be a required text field selected on the billed entity. The two roles need different fields, and the currency field holds exactly three characters. A second business with differently named fields binds. Optional notes still cannot carry either role.
- **Journeys through the released quote query (finding 4).**
  - Contract: an agreed-interval contract reviews CAD 130.00 for its closed cycle.
  - Hire: a hire is held, confirmed, started and returned through released Booking operations. No instant is entered, so Booking stamps its production clock. The quoted leg equals the truncated stored instants. While the leg is live past the agreed end the review stays open. After the return it is due at the return.
  - Meter: the existing period-meter journey.
  - Isolation: each journey refuses Company B in the same tenant, both by row scope and by policy.
- **Rule 8.** Each new check has a manifest control that fails its own test, and all of them were reproduced and restored:
  - `billing-booking-microseconds`
  - `billing-booking-live-leg`
  - `billing-booking-overrun`
  - `billing-booking-possession-wired`, the PostgreSQL journey
  - `billing-role-required`
  - `billing-role-currency-code`
  - `billing-role-distinct`
- **New refusal.** Reading possession through the review instant can return a second booking for the same owner in the slot. That review is refused, since it needs exactly one tracked booking.
- **Early return.** A return before the agreed end keeps the agreed end, as before. The orchestrator ruled on 2026-11-22 that this is a general plan choice, not one fixed rule. It is next-slice task 1.

### First tasks of the next billing slice (ride-alongs from the fix round)

1. Early return as a declared plan option. Each plan chooses "bill to agreed end" or "bill to actual return", with an optional minimum term, because rentals, storage and subscriptions differ. Today every plan bills to the agreed end.
1. Finding 3: give each of these 17 checks a test that fails without it.
   - `packages/customization/src/patch.ts`: bindings are kept out of the tenant member. Use a negative with a fully valid bindings object.
   - `packages/compiler/src/billing.ts`, six checks:
     - the usage query is scoped to one company
     - the usage query reads the billing owner query
     - the slot owner is the billing entity
     - the slot is tracked
     - a meter source has no time component
     - a meter source uses a per-cycle allowance
   - `packages/domain/src/billing/quote.ts`, six checks beside boundary readings:
     - basis
     - usage events
     - pauses
     - opening instant
     - stream
     - per-cycle allowance
   - `packages/domain/src/billing/arrears.ts`: an invalid service period.
   - `packages/postgres-provider/src/billing-booking-usage.ts`, two checks:
     - evidence of other bookings
     - the leg unit
   - `release-repository.ts`: the loader's arrears floor. Add a `BILLING_PLAN_MISMATCH` assertion.
   - Add manifest entries for the controls this record cites.
2. Finding 5:
   - Render `oneOf` in the drafter's generated description (`ai-draft-kinds.ts` typeText).
   - Record live results for B01 to B03.
   - Make the B-case meter eval use the reading field's canonical unit ID instead of the free-text unit "copy".
3. Rule 16 follow-up seen in this round: the quote query's permission must still be named `<namespace>:permission.billing_quote` (`packages/compiler/src/billing.ts`). Replace the name with a declared binding.
4. A second booking for the same owner in the slot inside the review window refuses the review. Decide how several bookings in one slot are billed: in turn, or as separate services.

Slice 3a-i built tasks 1 to 4 above and the B8 rename, B1 and B7 ([record](BILLING-1-s3a-i.md)). Task 4 is a ruling proposal there; the free-text meter unit in finding 5 stays open.

Slice 3a-ii-a adds per-component timing: a recurring fixed fee billed in advance under keepPaidPeriod, calculation v5 ([record](BILLING-1-s3a-ii.md)). The minimum charge, discounts, percentage components and time in advance are later 3a-ii slices.

Slice 3a-ii-b adds the minimum charge from the agreed start (a fee minimum term), percent discounts and percentage components, pricing reader 57 provisional ([record](BILLING-1-s3a-ii-b.md)). Time in advance (e) and amount discounts (f) remain.

## Test it yourself

Run `node --import tsx --test test/integration/billing-quote.test.ts`. The three-business test expects CAD 100.00 for hire after a pause, CAD 8.25 for usage above allowance and CAD 15.50 for a prorated contract.
Run `node --import tsx --test --test-name-pattern='^a period meter reviews' test/postgres/billing-terms.test.ts` to publish terms, review a service, withhold a reading and exercise company isolation.
Run `node --import tsx --test test/integration/billing-booking-possession.test.ts` for microsecond Booking instants and the CAD 270.00 overrun.
Run `node --import tsx --test --test-name-pattern='agreed-interval contract reviews|equipment hire reviews possession' test/postgres/billing-terms.test.ts` for the contract and hire journeys (Docker).

```record-claim
{
  "schemaVersion":"northstar.record-claim/v1",
  "packet":"BILLING-1",
  "base":"37bfd47311c58060000cebca49d5f55174e3874a",
  "head":"9376d8f117c53bc1ac2328670d915632107444ba",
  "changedPaths":["docs/decisions/ADR-0083-period-and-usage-billing.md","docs/execution/packets/BILLING-1.md","packages/canonical-model/src/billing-evidence.ts","packages/canonical-model/src/billing.ts","packages/compiler/src/billing.ts","packages/compiler/src/projections.ts","packages/customization/src/ai-draft-kinds.ts","packages/customization/src/apply.ts","packages/customization/src/patch.ts","packages/customization/src/render.ts","packages/customization/src/upgrade-diagnostics.ts","packages/customization/src/upgrade-replay.ts","packages/domain/src/billing/arrears.ts","packages/domain/src/billing/quote.ts","packages/postgres-provider/src/billing-booking-usage.ts","packages/postgres-provider/src/billing-quote.ts","packages/postgres-provider/src/customization-service.ts","packages/postgres-provider/src/release-repository.ts","packages/runtime/src/request-runtime-view.ts","test/agent/build-bakeoff-run.ts","test/agent/build-eval-cases.ts","test/agent/build-eval.ts","test/architecture/repository-hygiene.test.ts","test/evidence/BILLING-1.expected-red.json","test/fixtures/g2/language-conformance/coverage-decisions.json","test/helpers/archived-billing-probes.ts","test/integration/billing-booking-possession.test.ts","test/integration/billing-quote.test.ts","test/postgres/billing-terms.test.ts","test/postgres/booking-commitments.test.ts","test/postgres/request-runtime-view.test.ts","test/unit/customization-ai-draft-slice2.test.ts","test/unit/customization-upgrade.test.ts"],
  "symbols":[{"path":"packages/domain/src/billing/arrears.ts","name":"reviewArrearsCharges"},{"path":"packages/postgres-provider/src/billing-booking-usage.ts","name":"fenceBillingBookingOwners"},{"path":"packages/postgres-provider/src/billing-booking-usage.ts","name":"bookingPossessionServiceEnd"},{"path":"packages/postgres-provider/src/billing-booking-usage.ts","name":"truncateBookingInstant"},{"path":"packages/postgres-provider/src/billing-quote.ts","name":"billingQuoteReadModel"}]
}
```
