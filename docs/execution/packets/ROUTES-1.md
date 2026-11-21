# ROUTES-1 — Build draft routes, review them and send them to drivers

**Slice 0 · docs only · 2026-11-21.** No Critical path touched. Owner charter approved. The packet stops at this pushed design for the orchestrator's independent Fable read. [Proposed ADR-XXXX](../../decisions/ADR-XXXX-route-optimisation.md)

## Claims

1. Dispatch owns feasible assignments for trucks, verified drivers, shifts, jobs, routes and stops through the Semantic gateways.
2. Built-in, Google and company solvers all propose the same typed draft. The domain checks order, windows, load and source authority before staging.
3. Paid egress requires separate disclosure and spend consent, with a worst-case reservation and one attempt. Python reads one sealed, governed matrix and returns evidence.
4. Only explicit approval publishes the exact manifest to its assigned driver. Progress changes estimates within that manifest.

## Decisions

- Keep assignment and publication in Tier B. Use a Dispatch binding of the existing Planner, with a draft edit Task and a separately confirmed publish Task.
- Store a directed, versioned truck travel matrix with contributor lineage. Recommend a regional Valhalla host behind CONNECT-1.
- Default Google off. Recommend USD 3/run, USD 15/day and USD 150/month after the exact workflow is licensed.
- Publish to the signed-in driver's My routes List. Update estimates from actual progress and review a replacement before departure.
- Add dispatch and solver revisions by stable ID. Ship visual builder, schema-generated drafter, live evals, replay, persisted parity and reader refusal with each capability.

## Slices

| Slice | Checkpoint |
| --- | --- |
| 0 · Design | [Walk the ADR](#test-it-yourself). Stop for Fable. |
| 1 · Built-in | After PLANNER-1 and CONNECT-1 dependencies land, plan the excavator delivery and pickup. Confirm once, then see one driver manifest. Complete a stop late and verify the revised ETA. |
| 2 · Google | Review a fleet solve quote. Refuse an over-cap attempt before egress. Exercise live only with the licensed entitlement. |
| 3 · Company solver | After ANALYZE-1's saved evidence and Task handoff land, run a recipe on the stored matrix. Stage its valid result, then approve the manifest in a separate Task. |

## Controls for executable slices

- Slice 1 proves same-tenant company isolation, stale-fence refusal, absence of draft driver access, one winner under contention, and capacity on the loaded return leg.
- Slice 2 proves the last reservation holds under contention, an ambiguous attempt cannot repeat, and blocked provider rights yield zero transport calls.
- Slice 3 proves revoked or purged source evidence and forged/duplicate visit IDs cannot stage a draft, and a valid recommendation alone gives the driver no access.

## Gates

Run `scripts/check-records.sh` and check the three docs for whitespace errors. The CI reference below is the full **base** run at `630e2aa6`, whose executable tree the design shares.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44880757599

## Test it yourself

1. On the packet branch, run `git diff --name-only 630e2aa6...HEAD`. Expect only the ADR, this record and the ledger. Run `scripts/check-records.sh`.
2. In ADR §§1–3, put the excavator delivery before the 09:00 pickup. Follow the window, load and return-leg checks. If the matrix is incomplete, the proposal refuses with the previous draft intact.
3. In §§4–6, try a 100-job fleet run with USD 2.99 remaining, switch release away and back on a separate prepared approval, then follow a fresh successful approval. The first two refuse. The driver sees the manifest only after the fresh yes.
4. Follow a late unload in §6 and the company's recipe in §2. The estimate changes without changing order. The recipe must pass a draft Task and a separate approval before a driver can see its route.
