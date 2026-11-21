# TRACK-1 — Share a moving subject and an estimated arrival for one trip

**Slice 0 · proposed design · 2026-11-21.** Docs only. No Critical paths touched. Stop at the pushed design for the orchestrator's independent read. The placeholder ADR takes its number at merge. [ADR-XXXX](../../decisions/ADR-XXXX-live-location-and-eta.md)

## Claims for the read

1. A delivery company, rental yard and field-service office can each declare a subject, destination, trip and optional sharing rule in Customize or with the in-app drafter.
2. A phone or verified equipment tracker can supply an attributed position. A person controls sharing during their active period. The assistant can read under grants and has no position-writing authority.
3. A contact may see a current position and estimated arrival for one eligible trip. Revocation, a change of stop or a stale source also affect an already-open view.
4. The company chooses manual or automatic link delivery per COMMS-1 rule. Both use the same consent, unsubscribe, audit and idempotent delivery.

## Decisions

1. Declare trackability by stable record type and bind visits and share rules separately so a compressor and a technician use the same building blocks (§1).
2. Admit attributed observations through one rate-limited source contract so pairing, duty and withdrawal apply to every writer (§2).
3. Drive a visit with governed transitions and one durable event per change so a retry has one effect and passing a site cannot mark arrival (§3).
4. Cache a company-selected routing estimate for the active leg so opening a map never incurs a routing call (§4).
5. Bind an expiring, revocable link to one verified contact, trip and visibility window so a forwarded link cannot disclose another customer's work (§5).
6. Use the Google Planner map and COMMS-2's SSE invalidation plus an authorized refresh to keep staff and contact views current (§6).
7. Publish the send mode in the company's COMMS-1 rule so the delivery desk can automate and the service office can review (§7).
8. Give raw positions a company retention deadline, including on restore, so the lasting trip and audit records do not become a movement history (§8).

## Slices

| Slice | Test it yourself at that checkpoint |
| --- | --- |
| 0 · Design | [Walk the three businesses and inspect the changed paths](#test-it-yourself). |
| 1 · Subject and phone | Publish Technician and Compressor in Customize and by AI. Consent, start sharing, lock the phone and end the shift. Check the last accepted observation and retention expiry. |
| 2 · Trip, device and ETA | Pair the compressor's tracker. Start a return to the yard, resend a fix, change destination and disconnect routing. Check one accepted fix, the estimate and its age. |
| 3 · Live maps and link | On a two-stop trip, open the staff map and each contact's link. Advance a stop, revoke, refresh and reconnect with the earlier page still open. |
| 4 · Message rules | Try no rule, manual and automatic on separate trips. Unsubscribe before handoff and replay Start. Inspect delivery receipts and access audit. |
| Later · Installed capture | Test background permission, screen lock and visible withdrawal on the target OS before admitting that source. |

## Controls owed by executable slices

- Isolate company scope using two legal entities in one tenant/environment, the true owner and valid grants. Compare wrong-company and unknown results on each entry path.
- Race withdrawal or duty end against capture and disclosure. Try the AI, a forged source, an expired device pairing and a rate burst. Observe accepted rows and actual bytes disclosed.
- Race a delayed ETA or fragment against a stop change or revocation. Inspect the response, marker, list, extents, text and access audit. Restore expired history and verify it stays unavailable.
- Count one trip event, grant, message and fake provider acceptance after retry. Withdraw consent before handoff and observe zero provider calls. Switch release away and back before a queued send.
- Prove schema-generated drafter coverage, live AI-BUILD-1 cases, replay, persisted absence parity and actual older-reader refusal as each member ships.

## Gates

Slice 0 uses `scripts/check-records.sh`, a three-path diff and whitespace checks. The quick CI run below is for the executable base `0a6780e0`. Runtime controls belong to later slices.

CI tier: quick https://github.com/AnserBeg/2rain-greenfield/actions/runs/44931816188

## Test it yourself

From the packet tip, allow five minutes. Run `git diff --name-only 0a6780e0...HEAD` and `scripts/check-records.sh`. Expect this record, the ADR and the ledger, and exit zero.

1. **Delivery.** Follow ADR §§3–7 with A next and B holding an invitation issued early. B's link gives the unavailable response. Advance to B, take a new fix and read B's estimate. Revoke B while its map is open. No marker, stop count or ETA should survive the next revalidation.
2. **Rentals.** Follow §§1–4 and 8 with unit 17 on return. Pair its device, submit the same observation twice and turn off routing. Expect one observation with device provenance and an unavailable ETA at expiry. Advancing beyond the retention deadline removes the coordinates from operational reads.
3. **Field service.** Follow §§2, 4 and 7. Lock the technician's phone. After two minutes the customer sees an unavailable position and ETA. On two new visits, compare manual and automatic rules, then unsubscribe before handoff. In both modes the suppressed recipient gets no message.

The three proposed defaults for owner decision are in [ADR §8](../../decisions/ADR-XXXX-live-location-and-eta.md#owner-questions-for-the-independent-read).
