# COMMS-2 — Discuss any saved record and chat with staff

**Slice 0 · docs only · active.** [ADR-0090](../../decisions/ADR-0090-governed-record-discussions-and-staff-chat.md) is proposed. Critical paths touched: none. The branch stops for the orchestrator's independent Fable read. The ADR number is provisional until merge.

## Claims for the design read

1. Record discussion checks all stored links on every read and requires separate post grants. Staff chats check current company and explicit membership.
2. CONNECT-1 owns shared thread, participant and link writes. COMMS-2 owns only in-app message revisions, drafts and read state, under ADR-0088 R11.
3. A versioned event and its scoped receipt commit once. Deletion withdraws the message from ordinary reads and preserves revision and audit history.
4. The existing script can refresh an authorized SSR region within the two-second target through bounded push, with polling and ordinary forms as fallbacks.
5. Mentions and replies use the COMMS-1 inbox. Assistant drafts stay private until a person posts. Files pin governed DOCS-1 versions.
6. Visual Customize and the AI drafter use the same add-only change sets, with replay admission, independent reader rungs and persisted absence parity.

## Decisions

- Derive record access from the intersection of current linked-object grants, with one discussion per primary record and company. See ADR §2.
- Use explicit company-local staff memberships, with history starting at each join. See ADR §3.
- Append message revisions and tombstones. Require an explicit read mark and route notices through the COMMS-1 inbox. See ADR §4.
- Add same-origin SSE invalidation and bounded SSR catch-up to the owned script. See ADR §5.
- Reserve posting to staff and exact customer-send approvals to the existing outward decision path. See ADR §6.
- Admit DOCS-1 versions through a conversation target for chat uploads, so the message supplies the governing audience. See ADR §7.
- Place Discussion inside Record sections and admit each Customize member through replay, reader and drafter gates. See ADR §8.

## Slices

| Slice | What the user can try |
| --- | --- |
| 0 · Design | [Trace the access, recovery and Customize examples](#test-it-yourself). |
| 1 · Record threads | Publish the panel on a Booking and a tenant Inspection type. Post, mention, reply, edit, delete and mark read with script disabled. Requires CONNECT-1's shared writer and COMMS-1's inbox contract. |
| 2 · Live delivery | Leave two authorized tabs open. Post from one, interrupt the other's connection, reconnect and see the same message once. Try the same with push unavailable. |
| 3 · Staff chat | Start the same direct chat twice. Add a colleague to a group, then remove them while the chat is open. Test the same two principals in another company. |
| 4 · Photos and files | Attach a clean photo or PDF, replace the source document, and download the pinned version. Revoke source or chat access and retry the old link. |

## Controls and gates

- Executable slices owe isolated controls for all-link reads versus independent write grants, company-only refusal inside one tenant/environment, revoked membership during reads, one persisted message/inbox result on replay, and exact-version disclosure and retention.
- Each member owes a compatible replay, a named real conflict, an actual preceding production reader and parser refusal, a successful governed old-release query and persisted parity for releases without the feature. Live delivery owes served-route timing and browser checks with script on and off.
- Slice 0 gate is `scripts/check-records.sh`. The CI reference below is for the fetched `origin/main` base `630e2aa6`. Slice 0 has no separate hosted run.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44880757599

## Test it yourself

Open the ADR and trace these four cases in under ten minutes. They are design walkthroughs:

1. Work order 418 links customer and asset. The technician loses the asset read grant while the panel is open. Follow §§2 and 5 and expect the next authorized refresh to withhold the discussion, counters and notice links.
2. A new shift-group member joins after "Gate code changed" was posted. Someone edits that older post and then reconnects after a new message. Follow §§3–5 and expect the new member to see only the new message, with no duplicate on reconnect.
3. The assistant drafts a reply from thread history and the user asks it to email the customer. Follow §6 and expect a private draft. A customer send requires the existing exact-envelope human decision.
4. An owner adds Discussion to Equipment Inspection in Customize and by asking the drafter. Follow §8 and expect the same ordered change set, human approval, a compatible label-only upgrade and a named refusal for a removed query.

Run `scripts/check-records.sh` at the repository root and expect exit zero.
