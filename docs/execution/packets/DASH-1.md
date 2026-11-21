# DASH-1 — build a dashboard from the same charts and views used elsewhere

**Slice 0 · design only · independent read pending.** Packet branch `packet/DASH-1`. The owner approved the capability on 2026-11-21. No Critical path or executable change. The ADR number and reader rungs are assigned at their respective merges. [Proposed ADR](../../decisions/ADR-XXXX-dashboards-and-charts.md)

## Design claims and decisions

| Decision | Reason and alternative considered |
| --- | --- |
| 1. Dashboard has `title`, `savedViews`, `sharedFilters`, `panels`. A dashboard references PLANNER-1’s general workspace. | A common panel order and shared context serve the grid, mobile stack and accessible reading order. A second grid or a widened Home would duplicate these rules. |
| 2. Register ten chart parts with server-rendered graphics, summaries, tables and mark-level drill. | One typed result keeps the accessible value equal to the plotted value. A client chart library adds independent rendering and calculation. |
| 3. Use released queries and reports for every value and contributor drill. | Provider-side policy applies before aggregation. Summing a visible page gives wrong totals and reusing an author's preview exposes someone else’s data. |
| 4. Bind each declared URL filter to every panel. | One validated company and period make tiles comparable. An unfiltered sibling would mislead the reader. Frozen evidence must match its capture parameters. |
| 5. Use the working company’s UI-COMPOSE brand and the Ledger light/dark tokens. | Tested patterns, labels and contrast keep series and statuses legible. Free-form colours defeat those checks. |
| 6. Builder and AI draft the same stable-ID revisions, then preview, approve and activate. | Exact choices replay across relabels. Re-deriving a member from current fields broke earlier layouts. |
| 7. Meter one page and cache only identical reads inside its snapshot. | Eight panels share four distinct data requests and one DB budget. A cache spanning requests can outlive a grant. |
| 8. Use native highlight and propose bounded tooltip and filter behaviours under ADR-0036 §2a. | Pointer and keyboard users get the same server data. A chart runtime or streaming feed would exceed the needed client capability. |

## General blocks and the businesses they serve (rule 16)

Each column describes a configuration a business can author. Platform code resolves contracts and stable IDs. Domain-specific measures come from the business’s released queries.

| Block | Rental yard | Distributor | Clinic |
| --- | --- | --- | --- |
| Bar | late returns by yard | back orders by depot | visits by site |
| Line | daily units on hire | units shipped by week | visits by day |
| Area | hired hours by week | occupied pallet spaces by day | booked chair-hours by week |
| Stacked bar | hired hours by class and yard | shipments by service level and depot | visits by type and site |
| Donut | fleet by state | orders by state | visits by attendance state |
| KPI, sparkline and comparison | invoiced CAD vs last month | shipped cases vs last month | completed visits vs last month |
| Gauge | fleet utilization | bin occupancy | booked capacity |
| Funnel | enquiry → quote → hire | lead → order → ship | referral → book → attend |
| Table | late contracts | replenishments due | unconfirmed sessions |
| Heat grid | hires by yard and weekday | picks by depot and shift | bookings by site and hour |
| Query, count and contributor drill | overdue contracts | unavailable items | outstanding referrals |
| Workspace panels and lists | return desk | replenishment desk | reception desk |
| Map | pickup sites | delivery stops | home visit locations |
| Timeline | equipment reservations | loading bays | clinician schedules |
| Saved evidence image and table | demand forecast | shortage forecast | session demand forecast |
| Shared filters and URLs | month and yard | shift and depot | day and site |
| Company branding | yard group | distribution group | practice group |
| Customize, AI and real preview | draft yard utilization | draft stock-out summary | draft tomorrow’s appointment load |
| Batched reads | counts and returns in one shift | stock-outs and alerts in one depot | site KPIs and agenda in one session |

## Slices and gates

| Slice | Test it yourself at that checkpoint |
| --- | --- |
| 0 · Design | Use the walkthrough below. Stop for the independent read before executable work. |
| 1 · Chart on a report or Record | With the host placement and governed inputs available, draft a chart in Builder and by prompt. Switch themes, read its table and follow a mark using only the keyboard. |
| 2 · Shared dashboard | Requires the general PLANNER-1 panel contract on main. Activate the three dashboards, copy a filtered URL and reopen it at 390 px. Exercise replay, older-reader refusal and the whole-page meter. |
| 3 · Operational views and evidence | Add a declared list, map, timeline and saved evidence once their owners ship. Change the date and verify the image’s labelled capture or empty eligible selection. |
| 4 · In-place inspection | After the §2a decision, apply two filters in quick succession, use Back and compare the same chart, table and drill with script disabled. |

**Controls owed with code.** In one tenant/environment give a single-company viewer two authorized overdue returns, hide a third and place a fourth in another company. The mark, total, table, assistant and drill must each expose exactly the first two. Remove the company and row predicates independently and observe each test fail. Revoke a required measure or evidence contributor between requests and check HTML, tooltip, direct drill and image bytes. Verify the current verifier rejects an understated floor and the preceding production loader refuses the correctly declared capability by name. Remove the report work cap on a cap-plus-one fixture and observe actual provider work. No executable proof is claimed at slice 0.

Quick CI below is for the design commit `ef4f1a77`. The packet record and ledger follow in a docs-only commit with `scripts/check-records.sh` as their local gate.

CI tier: quick https://github.com/AnserBeg/2rain-greenfield/actions/runs/44955584947

## Test it yourself · slice 0 (about five minutes)

1. Open the [ADR](../../decisions/ADR-XXXX-dashboards-and-charts.md). Follow the clinic’s request through `sharedFilters` to a heat-grid hour, its table cell and the authorized appointment List. At 390 px find the same three steps in reading order.
2. Use the two-return fixture above. The expected count is **2** everywhere. Removing the measure grant yields **unavailable**. An unrelated List’s first page, a shared URL and an old preview cannot supply a replacement number.
3. Walk a yard/date change through a live List and a saved forecast from a different period. The List reruns. The evidence panel can offer only an authorized matching version. Confirm that neither case can leave last month’s pixels under this month’s heading.
4. Read the four owner questions at the end of the ADR alongside the proposed grammar row, client gates and eight-panel budget. Runtime walkthroughs start with slice 1.
