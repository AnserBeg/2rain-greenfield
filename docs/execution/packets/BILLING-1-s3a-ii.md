# BILLING-1-s3a-ii — per-component timing: a recurring fixed fee in advance (thin slice a)

Status: built on packet/BILLING-1-s3a-ii (base main 63826f6c0). Tier: **Critical** (money; rule 18), build mode (rule 24). Stops: none. No migration.
Design: note `notes/BILLING-1-s3a-ii` (bbf546e1) and its Mythos design read (APPROVE WITH AMENDMENTS 1-11). This record covers ONLY the read's THIN FIRST SLICE (s3a-ii-a). Not built: (b) the minimum charge from the agreed start, (c) percent discount, (d) percentage component, (e) time in advance, (f) amount discount.
Rung: surface reader 56 (`BILLING_TIMING_READER`, provisional 55; assigned at TRAIN-Z because WORKFLOW-3 s1 took 55 at TRAIN-Y) and calculation v5. Rule 21(c): no preceding-binary proof; listed in FIRST-TENANT-OWED.md.
CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/46150749521

## Claims
1. `timing {when: advance | arrears, earlyEnd?: keepPaidPeriod | prorateAndRefund}` on `time` and recurring `fixed` components. Absent = arrears, so v2-v4 bytes, digests and calculations are unchanged (no normalization default). Any timing key selects calculation v5 and reader 56; v5 also rates the v4 rule keys.
2. No implicit timing under v5 (amendment 4): a plan stating timing on one component states it on every time and recurring fixed component. Refused at parse: advance on a time component (amendment 5), on a meter (strict object) or a one-off; advance with `fixedFeeDuringPause` absent or suspend; `prorateAndRefund`; `earlyEnd` on an arrears component; advance on a periodMeter plan or without an interval or service-use source; advance on service use without a declared `earlyReturn` (bookingActuals, or evidenceQuery without the rule).
3. Owed set, defined once (amendment 3): every cadence cycle whose clamped start is <= the review instant and before the service end. A late first review owes every opened cycle; none opens at or after the end (keepPaidPeriod).
4. Second horizon (amendment 2): each owed cycle is rated over its whole span on the agreed interval (evidence `agreedEnd`, kept by `reviewArrearsCharges` before actual use moves the service end) united with actual use through the review instant. The arrears horizon is unchanged. An advance-only review (no cycle closed) passes the period start as its arrears boundary and rates only advance fees; the review's `cycle` is then null and it carries `advance` (absent on untimed plans, so their review bytes stay).
5. E1 (CAD 300/month, calendar months, from Jun 10 2027, Edmonton): Jun 10 210.00; Jul 1 +300.00; an agreed end of Aug 20 prorates August to 183.87. Service use, `actualEnd`, returned Jul 12: July stays 300.00 (total 510.00), August never opens, first reviewed Aug 5 or Sep 15 alike. Arrears fees and one-offs in the same plan stay closed-cycle only.
6. The service-use snapshot must be complete through the review instant when advance is owed (advance reads actual use through it). The cursor fence runs for an advance-only review too (status due).
7. Served end to end: a PG journey reads a v5 service-use plan (`evidenceQuery` + `earlyReturn: actualEnd`, a daily fee in advance) through the released quote query while the equipment is out and after an early return: two opened cycles at 30.00 each, the second kept whole, no third. This is also the first PG journey through the `evidenceQuery` form (s3a-i disclosed gap).

## Decisions
- Overrun (not in the note or the read): actual use past the agreed end is billed in addition to agreed coverage, once (a union, so agreed days never count twice); an overrun cycle grows with the review instant. Agreed-only coverage would have billed 0 for an overrun month. Orchestrator ruling (delegated, 2026-11-28) adopts this; recorded in ADR-0083.
- Amendment 10(b) recorded in the ADR: keepPaidPeriod bills an opened cycle even if no review saw it before the return.
- Amendment 1: on an agreed-interval source a shortened end is a correction; the ADR says so.
- Amendment 7: no negative-advance refusal here (s3b gate, with the credit hold on advance Generate).
- The served path still returns notDue when the review instant is at or before the anchor (the usage window must be non-empty); a review an instant later owes the first cycle.
- A service-use review that owes advance before any use leg exists refuses (no commercial quantity), as before: fail closed.

## Fix round (Mythos silent-harm review FIX, 2026-11-28)
1. Money: advance on a service-use source with no earlyReturn kept opening whole cycles after the return (agreed Jun 10 to Aug 31, returned Jul 12: 810.00). Ruled: refuse it at parse (bookingActuals, or evidenceQuery without earlyReturn); ADR-0083 records it. Control timing-service-use-early-return.
2. `earlyEnd` on an arrears component was admitted and never read: refused, with a test.
Items 3 (an advance line's period end is the full cycle end when the agreed end is inside it) and 4 (no term pins: a backdated table re-rates an opened cycle) go to s3b.
The first controls dispatch (46145546481, 12/12 green) had input ref=4f93f588916320dc98dc9483d8c9d77967f4d641. Full 46145541191 was cancelled for the fix (the tip moved), not red. The fix-round full run (46147897052, at a6b196a90) was red only on module-press-law: the first form of finding 1 named the persisted Booking literal (PRESS015 baseline rise). The refusal now admits advance only on an agreed interval or an evidence source that declares earlyReturn; press-law 69/69 locally.

## Rules 16, 17
(a) Advance period rent: rentals, storage, coworking, subscriptions, service contracts. (b) Any recurring fixed fee on any interval or service-use source takes it; the owed set and the agreed horizon are generic. (c) Narrower: fixed fees only; time in advance is slice (e).

## Controls (rule 24; test/evidence/BILLING-1.expected-red.json, 11 new, 2 s3a-i entries re-pointed)
advance-agreed-not-elapsed, advance-keep-paid-period (domain + PG), advance-final-no-rerate, advance-no-cycle-after-end, advance-late-review, advance-arrears-closed-only, timing-unstated, timing-absent-pause, timing-advance-time, timing-version-gate, timing-service-use-early-return. Re-pointed: rules-version-selection, early-return-last-return.

## Test it yourself
`node --import tsx --test --test-name-pattern='B2' test/integration/billing-rules.test.ts`: E1 on the agreed interval and over service use, the late review, the overrun, the refusals and the v5 gate.

## Review focus
1. The overrun rule (agreed coverage united with actual use) and its effect on "final" amounts.
2. The advance-only review: `cycle: null`, arrears boundary = period start, arrears components skipped.
3. The snapshot guard at the review instant when advance is owed.

```record-claim
{"schemaVersion": "northstar.record-claim/v1", "packet": "BILLING-1-s3a-ii", "base": "63826f6c075eff7acfe1c32fad43b4081b8bb493", "head": "4152474a7026db8f71a356d0bd7e726b4ab2542f", "changedPaths": ["docs/decisions/ADR-0083-period-and-usage-billing.md", "docs/decisions/ADR-0084-receivables-billing-origin-drafts.md", "docs/execution/packets/BILLING-1-s3a-ii.md", "docs/execution/packets/BILLING-1.md", "packages/canonical-model/src/billing-evidence.ts", "packages/canonical-model/src/billing.ts", "packages/domain/src/billing/arrears.ts", "packages/domain/src/billing/occurrences.ts", "packages/domain/src/billing/quote.ts", "packages/postgres-provider/src/billing-quote.ts", "packages/runtime/src/request-runtime-view.ts", "test/evidence/BILLING-1.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/integration/billing-quote.test.ts", "test/integration/billing-rules.test.ts", "test/postgres/billing-terms.test.ts", "test/postgres/request-runtime-view.test.ts"], "symbols": [{"path": "packages/canonical-model/src/billing.ts", "name": "hasBillingTiming"}, {"path": "packages/domain/src/billing/arrears.ts", "name": "dueAdvanceCycles"}, {"path": "packages/domain/src/billing/occurrences.ts", "name": "openedOccurrences"}, {"path": "packages/domain/src/billing/quote.ts", "name": "isAdvanceFee"}]}
```
