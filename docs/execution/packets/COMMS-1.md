# COMMS-1 · Configure email, personal notifications and reminders

**Slice 0 · Accepted design, 2026-11-20 (Fable read, amendments R1–R12 incorporated).** An owner can declare who receives a reminder, when it appears, and which email a person may approve. The [communications ADR](../../decisions/ADR-0088-governed-communications-and-reminders.md) defines the contract. The Fable read is complete. Slice 0 changed documentation only.

## Slice 1 · Discussion notices in the personal inbox

The scheduler can reconcile a committed staff mention or reply into a durable notice and the recipient can read or archive it through the PostgreSQL inbox API. The browser List and COMMS-2's production message store are pending.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44912366862

[Packet CI 44912316925](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44912316925) promoted `0581e760d` to full. The unit tests passed, but the coverage manifest omitted the deadline test. Commit `938a724d4` registers it and `8388e7eb3` checks the declared arguments against the unit runner. Hosted confirmation on the corrected tree is pending.
All eight inbox cases passed in 3.3 seconds on [hosted PostgreSQL](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44912366862/job/136870772151). Shard 3 later reached its 30-minute limit during release-persistence tests. The full run failed.

- The branch began on main `d083dd4a`. Merge `38f97a2bd` brought in CONNECT-1’s published thread writer at `ec519295`. It now includes the writer’s reviewed corrections through `f70011747` and main’s WORKFLOW-2 integration at `6787792c4`. The thread and inbox migrations are provisionally 0061 and 0062.
- The inbox implements the published `DiscussionInboxPort`. A short lease transaction commits before reconciliation. The worker locks the shared thread, resolves current reasons, replaces the recipient set and commits before acknowledging the lease token. Replay keeps the original recipient receipt, read time and archive time.
- Reads use fixed text and an exact staff-discussion link. The current revision, reply parent, active staff account, company membership and channel govern the page, count, preview, copied ID and cursor. The source admits ten distinct mentions and a reply author. Pages contain up to 25 notices and unread displays at most 99+.
- COMMS-2 publishes `platform.enqueue_discussion_notice` in its message transaction. Its database channel supplies `discussion_notice_source_v1` for the current revision and parent, `discussion_can_read_message_v1` for exact live visibility, and `discussion_notice_fence_v1` for saved-record, release and membership locks before the shared thread. Their parameter contracts and scoped fixture are in [the integration fixture](../../../test/fixtures/discussion-inbox-channel.sql). An absent binding withholds reads and leaves the occurrence retryable. COMMS-2 remains the message-store writer.
- **Owner ruling, 2026-11-21.** A record type may declare one stable staff-reference field as its owner in Customize. Rules naming `recordOwner` require that field at compile time. Booking resolves the staff assignment through its owning business record. Without it, booking offers role delivery only. Audit authorship supplies no recipient.
- `resolveReminderDeadline` applies ADR-0083 A1 to each derived civil deadline. Elapsed leads use the stored instant and working-day leads need a versioned calendar covering the horizon. The supported lead is 1–720 units.
- Remaining work includes the browser List, shared thread history, reusable record notifications, role and assigned-owner delivery, `saveReminderRule` registrations and exactly-once scheduler effects. The owner and reminder Customize members still need drafter/evals, merge-time reader rungs, archived query/refusal, persisted byte parity and upgrade replay.
- **Try it yourself.** Run `node --import tsx --test --test-concurrency=1 test/postgres/personal-inbox.test.ts test/unit/reminder-deadline.test.ts` with Docker available. The channel fixture lets you observe a withdrawn mention, a replayed reply, a copied cursor and an independently revoked company membership. Fourteen controls remove individual database checks and roll back each change.

## Slice plan

| Slice | User outcome | Dependency and acceptance |
| --- | --- | --- |
| 0 · Review the design | Trace the booking example below across the four lanes. | Record check, hosted packet CI and docs-only integration. |
| 1 · Publish an email template | In Customize, add a quote template, preview it with your own permissions, revise it and retire it. | COMMS-1 owns subject/body templates, the typed email-endpoint field on contact records, the consent and suppression store (R6, R11) and governed recipient bindings. DOCS-1 owns attached documents and PDF templates. Prove field disclosure, stable IDs, persisted absence parity, old-reader refusal and replay admission. |
| 2 · Review and send a document | From a saved record, see the exact email, approve it on the identity origin, then follow its delivery and any bounce in the thread. | CONNECT-1 owns the sole canonical message, pending-send reader, proof-consuming writer and outbox delivery. CONNECT-1 slice 2's first deliverable is the email action patch member (rung and replay test). Join SIGNIN-1 slice 2b, DOCS-1 version handles and COMMS-1 consent before opening send; slice 2 is jointly gated on 2b and DOCS-1. Batch send proofs are not admitted. A hold voids the intent and the revision gets a new send occurrence. Cover unsubscribe, ambiguous acceptance and replay. |
| 3 · Receive an internal notification | A declared case event puts one actionable entry in each eligible person's inbox. | Local demo only while the scheduler is off. Use role and stored ownership under company and record grants, with bounded fan-out, paging and a capped unread count (R10). Exercise overlapping selectors, read/archive, revocation, and two companies in one tenant. |
| 4 · Schedule a reminder | In Customize choose the lead time and recipients. A booking reminder appears once, even after rescheduling or restart. | COMMS-1 uses WORKFLOW-1 timers and the slice 2 prepare operation. Local demo only while the scheduler is off. Prove DST including the ADR-0083 A1 gap case (a boundary that does not exist resolves to 03:00 MDT, never a stall), calendar exceptions, catch-up, stale fences re-derived under the same occurrence, retirement, one durable occurrence, and the moved-anchor case (a booking extended after its end reminder fired creates a new occurrence keyed by the agreed-end revision; an unchanged anchor never re-fires). A rule-bearing release is Manual and its activation evidence counts invalidated pending reminders. Admit rule revisions through the same release and replay checks as templates. |
| 5 · Repeat with another module | Publish an approval case reminder and a document email with a different record query and template. | N2-05 joins the human task, timer, document and message. Observe one fake-provider acceptance through a provider failure and recovery with zero module-specific platform changes. |

## Test it yourself

**Today, in under five minutes.** Open the ADR beside this record and trace the following cases. The table also gives the expected observations for the future executable slices.

| Slice | Try | Expected observation |
| --- | --- | --- |
| 1 | Preview a quote template that merges customer name and a field hidden from the issuing clerk. Remove the hidden binding and preview again. | The first preview refuses before returning text. The second shows only the clerk's permitted values and creates no message. |
| 2 | Prepare a quote for the customer's stored contact with PDF v3. Inspect the identity-origin terms, then change the contact or the reviewed attachment to v4. Separately, switch release A → B → A after approval. | Each altered case needs a fresh review. The original proof cannot queue the changed revision or dispatch across the new fence. |
| 2 | With valid approval, crash the fake connector after acceptance but before saving the receipt. Restart it, deliver the same signed hard bounce twice, then try another send to that endpoint. Separately unsubscribe an eligible recipient before dispatch. | One provider acceptance, one correlated bounce, retained sent history and no new acceptance for either suppressed recipient. An uncertain attempt beyond its safe window stays held. |
| 3 | Make the booking owner a dispatch-role member. Give a second company in the same environment its own dispatcher. Remove the first owner's record grant after notification. | The owner receives one entry. The second company's dispatcher sees none. The revoked owner can no longer read the entry, preview or count. |
| 4 | Set a booking end to March 8, 2026 at 09:00 in Edmonton. Compare one civil day ahead with 24 elapsed hours ahead. Run the civil-day timer twice after restart, then change the lead time. | Civil subtraction gives March 7 at 09:00 MST (16:00Z). The elapsed rule gives 08:00 MST (15:00Z). The civil rule produces one occurrence, one entry per eligible person and one email awaiting approval. Editing that rule cannot reissue it. |
| 4 | Set a booking end to March 9, 2026 at 02:30 in Edmonton with a one-civil-day lead. Separately, extend a booking after its end reminder fired, then re-save it unchanged. | The gap boundary resolves to March 8 at 03:00 MDT and the reminder is created, not stalled. The extension creates a second occurrence and one new reminder. The unchanged re-save creates none. |
| 4 | Move an unfired booking's end, then wake its old timer. Separately choose a working-day lead across a declared holiday. | The old generation emits nothing. The new timer uses the revised end. A working-day rule skips the holiday and refuses a missing calendar. |
| 5 | Apply the same reminder and email operations to a tenant-created case type. Upgrade past a label-only rename, then try an upgrade that removes the bound contact field. | The first replays unchanged patch rows and sends only after a person's fresh decision for that occurrence. The second identifies the failed patch and field and keeps the verified source serving. |

**Design gate.** All 24 hosted jobs passed at `9d24e862` before synchronization with main. [Packet CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44768626226)

Run `scripts/check-records.sh` at the repository root and expect exit zero. Executable acceptance will use the archived production loader, actual scoped database roles, persisted release rows and a deterministic fake provider. Each incompatible capability gets its rung and any migration number at its own merge. Binary deployment observes tenant parser and reader high-water marks.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "COMMS-1",
  "base": "6787792c4564dc0757583c043738f8daa59ca76b",
  "head": "8388e7eb3a5ba78121f014ee5a8417911c817b11",
  "changedPaths": [
    "db/migrations/0061_communication_threads.sql", "db/migrations/0062_personal_inbox.sql", "db/schema.snapshot.json",
    "package.json", "packages/domain/src/billing/calendar.ts", "packages/domain/src/communication/reminder-deadline.ts",
    "packages/postgres-provider/package.json", "packages/postgres-provider/src/personal-inbox.ts", "packages/postgres-provider/src/workflow-worker.ts",
    "packages/runtime/src/discussion-inbox.ts", "test/architecture/release-persistence-boundary.test.ts", "test/architecture/repository-hygiene.test.ts",
    "test/architecture/tenant-completeness.manifest.json", "test/architecture/tenant-completeness.test.ts", "test/evidence/COMMS-1-deadlines.expected-red.json",
    "test/evidence/CONNECT-1-threads.expected-red.json", "test/fixtures/booking-commitments.sql", "test/fixtures/communication-threads.sql",
    "test/fixtures/discussion-inbox-channel.sql", "test/helpers/personal-inbox-controls.ts", "test/helpers/reachability-producers.ts", "test/postgres/communication-threads.test.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts",
    "test/postgres/personal-inbox.test.ts", "test/postgres/trust-substrate.test.ts", "test/unit/reminder-deadline.test.ts"
  ],
  "symbols": [
    {"path": "packages/postgres-provider/src/personal-inbox.ts", "name": "PostgresPersonalInbox"},
    {"path": "packages/postgres-provider/src/personal-inbox.ts", "name": "discussionInboxPort"},
    {"path": "packages/domain/src/communication/reminder-deadline.ts", "name": "resolveReminderDeadline"}
  ]
}
```
