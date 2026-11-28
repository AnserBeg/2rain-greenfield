# BILLING-1-s3a-ii-b — minimum charge, percent discounts, percentage components (slices b, c, d)

Status: built on packet/BILLING-1-s3a-ii-b (base main 8104e7498). Tier: **Critical** (money), build mode (rule 24). No migration.
Design: note `notes/BILLING-1-s3a-ii` and its Mythos design read (amendments 1-11). This record covers slices (b), (c) and (d) in the read's order. **Not built:** (e) time billed in advance and (f) amount discounts. (e) rewrites the cumulative time line and gets its own packet and review; (f) comes after it in the read's order.
Rung: surface reader 57, `BILLING_PRICING_READER`, provisional. WORKFLOW-3 s1b also holds a provisional 57, and the integrator renumbers. Calculation stays v5. Rung 56 admits timing only, so the new keys take their own rung (ADR-0083: rungs are never shared across slices). Rule 21(c): no preceding-binary proof; the gap is listed in FIRST-TENANT-OWED.md.
CI tier: pending full

## Claims
1. **Minimum charge from the agreed start (b).** On `time` it is `minimumDuration` with `perEnrollment`. E2 already held on main, measured before any change: CAD 30 a day, minimum 7 days, `actualEnd`, returned on day 3 gives 210.00 due on day 3. A pickup on day 1 still gives 210.00. Under v5, a minimum duration that can never fit its pricing window is refused at parse.
2. **Fee `minimumTerm {period, count}`** on a recurring fixed fee, in advance or in arrears.
   - When the service ends before the term end, the cycles from the service end to the term end fall due at the service end. Each cycle keeps its natural identity, and the last one is prorated to the term end.
   - E1m: Jun 210 + Jul 300 + Aug 300 + Sep 1-10 90 = 900.00.
   - Held cycles are rated on [service end, term end) only, never on an open-ended agreed interval.
   - In arrears, the review that reaches the service end rates every cycle up to the term end.
   - `feeProration: none` refuses beside either term form on a fee, because it would bill a partly held cycle whole (advisor check against the ruling).
   - A one-off fee cannot declare a term. Declaring the fee term together with `earlyReturn.minimumTerm` is refused. The early-return form alone stays admitted (amendment 6).
3. **Slice-a correction** (orchestrator ruling, 2026-11-28: a minimum term charges exactly the term, prorated, never more).
   - The flaw: an advance fee whose service end is held past the last return by `earlyReturn` billed each held cycle whole on the open-ended agreed interval. On the same facts, the early-return term form gave 1110.00.
   - The fix: a cycle that opens after the last return is rated on the committed interval only (last return to the held end). Both forms now give 900.00.
4. **Any v5 key requires stated timing.** Amendment 4 was keyed to a timing key. A plan with a discount or a term but no timing is now refused instead of silently defaulting to arrears.
5. **Percent discount (c, B13)** on `time`, `fixed` and `meter`.
   - It applies after the minimum and the cap, before tax.
   - The line stores the net, rounded once. It also carries `discount {kind, reason, rate, rateVersion, grossExact, discountExact, grossCents, discountCents}`, and gross = net + discount exactly in cents. The key is absent when there is no discount.
   - Time discounts each window's capped amount at that window's rate, and the enrollment floor at the first window's rate, then multiplies by quantity.
   - Cover selection runs on undiscounted prices.
   - E3: 90.00 after day 7 (gross 100), 216.00 after day 20 (gross 240).
   - E4: the floor 210 becomes 189.00; a ladder over 10 days at quantity 2 with 15% off gives 272.00.
6. **Percentage slots** `{kind: percentage, scale <= 4}`. `publishRateTable` refuses a value above 100 in every table, override tables included (amendment 8).
7. **Percentage component (d).** It rates one non-percentage base at that base's `gross` or `net` stage.
   - It mirrors each base occurrence (`['pct', occurrence]`) and its timing, so a percentage on an advance fee is billed in advance.
   - It is rounded once. Its rate is read at the base line's opening.
   - E5: 25.92 at the net stage and 28.80 at the gross stage; split 10.80, then 15.12.
   - Refused: an unknown base, itself, another percentage as base, and a discount, timing or array base on the component.
8. **Byte stability.** Measured under Node 22.22.2 and pinned:
   - the result digest of a v4 quote;
   - the result digest of a slice-a v5 review;
   - the quote digest of a slice-a late review.

## Decisions
- Arrears fee terms (rule 17): rated, not refused, because the same owed-set extension serves both timings.
- Recorded in ADR-0083 as unruled choices: the discount applies after the minimum, so a discounted line can fall below the stated minimum (amendment 10(a)). A percentage on the cumulative time line uses the first window's rate (narrower on purpose).
- The early-return term form keeps its timing: held cycles fall due as they open. Only the amount is clipped.
- The served path still reviews only the first arrears cycle until s3b stores checkpoints, so an arrears fee term is reached only in a review whose period start is the final cycle (amendment 3 note).

## Owed
- A fee `minimumTerm` longer than the 3,660-day calendar horizon (for example `{month, 744}`) throws on every early-ended review. It fails closed; a parse refusal is owed (the amendment-6 class).
- Under `earlyReturn.bill: agreedEnd` the committed interval clip also applies to cycles opening after the return. It rates the same committed time the arrears side bills; the review should confirm it.

## Rules 16, 17
(a) Minimum terms suit rentals, leases, subscriptions, coworking and service contracts. Discounts suit any priced line, with per-customer and price-list discounts through overrides. Percentage components cover damage waivers, service charges, environmental fees and insurance. (b) Any recurring fee, time line or meter can use them unchanged. (c) Narrower: percent discounts only (amount discounts are slice f), one base per percentage component, and time in advance is slice e.

## Controls (rule 24; test/evidence/BILLING-1.expected-red.json; 10 new, 2 re-pointed)
New: billing-term-held-cycles, billing-term-prorated-to-end, billing-term-arrears-final-review, billing-committed-cycle-clip (the ruling's control), billing-discount-after-cap, billing-discount-net-entitlement, billing-percentage-at-most-100, billing-percentage-stage, billing-pricing-reader, billing-v5-key-states-timing.
Re-pointed at the new coverage selection: billing-advance-agreed-not-elapsed, billing-advance-final-no-rerate. All 12 reproduced and restored with the local harness.

## Test it yourself
`node --import tsx --test --test-name-pattern='B2 minimum|B13|byte for byte' test/integration/billing-rules.test.ts`

## Review focus
1. The slice-a correction: `committedFrom` and the committed interval (quote.ts), plus the agreedEnd-mode case.
2. The owed set extended by a binding term (occurrences.ts `owedAdvanceOccurrences`), and the arrears condition `through === serviceEnd`.
3. The discount and gross evidence in `line()`; the percentage pass after all lines, including the advance-only path.

```record-claim
{"schemaVersion": "northstar.record-claim/v1", "packet": "BILLING-1-s3a-ii-b", "base": "8104e74980ee22773b7c644ccb3e22aba940a5f1", "head": "cfa86559e48af9b4346a9d64d7d3ffabb738c2e1", "changedPaths": ["docs/decisions/ADR-0083-period-and-usage-billing.md", "docs/execution/packets/BILLING-1-s3a-ii-b.md", "docs/execution/packets/BILLING-1.md", "packages/canonical-model/src/billing-normalization.ts", "packages/canonical-model/src/billing.ts", "packages/customization/src/render.ts", "packages/domain/src/billing/arrears.ts", "packages/domain/src/billing/occurrences.ts", "packages/domain/src/billing/quote.ts", "packages/domain/src/billing/service-use.ts", "packages/domain/src/billing/terms.ts", "packages/postgres-provider/src/billing-quote.ts", "packages/runtime/src/request-runtime-view.ts", "test/evidence/BILLING-1.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/integration/billing-quote.test.ts", "test/integration/billing-rules.test.ts", "test/postgres/request-runtime-view.test.ts"], "symbols": [{"path": "packages/canonical-model/src/billing.ts", "name": "hasBillingPricing"}, {"path": "packages/canonical-model/src/billing.ts", "name": "hasBillingV5Keys"}, {"path": "packages/domain/src/billing/occurrences.ts", "name": "owedAdvanceOccurrences"}, {"path": "packages/domain/src/billing/occurrences.ts", "name": "bindingTerm"}, {"path": "packages/domain/src/billing/occurrences.ts", "name": "termEnd"}, {"path": "packages/domain/src/billing/service-use.ts", "name": "committedIntervalId"}]}
```
