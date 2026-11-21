# FORECAST-1 — Switch on a forecast or bring a custom model

**Slice 0, amended 2026-11-21.** N5 design · Docs only · Critical paths untouched. The independent read of `8a10ecff` returned **ACCEPT WITH AMENDMENTS**. This is the one amendment round. The checkpoint ends at the pushed design. [Proposed ADR](../../decisions/ADR-XXXX-forecasting.md)

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
- The four owner rulings adopted 2026-11-21 cover reconciled opening cash, private what-ifs and reviewed protected defaults, company-owned serialized rentals with overdue exposure, and Model-reported custom scores in Analyze. [Owner rulings](../../decisions/ADR-XXXX-forecasting.md#owner-rulings-adopted-2026-11-21)

## Review amendments

- **A1** proves full population authority from scope and grants before examining rows, including on saved-evidence reads. [ADR §3](../../decisions/ADR-XXXX-forecasting.md#3-capture-once-publish-once-reauthorize-each-read)
- **A2** reconciles movements and residuals at the cash cut and covers same-cut unapplied deposits. [ADR §1](../../decisions/ADR-XXXX-forecasting.md#1-register-three-standard-calculations)
- **A3** gates slice 4 on frozen holdout selection, per-origin learning and the late fifth settlement test. [ADR §5](../../decisions/ADR-XXXX-forecasting.md#5-backtest-against-what-people-could-have-known)
- **A4** gates rental on unioning all claims by physical unit and exposing conflict and unknown return. [ADR §1](../../decisions/ADR-XXXX-forecasting.md#1-register-three-standard-calculations)
- **A5** gates standard execution and scoring on gateway purpose and direct and nested evidence refusals. [ADR entry conditions](../../decisions/ADR-XXXX-forecasting.md#entry-conditions-from-the-independent-read)
- **A6** gates assumption surfaces on company/field and private trial checks and comparable captures. [ADR §2](../../decisions/ADR-XXXX-forecasting.md#2-give-each-set-of-assumptions-a-version-people-can-compare)
- **A7** assigns live and backtest contracts to slices and packs, requires three equipped first-party packages, and assigns Q2 family admission to slice 1. [ADR source dependencies](../../decisions/ADR-XXXX-forecasting.md#source-dependencies-and-first-party-switch-on-packages)
- **A8** gates each slice on its reader inventory, archived loader, persisted parity, replay and live variant-specific draft/preview/replay. [ADR entry conditions](../../decisions/ADR-XXXX-forecasting.md#entry-conditions-from-the-independent-read)
- The result Record explains its first exception using authorized facts. [ADR §4](../../decisions/ADR-XXXX-forecasting.md#4-a-forecast-uses-the-existing-screen-grammar)

## Slices

| Slice | Test it yourself at its checkpoint |
| --- | --- |
| 0 · Design | Follow the examples in [the walkthrough below](#test-it-yourself). |
| 1 · Cash | Switch on Cash. Run the 13-week projection, compare payroll dates on the same facts and save a new estimate. Check a mismatched cut and a same-cut deposit with an unresolved application. Both withhold the balance. |
| 2 · Demand and stock-out | Select one yard and part. Move a confirmed delivery date and read the first shortfall explanation. Compare discovery and run under the same limited grant before and after the hidden team places an order. |
| 3 · Rental utilisation | Switch on Rental. On one unit, overlap maintenance, overdue possession and the next customer’s booking. Compare served and unserved hours and see the unknown return. |
| 4 · Backtest | Score a frozen holdout against the baseline, including a missing origin. Apply a later assumption revision to those facts and see **Retrospective scenario**. |
| 5 · Custom models | Publish a recipe binding and run it from Forecasts. Open its suggested purchasing review Task and observe that opening it leaves the order unchanged. Revoke one source field and reopen the evidence link. |

## Controls for the executable slices

- Reconcile a mismatched cut and a same-cut unapplied deposit through the named cash controls. On a day with baseline demand of six and eight units already committed, check that only eight are deducted.
- Overlap maintenance with possession and a different customer’s booking for the same unit. Observe the served union, one maintenance exclusion and visible unserved pressure.
- Use two companies in one tenant and a now-hidden input field. Mutate the company, field, fence and audit checks separately and observe that an estimate or an unaudited version would otherwise escape. Retry the same save and prove one version and one receipt.
- Record the fifth settlement after the forecast origin and check that the historical run still uses its four-sample fallback. Refuse a forecast-as-actuals binding and a guest suggestion for a protected Task field. Probe each preceding reader’s own refusal path.

## Gates

Local design gate is `scripts/check-records.sh`. The citation below is inherited full CI at base `630e2aa6`. The reviewed design SHA is `8a10ecff`. This amendment push has its own CI result once available. This narrative checkpoint declares no executable claims and carries no record-claim block.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44880757599

`ADR-XXXX-forecasting.md` is provisional because BOOT-CHECK, PLANNER-1, ANALYZE-1 and COMMS-2 claimed 0090. At merge fetch main, take the next free number, rename the ADR and update its heading, inbound links and the ledger row, then re-fetch before pushing. Reader rungs and migration numbers are also allocated at executable merge.

## Test it yourself

1. From `packet/FORECAST-1` run `git diff --name-only 630e2aa6...HEAD`. Expect the proposed ADR, this packet record, the ledger and `learnings.md`.
2. Read ADR §1 and follow the cash example. Both reconciled variants close at $34,000. With the deposit already in opening cash and its relationship to the outstanding invoice unresolved, the projection is withheld. Follow the stock example to closing balances of 10 and 11 and the rental example to 50%.
3. Read §§3, 5 and 6. Follow a restricted buyer before and after a hidden order is placed, a backtest whose fifth settlement was recorded after the origin, and a buyer who opens a suggested Task. Expect the same generic denial, a four-sample fallback and an unchanged order. This walkthrough takes under ten minutes.
