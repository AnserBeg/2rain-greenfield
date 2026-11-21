# TRACK-1 — Share a moving subject and an estimated arrival for one trip

**Slice 0 · proposed design amended after REVISE · 2026-11-21.** Docs only. Stop at the pushed packet tip for the targeted check under MIGRATION-RULE 14. Assign the placeholder number at merge. [ADR-XXXX](../../decisions/ADR-XXXX-live-location-and-eta.md)

## Amendments and decisions

| Read item | Design decision |
| --- | --- |
| A1 · Routing (§4) | Google and self-hosted Valhalla both implement planning matrices and live legs under one contract. Each company chooses each use independently. Default to Valhalla for saved matrices and Google traffic-aware for live ETA. Bind reuse to the installation revision and verified rights for storage, duration and display. Report actual traffic use. |
| A2 · Capture (§2) | Phone capture runs in the visible browser Task. Before Start it says **Updates stop when you lock the screen or close this page.** A short server lease, stored-target write grant, open source/consent/duty or pairing intervals, bounded inputs and cross-worker quotas govern every observation. |
| A3 · Customer hand-off (§5) | Close A before opening B. Require a fresh fix whose entire disclosed area clears A's protected site. Use the 250 m approximate area by default, widened for uncertainty, for marker, viewport, frame and ETA origin. |
| A4 · Freshness (§§4, 6) | Show **Position reported at …** and **Estimate calculated at …** separately. Clear each at its applicable two-minute cutoff or earlier deadline. Reauthorize at response time, signal only viewer-visible changes and clear an open view within its ten-second authorization lease. Script-off gets status and Refresh. |
| A5 · Retention (§8) | Enforce 24 hours from observation by default, configurable from 1 hour to 7 days. Shortening caps existing points and derived copies immediately. Extension applies prospectively. Keep holds isolated and reconcile external expiry, key destruction and revocation before restoring service. |
| A6 · Surfaces (§§1, 6) | Bind a trip-independent scoped subject layer to the staff Planner, phone capture to a Task and one verified contact's trip to a Record. Gate capture, refresh and the isolated Google Maps frame on their named ADR amendments. Exercise all three businesses through Customize and the in-app drafter. |
| A7 · Delivery and compatibility (§7 and slice gates) | Publish approval or automatic mode per company rule. Gate automatic sends on the COMMS-1 amendment, bounded grant and canonical worker. Fence retries and replay. Inventory every stored and compiled shape by slice, assign required rungs at merge and enforce tenant deployment floors. |

## Executable slices and controls owed

| Slice | Checkpoint and observation |
| --- | --- |
| 1 · Subject and phone | Try direct gateway/SQL, read-only and AI writes against an otherwise valid stored subject. Use two companies within one tenant. Race withdrawal with a fix and concurrent workers against each quota. Check admitted rows and receipts. Lock the phone, end duty, retry the old lease and restore after shortening. |
| 2 · Trip, device and ETA | Pair a compressor during custody and find it in the scoped subject layer without a trip. Then create its return. Replay a queued fix after re-pairing. Run both operations on both adapters, replace an installation in flight, deny Google storage/display rights and exercise provider failure. Inspect persisted cells, cache, actual calls and the two time labels. |
| 3 · Live maps and link | Serve A, B and the Planner through a hand-off. Check initial HTML, fragment, viewport, frame messages, ETA and SSE for leaks at A. Race revocation against a delayed fragment. Exercise a quiet feed, missed wake, suspension and script-off. Run a busy Planner and active staff chat together against COMMS-2's shared limits and two-second p95. Restore a backup predating shortening and revocation while its old deadline is still in the future. |
| 4 · Message rules | Run no-rule, approval and automatic cases. Kill the worker after grant issuance but before message creation. On retry count one invitation, one message and one provider acceptance. Suppress before handoff and count zero sends. Replay events after expiry and after a release switch away and back. Inspect point, grant, send authority and actual egress. |

At each executable merge, reconcile the slice's actual stored definitions (including optional first-party fields), compiled chunks, bindings, patches, events and storage with the inventory in the ADR. Verify persisted absence parity, stable-ID replay, schema-generated drafter coverage, a real preceding-reader query and named refusal, merge-time rungs and the deployment floor.

## Gates

Slice 0 uses `scripts/check-records.sh`, a named-path diff and whitespace checks. The quick CI run below is for the executable base `0a6780e0`. The runtime checks above belong to their executable slices.

CI tier: quick https://github.com/AnserBeg/2rain-greenfield/actions/runs/44931816188

## Test it yourself

Allow five minutes for this design walkthrough. At the packet tip run `git diff --name-only 45a680bf..HEAD`, `git diff --check 45a680bf..HEAD` and `scripts/check-records.sh`. Expect the ADR, packet and ledger, a clean whitespace check and exit zero.

1. **Delivery.** Follow §§3–7. B holds an early invitation. Mark B next and take a fresh fix while the van is still at A. B gets unavailable, including in the fragment and map frame. After departure clears A, B sees its approximate area and estimate. Revoke while open. Text and frame clear on denial or within ten seconds, even on a quiet connection.
2. **Rentals.** Follow §§1–2, 5–6 and 8. Through Customize and the drafter, put unit 17 on the staff map during custody with no return visit. Pair and re-pair its tracker, then create the return for a verified external depot contact. Back up while the 24-hour policy permits a fix, shorten to one hour and revoke the invitation. Restore at age two hours. The point, estimate and redeemed access stay unavailable.
3. **Field service.** Follow §§2, 4 and 7. Lock the technician's phone and compare the report and calculation times. A recalculation leaves the fix's original two-minute cutoff intact. Compare a company's approved visit notice with another company's automatic rule. An unsubscribe committed before worker handoff suppresses either send.
