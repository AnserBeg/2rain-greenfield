# COMMS-2 — Discuss any saved record and chat with staff

**Slice 1 · blocked on CONNECT-1.** The orchestrator accepted the amended design at `5ecafc89`. Fresh main at `630e2aa6` ships CONNECT-1 Address and Maps. Its shared thread, participant and business-object link writer and its outbound preparation path belong to CONNECT-1 slice 2. [Dependency](CONNECT-1.md) · [Accepted design](../../decisions/ADR-0090-governed-record-discussions-and-staff-chat.md#after-the-design-read)

## Slice 1 checkpoint

- COMMS-1's inbox is absent. `DiscussionInboxPort` names the seam. Its test double exercises lease claim, locked reconciliation from the current revision, and acknowledgement after commit. Ordinary notice reads check the channel, recipient, exact message and reply parent. Six unit tests and twelve isolated mutations exercise the seam.
- `discussion-compatibility.test.ts` recompiles a panel-free first-party release, stages an ordinary tenant field through Customize, compares the stored definition, root, manifest and projection bytes to the archived tree, and queries a saved item on the first-party release with that tree's serving gateway.
- The preceding reader answered the first-party query against saved data in the initial run. That run timed out during tenant activation. The narrowed run timed out during archived-runtime setup on the shared host. Tenant byte parity and refusal of a declaring Discussion release remain unverified.
- The live record panel, message storage, Mark read, A1 and A6 database races and same-tenant company isolation require the shared writer. A7 publication on Purchase Order and Inspection requires executable discussion operation bindings. The member, replay and preceding-reader refusal remain open. Migration and surface reader rung are unassigned.
- **Try it yourself** — run `node --import tsx --test test/unit/discussion-inbox.test.ts`. Withdrawing a mention before replay leaves only the eligible reply reason. A failed reconciliation leaves the lease unacknowledged.

## Design claims

1. Record discussion checks all stored links on every read and requires separate post grants. Staff chats check current company and explicit membership.
2. CONNECT-1 owns shared thread, participant and link writes. COMMS-2 owns only in-app message revisions, drafts and read state, under ADR-0088 R11.
3. A versioned event and its scoped receipt commit once. Deletion withdraws the message from ordinary reads and preserves revision and audit history.
4. The existing script can refresh an authorized SSR region within the two-second target through bounded push, with polling and ordinary forms as fallbacks.
5. Mentions and replies use the COMMS-1 inbox. Assistant drafts stay private until a person posts. Files pin governed DOCS-1 versions.
6. Visual Customize and the AI drafter use the same add-only change sets, with replay admission, independent reader rungs and persisted absence parity.

## Owner rulings adopted 2026-11-21

- A staff member sees only messages created after their latest join, including on returning to a direct chat. See ADR §3.
- Retain revisions and exact file references until a governed retention policy exists. User deletion appends a tombstone and legal holds continue. See ADR §§4 and 7.
- A shared record has one discussion per company, with live checks on every required link. See ADR §2.

## Amendments and acceptance tests

- **A1 · First post (§2).** Derive and check required links before thread lookup or composer. Race two authorized first posts with a primary-only reader and submitter. Compare the denied panel and response before, during and after the race. Verify refusal without waiting for the creation lock, one thread, two authorized posts and no denied write. Repeat the absence and presence checks after a saved relation changes.
- **A2 · Channel and notices (§§1, 4).** Authorize channel and exact message before projection, mention selection or reconciliation. Exercise email-only lists, counts, search and copied inbox links across staff activity. Exclude a late joiner from an old message's edit picker and refuse a submitted mention of them. Replay a withdrawn mention and verify the notice and count stay absent.
- **A3 · Attach and fetch (§7).** Require destination attach authority for linking and uploads and verify exact reference membership on the current visible revision before sending bytes. Keep source and post grants, then withdraw attach on one required record or on the staff chat. Refuse both file paths, including a staged upload. Replace the chat photo, refuse its old URL before any bytes, fetch the new one and verify the retained reference blocks purge.
- **A4 · Refresh (§5).** Serialize every trigger and reject superseded responses. Hold a response across disconnect and fallback and release it after a newer response. Run once with a newer tombstone and once with unavailability. Verify no restored content or counts and that refusal clears reply data, selected mentions and file previews and disables stale actions.
- **A5 · Load (§5).** Cap all live work per process. Measure served-route commit-to-visible p95 at 64 streams, 32 topics and two posts per second. Saturate reconnects and polls and verify 429, bounded scans and successful ordinary Record reads and posts.
- **A6 · Locks (§1).** Take the creation key first in CONNECT-1's thread step and release the outbox claim before R11. Race first post with outbound preparation for matching and differing links, and replay a notice during an edit or member removal. Verify correct thread identities and inbox rows without deadlock or duplicate effects.
- **A7 · Discovery (§8).** Publish the same linked change set from Customize and the live drafter on Purchase Order with supplier Party and tenant Inspection with Equipment. Exercise a related target without a Discussion panel. Booking waits for BOOKING-1's first-party Record layout and declaration. Work Order waits for the N4 Work Order pack's layout and declaration.
- **A8 · Evidence.** Assign the ADR number at merge and update its references together. Verify the reviewed SHA and CI run head both identify `675d76ee`. Take integration evidence from the then-current packet tip's own green run.

## Slices

| Slice | What the user can try |
| --- | --- |
| 0 · Design | [Trace the access, recovery and Customize examples](#test-it-yourself). |
| 1 · Record threads | Publish linked panels on Purchase Order and a tenant Inspection type. Post, mention, reply, edit, delete and mark read with script disabled. Requires CONNECT-1's shared writer and COMMS-1's inbox contract. |
| 2 · Live delivery | Leave two authorized tabs open. Post from one, interrupt the other's connection, reconnect and see the same message once. Try the same with push unavailable. |
| 3 · Staff chat | Start the same direct chat twice and exercise company leave and rejoin. Add a colleague to a group, then remove them while the chat is open. Test the same two principals in another company. |
| 4 · Photos and files | Attach a clean file and replace its source version. Download the still-pinned version from the current message. Replace the attachment on the message and retry the old chat URL. |

## Controls and gates

- Executable slices owe isolated controls for all-link reads versus independent write grants, company-only refusal inside one tenant/environment, revoked membership during reads, one persisted message/inbox result on replay, and exact-version disclosure and retention.
- Each member owes a compatible replay, a named real conflict, an actual preceding production reader and parser refusal, a successful governed old-release query and persisted parity for releases without the feature. Live delivery owes served-route timing and browser checks with script on and off.
- Slice 0 gate is `scripts/check-records.sh`. The quick run below is bound to reviewed packet tip `675d76ee`. Integration requires a green run for the packet tip being integrated.

CI tier: quick https://github.com/AnserBeg/2rain-greenfield/actions/runs/44885779861

## Test it yourself

Open the ADR and trace these design walkthroughs in under ten minutes.

1. Work order 418 requires its customer and asset. A clerk lacks the asset read grant. Follow §§2 and 5 and expect the same unavailable panel and refused submit before and after a technician creates the discussion. When the technician also loses access, the next refresh clears the open transcript and reply controls.
2. A new shift-group member joins after "Gate code changed" was posted. Someone edits that older post and then reconnects after a new message. Follow §§3–5 and expect the new member to see only the new message, with no duplicate on reconnect.
3. The assistant drafts a reply from thread history and the user asks it to email the customer. Follow §6 and expect a private draft. A customer send requires the existing exact-envelope human decision.
4. An owner adds Discussion with its Equipment link to Equipment Inspection in Customize and by asking the drafter. Follow §8 and expect the same ordered change set, human approval, a compatible label-only upgrade and a named refusal for a removed query.
5. Alex leaves the company. Sam posts in their direct chat while Alex is away. Alex rejoins, then Sam posts again before Alex opens the chat. Follow §§3, 4 and 7 and expect the same direct pair and only the post after rejoin. Earlier edits, quotes, notices and attachment links give Alex no earlier history.

Run `scripts/check-records.sh` at the repository root and expect exit zero.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "COMMS-2",
  "base": "5ecafc891cadd19e74288ca08fcbad7422a000d8", "head": "71e24e115b7a0a5023632dd7da12f18669bd61c4",
  "changedPaths": ["package.json", "packages/runtime/src/discussion-inbox.ts", "test/architecture/repository-hygiene.test.ts", "test/evidence/COMMS-2.expected-red.json", "test/helpers/archived-runtime-process.ts", "test/postgres/booking-serving.test.ts", "test/postgres/discussion-compatibility.test.ts", "test/unit/discussion-inbox.test.ts"],
  "symbols": [{"path":"packages/runtime/src/discussion-inbox.ts","name":"reconcileNextDiscussionNotice"}]
}
```
