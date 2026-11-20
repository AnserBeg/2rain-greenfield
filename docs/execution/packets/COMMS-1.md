# COMMS-1 · Configure email, personal notifications and reminders

**Slice 0 · Proposed design, 2026-11-20.** An owner can declare who receives a reminder, when it appears, and which email a person may approve. The [communications ADR](../../decisions/ADR-0088-governed-communications-and-reminders.md) defines the contract. The orchestrator's Fable read precedes code. This checkpoint changes documentation only.

## Slice plan

| Slice | User outcome | Dependency and acceptance |
| --- | --- | --- |
| 0 · Review the design | Trace the booking example below across the four lanes. | Record check, hosted packet CI and docs-only integration. |
| 1 · Publish an email template | In Customize, add a quote template, preview it with your own permissions, revise it and retire it. | COMMS-1 owns subject/body templates and governed recipient bindings. DOCS-1 owns attached documents and PDF templates. Prove field disclosure, stable IDs, persisted absence parity, old-reader refusal and replay admission. |
| 2 · Review and send a document | From a saved record, see the exact email, approve it on the identity origin, then follow its delivery and any bounce in the thread. | CONNECT-1 owns the sole canonical message, pending-send reader, proof-consuming writer and outbox delivery. Join SIGNIN-1 2b, DOCS-1 version access and COMMS-1 consent before opening send. Cover unsubscribe, ambiguous acceptance and replay. |
| 3 · Receive an internal notification | A declared case event puts one actionable entry in each eligible person's inbox. | Use role and stored ownership under company and record grants. Exercise overlapping selectors, read/archive, revocation, and two companies in one tenant. |
| 4 · Schedule a reminder | In Customize choose the lead time and recipients. A booking reminder appears once, even after rescheduling or restart. | COMMS-1 uses WORKFLOW-1 timers and the slice 2 prepare operation. Prove DST, calendar exceptions, catch-up, stale fences, retirement and one durable occurrence. Admit rule revisions through the same release and replay checks as templates. |
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
| 4 | Move an unfired booking's end, then wake its old timer. Separately choose a working-day lead across a declared holiday. | The old generation emits nothing. The new timer uses the revised end. A working-day rule skips the holiday and refuses a missing calendar. |
| 5 | Apply the same reminder and email operations to a tenant-created case type. Upgrade past a label-only rename, then try an upgrade that removes the bound contact field. | The first replays unchanged patch rows and sends only after a person's fresh decision for that occurrence. The second identifies the failed patch and field and keeps the verified source serving. |

**Design gate.** Run `scripts/check-records.sh` at the repository root and expect exit zero. Executable acceptance will use the archived production loader, actual scoped database roles, persisted release rows and a deterministic fake provider. Each incompatible capability gets its rung and any migration number at its own merge. Binary deployment observes tenant parser and reader high-water marks.
