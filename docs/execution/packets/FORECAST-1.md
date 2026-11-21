# FORECAST-1 — Switch on a forecast or bring a custom model

**Slice 0, proposed 2026-11-21.** N5 design · Docs only · Critical paths untouched · Stop at the pushed design for the orchestrator’s independent Fable read. [Proposed ADR](../../decisions/ADR-XXXX-forecasting.md)

ANALYZE-1 received ACCEPT WITH AMENDMENTS. The design uses A5, A6 and A8 and depends on the amended runner, evidence and Task contracts for slice 5. Approved source contracts are separate prerequisites for the standard methods, especially reconciled cash and rental capacity.

## Claims

1. An authorized owner can publish Cash, Demand and stock-out, or Rental utilisation from stable bindings and reviewable assumptions. Each result states its scope, cut and units.
2. Standard backtests use only facts available at each forecast origin, compare with separately governed actuals and identify absent coverage. Analyze owns custom output and its access checks.
3. Every estimate is evidence. A suggested action starts a separately governed, editable Task. Grants and confirmation come from the operation.

## Decisions

- Commission the three standard methods as Q2 calculations over declared query contracts. O0/O1 handle evidence and job state. [ADR §1](../../decisions/ADR-XXXX-forecasting.md#1-register-three-standard-calculations)
- Publish assumption defaults as immutable revisions. Pin a private what-if to its exact typed assumptions. [ADR §2](../../decisions/ADR-XXXX-forecasting.md#2-give-each-set-of-assumptions-a-version-people-can-compare)
- Capture once under the person’s grants, publish with audit, and recheck all contributing data when serving any saved evidence. [ADR §3](../../decisions/ADR-XXXX-forecasting.md#3-capture-once-publish-once-reauthorize-each-read)
- Render with the existing List, Record, Task and Builder grammar, including script-off operation. [ADR §4](../../decisions/ADR-XXXX-forecasting.md#4-a-forecast-uses-the-existing-screen-grammar)
- Backtest by forecast origin and lead time against paired actuals and a simple baseline. [ADR §5](../../decisions/ADR-XXXX-forecasting.md#5-backtest-against-what-people-could-have-known)
- Reuse Analyze for custom recipes, repeat and saved evidence. Permit a prefilled Task as the only handoff towards action. [ADR §6](../../decisions/ADR-XXXX-forecasting.md#6-a-custom-model-runs-in-analyze)
- Prove a reader rung per capability, persisted absence parity, compatible and conflicting replay, and schema-generated drafter coverage at introduction. [ADR §7](../../decisions/ADR-XXXX-forecasting.md#7-admit-each-capability-at-its-merge)

## Slices

| Slice | Test it yourself at its checkpoint |
| --- | --- |
| 0 · Design | Follow the examples in [the walkthrough below](#test-it-yourself). |
| 1 · Cash | Switch on Cash. Run the 13-week projection, move payroll by a week and save a new estimate. Change the source cut and see the forecast withheld. |
| 2 · Demand and stock-out | Select one yard and part. Run Demand, move a confirmed delivery date and see the at-risk date change without double-counting the order. |
| 3 · Rental utilisation | Switch on Rental. Mark one fleet unit down, change the expected return of a rented unit and compare occupied hours and capacity. |
| 4 · Backtest | Score a closed holdout against the baseline, then use a date with missing historical source coverage. See the missing origin and the paired sample count. |
| 5 · Custom models | Publish a recipe binding and run it from Forecasts. Open its suggested purchasing review Task and observe that opening it leaves the order unchanged. Revoke one source field and reopen the evidence link. |

## Controls for the executable slices

- Put a receipt in opening cash and leave its invoice open at an incompatible cut. Check for refusal. On a day with baseline demand of six and eight units already committed, check that only eight are deducted.
- Overlap a maintenance block, a booking and possession for the same unit. Observe one occupied interval, one exclusion and visible conflict pressure.
- Use two companies in one tenant and a now-hidden input field. Mutate the company, field, fence and audit checks separately and observe that an estimate or an unaudited version would otherwise escape. Retry the same save and prove one version and one receipt.
- Add a correction recorded after the forecast origin and a guest result suggesting a protected field. Prove the correction is absent from the forecast input and the suggestion cannot prepare a write. Probe each preceding reader’s own refusal path.

## Gates

Local design gate is `scripts/check-records.sh`. The CI citation is the successful base run at `630e2aa6`, whose executable tree this design keeps. The Fable read is pending. This narrative checkpoint declares no executable claims and carries no record-claim block.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44880757599

`ADR-XXXX-forecasting.md` is provisional because BOOT-CHECK, PLANNER-1, ANALYZE-1 and COMMS-2 claimed 0090. At merge fetch main, take the next free number, rename the ADR and update its heading, inbound links and the ledger row, then re-fetch before pushing. Reader rungs and migration numbers are also allocated at executable merge.

## Test it yourself

1. From `packet/FORECAST-1` run `git diff --name-only 630e2aa6...HEAD`. Expect the proposed ADR, this packet record and the ledger.
2. Read ADR §1 and follow the cash example. The four amounts close at $34,000. Then assume the opening already includes the $12,000 receipt. The residual contributes zero. Follow the stock example to closing balances of 10 and 11 and the rental example to 50%.
3. Read §§3, 5 and 6. Follow a manager who loses an input field, a backtest with a correction recorded after the origin, and a buyer who opens a suggested Task. Expect evidence withheld, the correction excluded from the forecast input, and no business write on open. This walkthrough takes under ten minutes.
