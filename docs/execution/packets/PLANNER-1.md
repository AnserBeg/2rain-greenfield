# PLANNER-1 — map stops and schedule a job on a resource

**Slice 0 · 2026-11-21 · proposed design.** The owner chartered this packet for the N4 Surface family. The orchestrator’s independent Fable read precedes implementation and merge. This checkpoint changes documentation only.

## Decisions for review

1. Render a bounded List as a static map and accessible stop list. An explicit next-stop relation establishes each route leg. [ADR-0090 §1](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#1-draw-the-map-on-the-server)
2. CONNECT-1 owns imagery and point provenance. Use an approved OSM installation for live imagery and preserve Google’s attributed-text fallback. [§2](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#2-let-connect-1-own-imagery-and-disclosure)
3. Extend CALENDAR-1’s timeline with a typed resource link, job interval and one atomic assignment operation. Booking retains its capacity and hidden-commitment rules. [§3](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#3-bind-a-timeline-to-the-resource-the-company-uses)
4. Compose Unassigned, Map and Timeline in one shell. Both a drop and the no-script Schedule form open the same Task for review and confirmation. [§4](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#4-compose-the-desk-and-review-one-assignment)
5. Authorize each binding, page by stable keys and meter the entire workspace against one SPEED-1 page budget. [§5](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#5-bound-the-read-before-drawing)
6. Builder and AI author the same immutable revisions. Each incompatible capability earns a rung and needs replay, reader and live drafting proofs. [§6](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#6-publish-replay-and-retire-the-same-choices)

## Slices and their acceptance cases

| Slice | User-visible case |
| --- | --- |
| 0 · Design, this branch | Read the dispatcher scenario and inspect the three owner choices below. |
| 1 · Many-record map | Page 101 stops, follow an authorized leg across pages, retain the unlocated pickup, exercise a provider outage and compare the 390 px list with the graphic. |
| 2 · Any-resource timeline | After CALENDAR-1 3a and typed intervals, bind truck and technician record types. Race two assignments for the same job and retry the winner’s lost response. Expect one change and one receipt. |
| 3 · Planner workspace | Schedule through a drop and through a keyboard-only Task, revoke a grant during review, then fill all three panels and measure the served request. |

## Test it yourself

From this checkout, run `git diff --stat 630e2aa6 16465cce` to see the complete design change. Open the [ADR](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md). Follow the pickup from the list to truck 12 at 09:00. The drop opens Schedule, the person supplies the finish and Confirm commits the reviewed interval. A competing dispatcher gets the current permitted state. In the same example with Google imagery unavailable, the dispatcher can still use the list and finish the Task.

The [owner questions](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#questions-for-the-owner) concern the first live basemap, the meaning of a route line and whether ordinary technician jobs can overlap.

## Gates

The local slice gate `scripts/check-records.sh` passed. The CI reference below is the successful full run on the unchanged executable base, `630e2aa6`. The map, timeline and Task acceptance cases belong to future slices.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44880757599
