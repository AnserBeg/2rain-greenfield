# BILLING-1 — period and usage billing

Fable approved the slice-0 design with changes. The 2026-11-20 docs amendment covers R1–R13. The orchestrator’s narrow re-read covers the changed sections of [ADR-0083](../../decisions/ADR-0083-period-and-usage-billing.md) and the separate [Receivables v2 proposal](../../decisions/ADR-0084-receivables-billing-origin-drafts.md) before slice 1.

## Design decisions

- Service start anchors best price, minimum and cap across invoices. Civil days use the pinned zone. A 09:00-to-09:00 day earns one daily charge across either clock change.
- The compiled plan names component kind, base, stage, schedule, pause and proration policies, explicit allowance basis and source bindings. Only Billing operations may version amounts, overrides, assignments and enrollments.
- Arrears drafts carry Billing’s rounded net, first-class service dates and the platform’s tax determination. Advance awaits credit-on-account or refunds.
- Receivables owns entered adjustments, consolidation, credit exposure and human issue. Slice 2 requires its v2 ruling, the complete BOOKING-1 owner projection and the [cross-capability transaction admission](posting-kernel-admission.md#billing-and-receivables-transaction-admission).
- WORKFLOW-1 can schedule an arrears draft proposal. Its Tier B write requires approval under ADR-0073.
- The customization proofs cover equipment hire, a usage-only subscription without Booking, and a service contract with a fixed fee.

## Gates

The record check passed. The packet’s original [CI run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44670135739) passed all 18 jobs at `6fd58698`. The amendment uses that run under the orchestrator’s no-re-run ruling. No migration or reader rung is allocated.

## Test it yourself

1. In ADR-0083’s examples, price the eight days together and then as two four-day invoices. Both totals are CAD 130. Repeat with the CAD 110 enrollment minimum.
2. Check the fall-back day from 09:00 to 09:00, and the four-week cap split across two invoices. Expect one day and CAD 240 total respectively.
3. Follow the post-issue correction from CAD 160 to CAD 130. Find the linked CAD 30 credit proposal and the remedy for insufficient creditable balance.
4. In ADR-0084, trace an unsettled void to released coverage and one reissue. Find the separate check that still refuses pre-existing lines when posting a shipped order.
5. From the repository root run `scripts/check-records.sh`. Expect exit status zero.
