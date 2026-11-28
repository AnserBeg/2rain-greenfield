# BILLING-1 s3a-ii — per-component timing, minimum charge, discounts, percentage components

Design note, 2026-11-28. Builds on owner rulings B2/B13 (2026-11-28). Code refs are `file:line` at `packet/BILLING-1-s3a-i` tip `608d304b` (not yet on main); ADR refs are to that tip's ADR-0083/0084.
**No STOP.** Every ruling can be built with the blocks that exist. Advance billing under `keepPaidPeriod` never returns value, so it does not need the credit-on-account remedy that ADR-0083:74 and ADR-0084:15 were waiting for. `prorateAndRefund` does need it, and it is refused as the owner ruled.

## 1. Where timing lives
- New optional key on `time` and on `fixed` with `occurrence.kind = recurring`: `timing: {when: 'advance'|'arrears', earlyEnd?: 'keepPaidPeriod'|'prorateAndRefund'}` (component union, billing.ts:52-113). If `earlyEnd` is absent it means `keepPaidPeriod`.
- Stored bytes keep their meaning: an absent `timing` means arrears, so v2–v4 plans replay unchanged (the same replay rule as billing.ts:362-387). The ruled default ("fixed period rent in advance") is applied by the author surface: Customize and the drafter write `when: 'advance'` on recurring fixed components and on period-rate time components. The parser never infers it.
- These always bill in arrears: `meter` (usage and overage), `oneOff` at `serviceEnd`, and any arrears fixed fee (fuel, damage). `oneOff serviceStart` keeps its current rule (quote.ts:443-461).

## 2. Advance billing, the closed-only filters, and partial periods
- Today every path is closed-only: `dueArrearsCycle` returns only a closed cycle (arrears.ts:53); fees and meters filter `o.closed` (quote.ts:469, quote.ts:528); and `coverageThrough > asOf` refuses (quote.ts:218-219).
- New `dueAdvanceCycle(plan, evidence)` in arrears.ts returns the cycle that contains `asOf`, if the plan has an advance component, `start <= asOf`, and `start < serviceEnd` (or the service is open). A review then returns two sets of lines:
  - arrears lines for the cycles that have closed, exactly as today;
  - advance lines for the open cycle, rated through `advanceThrough = min(cycle.fullEnd, agreedEnd)`.
- The arrears filters stay as they are. `advanceThrough` is a new evidence field, used only by advance components. It may pass `asOf` only by that one open cycle; anything more refuses.
- Advance amounts are rated on **agreed** coverage. A review keeps the original agreed end as new evidence `agreedEnd`, because `serviceUseEnd` overwrites `serviceEnd` (arrears.ts:69-77) and `billing-quote.ts:131,198` is where that value comes from.
- Fixed fee in advance. The occurrence ID is unchanged (`['fee', fullStart]`, quote.ts:481), and so is the fraction. `feeProration: activeCoverage` prorates by agreed coverage over the full cycle (quote.ts:613-619). The first cycle starts at `max(fullStart, anchor)` (occurrences.ts:94), and the last ends at `agreedEnd`. An open-ended agreement bills the whole next cycle. The advance amount is **final**: when the cycle closes it is not rated again.
- Time in advance. The cumulative time line (`['time', band]`, quote.ts:419-426) is priced over `actual active ∪ agreed[anchor, advancedThrough)`, through `max(through, advancedThrough)`. `advancedThrough` is the `advanceThrough` of the latest cycle whose start is before `min(asOf, serviceEnd)`. This makes billed agreed time a floor: a pause or an early return cannot reduce it, while an overrun adds actual time on top, billed in arrears.
- Pauses. Advance together with `fixedFeeDuringPause: suspend` refuses, because suspending would need a refund. Absent normalizes to suspend (billing-normalization.ts:31), so an advance fee must say `continue` explicitly.
- Statelessness. Reviews read no prior allocations today (`allocations: []`, billing-quote.ts:212). `keepPaidPeriod` is therefore a pure function of the evidence: an advance occurrence whose start is before the service end is owed. Shortening an agreement after an advance review changes only that review. Once slice 5 persists coverage, the existing allocated-plus-reserved subtraction (quote.ts:350-353) applies, and under v5 a **negative difference on an advance line refuses** ("needs a credit") instead of producing a negative line.

## 3. Early end and the minimum charge from the agreed start
- `keepPaidPeriod`: no line ever refunds a cycle that has opened, and no cycle opens at or after the service end (`earlyReturn.bill: actualEnd` sets that end, service-use.ts:157-161). `prorateAndRefund` is refused at compile time until open items and customer credit balances exist.
- The minimum term is a **minimum charge**:
  - On `time` it is the existing `minimumDuration` with `minimumScope: perEnrollment`, which is the default (billing-normalization.ts:13). The floor is the best-cover price of the term from the first positive window's `w.day` (cover.ts:317-347, quote.ts:376-389). It is applied to the cumulative total (quote.ts:417-418). Windows are anchored at the agreed start field (billing-quote.ts:130), so a late pickup does not move it.
  - On recurring `fixed` it is new: `minimumTerm {period, count}`, measured with `minimumTermEnd` (arrears.ts:102-112). When the service ends early, the fee for the coverage `[service end, termEnd)` that has not yet been billed becomes due at the service end. It uses its natural occurrence IDs, and the occurrence that crosses `termEnd` is prorated to `termEnd`.
- `earlyReturn.minimumTerm` (committed time held open, service-use.ts:216-234, arrears.ts:70-76) still reads for v4 plans. A plan that uses any v5 key and also declares it refuses: two forms for one rule.
- Limits:
  - A time minimum must fit inside its pricing window (cover.ts:338).
  - "Positive active time only" stands (ADR-0083:42). A no-show is still refused (ADR-0083:82). UNVERIFIED whether the owner wants a no-show to owe the minimum; that is not in the ruling.

## 4. Discounts (B13)
- New optional key `discount` on `time`, `fixed` and `meter`:
  - `{kind: 'percent', rate: <percentage slot>, reason: <code id>}`;
  - `{kind: 'amount', amount: <money slot>, reason}`, on fixed and meter only.
- New slot kind `{kind: 'percentage', scale <= 4}` (beside money and quantity, billing.ts:209-222). The publish operation refuses values above 100. Values are effective-dated table values, so the existing customer and price-list override precedence (billing.ts:308-312, ADR-0083:48) gives per-customer discounts without new machinery.
- Stage: after the minimum and the cap, before tax.
  - Time: in each window, net = capped × (1 − p) under that window's pinned terms (quote.ts:390-395). The perEnrollment floor is discounted at the first positive window's rate, then the result is × quantity (quote.ts:424).
  - Fixed: amount × fraction × quantity, then the discount.
  - Meter: overage × rate, then the discount. The allowance is never discounted.
- Cover selection (bestPrice, ladder, prorate) runs on undiscounted prices. A percentage discount scales every candidate equally, so the winning cover does not change. An amount discount on time is refused: the time line is one cumulative occurrence per service, so "once per what" would be ambiguous.
- An amount discount applies once per occurrence and is never prorated (as for one-off amounts, ADR-0083:45). It is clamped so the net is ≥ 0; a clamped line is a 0.00 line carrying its evidence. No negative lines (ADR-0083:101).
- Evidence: `BillingQuoteLine` (quote.ts:100-114) gains `discount: {kind, rate|amount, reason, rateVersion, grossExact, discountExact, grossCents, discountCents}`. `exactEntitlement` and `entitlementCents` are the net, rounded once (quote.ts:338). `discountCents = grossCents − netCents`, so the displayed gross = net + discount exactly. The line keeps the rated net as authoritative (ADR-0084:12), and the discount evidence goes to the explanation (ADR-0083:57).

## 5. Percentage component (the reserved row, ADR-0083:35)
- New kind `{kind: 'percentage', id, taxClassification, rate: <percentage slot>, base: {componentId, stage: 'gross'|'net'}, stage: 'afterCapBeforeTax'}`.
  - `gross` means after the minimum, cap, proration and quantity; `net` means after the discount.
  - There is no default stage (like `allowanceBasis`, ADR-0083:46). Tax is never a base: there is no tax stage to name (ADR-0083:37).
- It mirrors its base's occurrences: occurrence `['pct', <base occurrence>]` on the cumulative time line, or per fee or meter occurrence. Its timing is its base's timing, and it is rounded once on its exact base.
- V5 limits, refused at compile time: exactly one base; the base cannot be a percentage component, the component itself, or an unknown ID; no `discount` or `timing` key on a percentage component.

## 6. ADR text changes (made in the build slice, not in this note)
- ADR-0083:74 ("Arrears only in v1") becomes: timing per component; advance admitted under `keepPaidPeriod`; `prorateAndRefund` waits for customer credit balances. ADR-0083:56: recurring fees settle "at their declared timing". ADR-0083:129: delete "Keep advance gated…".
- ADR-0083:35: the reserved row becomes the `percentage` kind. ADR-0083:37: discount stage between "cap" and "other pre-tax charges". ADR-0083:89: in v5 the minimum term is a minimum charge from the agreed start.
- ADR-0083:103: advance Generate is a new commitment, so a credit hold or limit refuses it (enforced when drafts land, slice 5). ADR-0084:15, last sentence: "Prorate-and-refund awaits credit-on-account or refunds". New §"Timing and discounts under calculation v5".

## 7. Version, reader, refusals
- Calculation `northstar.billing-calculation/v5`, and a new reader constant `BILLING_TIMING_READER`. It is provisionally the next rung after `BILLING_RULES_READER` = 54 (billing.ts:15); UNVERIFIED what rung 54 became at merge. The rung is taken at merge on freshly fetched main (ADR-0083:123).
- `hasBillingTiming(plan)` covers `timing`, `discount`, `percentage` components, fixed `minimumTerm` and `percentage` slots. It extends `billingReleaseTerms`, `billingReleaseMismatch` and the calculate gate (billing.ts:394-454, quote.ts:215).
- Schema refusals (superRefine, billing.ts:228-286): advance on a meter or one-off; advance + suspend; `prorateAndRefund`; v5 + `earlyReturn.minimumTerm`; an amount discount on time; a discount or percentage rate not on a percentage slot; the percentage base rules in §5.
- Compiler refusal: advance time with no `agreedInterval` binding (compiler billing.ts:136-186). Runtime refusals: `advanceThrough` beyond one open cycle; a negative advance difference; publishing a percentage value above 100.

## 8. Worked examples (exact; Edmonton zone; CAD)
| # | Facts | Result |
| --- | --- | --- |
| E1 | Fixed fee 300/month, advance, calendarMonth, activeCoverage, agreed from Jun 10 2027, open-ended; ends Jul 12 | Jun 10: 210.00 (21/30). Jul 1: 300.00. Ended Jul 12: no refund, August never opens. Total 510.00. |
| E1m | E1 + fixed `minimumTerm {month,3}` (term ends Sep 10) | Due Jul 12: Aug 300.00 + Sep 1–10 90.00 (9/30). Total 900.00 = 3 × 300. |
| E2 | 30/day only, `actualEnd`, `minimumDuration {day,7}` perEnrollment; booked 7 days, returned day 3 | 210.00, due on day 3 (v4 `minimumTerm` was 210.00 due on day 7, ADR-0083:89). Picked up day 1, returned day 3: still 210.00. |
| E3 | 30/day or 100/week, four-week window, cap 240, 20 active days, 10% discount; invoices after day 7 and day 20 | 90.00 (gross 100, discount 10.00), then 126.00. Final net 216.00 = gross 240 (300 capped) − 24.00. |
| E4 | 20/day or 100/week ladder, 10 days (160, ADR-0083:87), quantity 2, 15% | 320 gross − 48.00 = 272.00. Fixed 5 seats × 15 = 75, amount discount 10: 65.00; amount discount 100: 0.00 line with discount 75.00. |
| E5 | 12% waiver on E3's time line, stage `net` / `gross` | 25.92 / 28.80. Split as E3 (net): 10.80, then 15.12. |
| E6 | 30/day, fixedDays 7, time advance, agreed 10 days | Day 0: 210.00. Day 7: 90.00. Returned day 12: +60.00 arrears (12 days = 360). Returned day 5 (`actualEnd`): 210.00 total, cycle 2 never opens. |

## 9. Rule 8 reds (one per check; `test/evidence/BILLING-1.expected-red.json`)
Timing: advance-open-cycle (E1 Jun 10), advance-first-partial (21/30), advance-agreed-end-clip, advance-final-no-rerate, keep-paid-period (E1 end), no-cycle-after-end, arrears-closed-only-in-advance-plan (meter), advance-agreed-not-actual, time-advance-floor (E6 day 5), time-overrun-arrears (E6 day 12).
Minimum: fixed-minimum-term (E1m), minimum-from-agreed-start (E2), minimum-late-pickup. Discount: discount-after-cap (E3), discount-floor, discount-selection-unchanged, discount-per-quantity (E4), amount-discount-clamp, discount-evidence-cents.
Percentage: percentage-stage-net, percentage-stage-gross, percentage-cumulative-split (E5). Plus one red per refusal in §7, and v5-selection, v4-replay-bytes, reader-floor.

## 10. Thin end-to-end slice to build first (s3a-ii-a)
Fixed recurring `timing.when: advance` + `keepPaidPeriod` on an agreed-interval plan; `dueAdvanceCycle` + `advanceThrough`/`agreedEnd` evidence; v5 + reader, served through the released quote query (billing-quote.ts:264-318). Refusals: advance meter, advance + suspend, `prorateAndRefund`. Reds: advance-open-cycle, advance-first-partial, keep-paid-period, no-cycle-after-end, v5-selection, v4-replay-bytes. Test it yourself: E1 in `test/integration/billing-rules.test.ts`.
Then, in order: (b) minimum charge (E2, E1m); (c) percent discount; (d) percentage component; (e) time advance (E6); (f) amount discount.
