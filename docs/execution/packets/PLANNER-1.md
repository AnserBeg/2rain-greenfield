# PLANNER-1 — map stops and schedule work on a dispatch desk

**Slice 0 · docs only · 2026-11-21.** Fable returned REVISE on `11d0e030`. The orchestrator accepted the amendment at `467535a4` with the clarifications recorded in the ADR. The owner receives the provider estimate for morning sign-off. [Amended ADR](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md)

## Amendments

| Finding | Design decision |
| --- | --- |
| A1 | Map and Planner have closed archetypes, named slots and compact projections. Plan §12.2 includes both and resource timeline. [Grammar](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#1-draw-the-map-on-the-server) |
| A2 | Recommend Geoapify API 25 at USD 109/month before tax for 20 users, 3,000 viewport renders and 1,000 address calls/day. One installation provides suggest, geocode and hosted OSM imagery. PLANNER-1 owns the viewport contract and fake imagery adapter in the existing connector host while CONNECT-1 is inactive. Google requires direct browser delivery. [Provider, terms and cost](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#2-let-connect-1-own-imagery-and-disclosure) |
| A3 | Apply the day, saved filters and route before the 100-stop cap. Pan/zoom queries the visible area. Page by group, stop order and key, with route-local pin numbers and a prompt to narrow. [Map limits](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#5-bound-the-read-before-drawing) |
| A4 | Slice 1 ships the §2a amendment for map-region pan/zoom and drag-to-pan, canonical URLs, three size presets, linked overlay pins and script-off navigation back to the map. |
| A5 | One date drives all panels. The day opens on a 06:00–18:00 axis with 48 quarter-hour starts. Show on map seeks the authorized stop across pages. [Desk](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#4-compose-the-desk-and-review-one-assignment) |
| A6 | Slice 2 ships Schedule, Reschedule, Reassign and Unassign as one-job forms, including Needs time on an assigned row. Booking keeps its single-edge Change interval contract. |
| A7 | Route-order v1 supports a sortable field (truck and interval start by default on the desk) and an explicit next-stop link. The latter has bounded edge, splice, cycle and fork rules. |
| A8 | A job type declares an O1 assignment operation with a stable ID, write/confirm action, protected field pair and schema-backed Customize member. Views bind its released contract. [Operation and forms](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#declare-the-operation-on-the-job-type) |
| A9 | Exclusive capacity uses Booking. Ordinary diary review shows only visible overlapping work as an advisory. |
| A10 | Shared rows carry a standing hidden-work notice. One Restricted map group covers all unreadable targets. A hidden next stop leaves no leg or list hint. |
| A11 | Slice 3 widens behaviour eight under §2a. A drop selects the offered resource and start, then opens Schedule for explicit review. |
| A12 | Per-slice, same-tenant/two-company controls isolate map/list/legend/fit/leg/image, queue, rows/bars, writer and decision fences. No new planner table is planned. [Controls](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#delivery-after-the-targeted-check) |
| A13 | Builder and drafter name unsupported multi-resource jobs, to-many crews, related addresses, live position, bulk moves, bar-body drag and whole-plan publishing. A Route may have its own draft/published lifecycle. |
| A14 | Each slice names its executable dependencies, rungs and stops. Retiring a referenced child refuses the candidate. Escalate a whole-desk budget over 40 statements. |
| A15 | Take the next free ADR number on freshly fetched main at merge and update every reference. The ledger and walkthrough identify `11d0e030` as the reviewed tip. |

**S1–S5 adopted.** Measure the 160-stop day against the 100-segment cap, allow saved resource filters, offer Schedule in the map list, report “7 of 12 on the map” at compact width, and keep company/viewer data out of the public basemap cache key.

## Slices and acceptance cases

1. **Map.** Consume CONNECT-1 Address and implement the viewport seam in the ADR-0080 single-writer framework. The checkpoint uses Demo Maps only, without network or credentials. Geoapify is pending owner approval. Sortable-field order ships first.
2. **Any-resource timeline.** After CALENDAR-1 3a and executable ADR-0087 intervals, bind a truck type and a technician type. Exercise all four forms, race two dispatchers and retry a lost response. Expect one change and receipt. Stop if the writer cannot protect the field pair on every path.
3. **Planner.** After slices 1–2 and CALENDAR-1 1b, schedule by drop and keyboard on separate fixtures. Verify the route, queue and bar after confirm, then advance the common day. Run compact, company and whole-page budget gates.

## Test it yourself

From the packet checkout, run `git diff --stat 630e2aa6 11d0e030` for the reviewed design and `git diff --stat 11d0e030 HEAD` for this amendment. Read the [dispatch walkthrough](../../decisions/ADR-0090-map-resource-assignment-and-planner-workspace.md#4-compose-the-desk-and-review-one-assignment) against these design checkpoints (under ten minutes).

1. Open Today's north route. The stop list and pins use the same stop numbers. Pan north and the area query can reach a stop beyond the first 100. With script off a pin still opens its Record.
2. Schedule a located pickup on truck 12 at 09:00, enter 10:30 and confirm. The pickup leaves the queue, appears on the 09:00 row and joins the truck's line from its stored start. Overlap review describes only jobs the dispatcher can read.
3. Reassign the pickup to truck 7, reschedule it, then unassign it. Each form shows both old and proposed values. A stale second dispatcher sees the permitted current state. A failed background still leaves the list and forms usable.

## Gates

`scripts/check-records.sh` passed for the docs-only amendment. The successful full CI reference below covers the unchanged executable base `630e2aa6`. The live map, writer and browser proofs belong to their executable slices.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44880757599
