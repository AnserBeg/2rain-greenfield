# CONNECT-1 — company connectors for addresses, maps and email

Slice 0 established the connector contract. Slice 1 delivers Address and Maps. The owner sequenced the shared writer first in slice 2 to unblock COMMS-1 and COMMS-2. The email-action member follows with its own reader rung and replay test. [ADR-0080](../../decisions/ADR-0080-connector-framework.md) · [ADR-0088 R11](../../decisions/ADR-0088-governed-communications-and-reminders.md#amendments-from-the-2026-11-20-fable-read)

## Claims and decisions

1. A business user adds one Address field and places its map on an eligible office or tenant-authored record. An address requires surface reader 31 and a separate map placement requires 32.
2. The ADR-0080 storage amendment keeps one logical ID over existing text and `numeric(11,8)` columns. Text, user coordinates, revision, status and source digest commit together. Retirement withdraws its connector and map while retaining its columns. Rollback hides the field, and reactivation restores its value. An invalid manual pin leaves both text and coordinates intact.
3. A host worker resolves an enabled company installation, delivers an outbox intent after save and rechecks the active release, record, address revision, source digest and installation after provider I/O. Only the current company’s unexpired enrichment supplies a provider pin.
4. CI selects the deterministic fake even when the configuration requests Google. Google static imagery remains disabled under ADR-0080. User-entered coordinates and company-owned provider coordinates have separate lifetimes.
5. ADR-0085 replay admission for both patch kinds has a named test in `test/unit/customization.test.ts`. It replays across a compatible base change and refuses field-label and map-section conflicts. UPGRADE-2 owns the shared allowlist inventory.

SIGNIN-1 slice 2b opens when the canonical pending connection and send records and their writers land. Outside the local demo, provider enablement must go through a proof-gateable function with no runtime table-write grant.

## Gates and controls

- [Prerequisite CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44728026806) exercised Party posting after an ordinary custom text field and PostgreSQL coordinate bounds and precision.
- [Packet CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44762142200) at `ba16020e` covers the checked-in first-party release, the historical tenant envelope, prior-reader refusal, refused types, schema replay and the application suites.
- [PostgreSQL and mutation controls](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44761638148) exercise outage save, late edits, installation replacement, release rollback and two enabled companies reading one shared record. The controls are `late-address-response` and `shared-record-company-pin`.
- Critical paths include release verification and migration 0052 with connector RLS and grants. The unread Critical diff exceeds 400 lines and the orchestrator owes the trunk read.

## Slice 1 fix round (2026-11-20 review of `032b87c0`, verdict REVISE)

Migration `0058_address_connector_authority.sql` revokes every runtime grant on the four address tables; scoped SECURITY DEFINER functions take tenant, environment and principal from the trusted context and check company membership live.
- **Join point:** `platform.address_configure` is the single entry point that enables, reconfigures, switches or pauses a provider. It requires `northstar.runtime:permission.connector_configure` on `northstar.runtime:connector.address`, live and in a membership covering the company (the local demo grants it to the manager), and refuses unless the store is claimed for the local demo; no store mode grants a direct table write any more. SIGNIN-1 slice 2b adds its passkey decision proof there, outside the local demo.
- Any member reads its company's installation, so a buyer locates, sees pins and gets suggestions. A pin matches record, field, revision and installation, never the current release fence; a retired field has no binding.
- One installation per company and provider account: pausing, re-enabling and switching back keep its quota and key-file identity. Configure takes the company's advisory lock, then its rows `FOR UPDATE`; a replaced installation is recorded `paused`.
- `platform.address_sweep` scrubs expired provider coordinates (30 days) in batches, `SKIP LOCKED`, under a READ COMMITTED guard; the demo worker runs it each tick.
- Reader 32 refuses through this tree's production loader capped at 31 (`withArchivedCustomizationRuntime` prepare hook); the loader's Address agreement is `addressProjectionRefusal`, one comparator per line.
- CI: the Customization browser runner's bound rises from 20 to 30 minutes. Main's last five greens took 12.2–12.6 minutes; the candidate's full run hit 20 twice on a slow runner with the packet adding no browser test (the same six tests took 16.5 minutes against 11.7 on main, Chromium deps 3.1 against 0.6). This packet's earlier full run on the same code took 12.9.
CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44846041153

- Controls: 29 entries in `test/evidence/CONNECT-1.expected-red.json`, one per guard, mostly in `test/postgres/address-authority.test.ts` (one subtest each).

## Slice 2a · shared thread writer

The published functions in migration `0060_communication_threads.sql` compose inside one governed Semantic Operation transaction. The non-login role `north_star_communication_operation` has function execution only. Grant runtime execution on the consuming channel's narrow operation. Keep raw binding selections, contacts and staff IDs inside that operation.

1. `communication_admit_record(company, release, fence, channel, entity, record, binding_ids, contact_refs, staff_ids)` checks the saved owner, the exact get and its live grants for the primary and every selected link under record, release and policy locks. A Record pins its get. A declared text picker pins the target get, including Purchase Order supplier → Party. A hidden or missing record gives the same refusal. Discussion also needs `discussion_post_<entity>` on each link. Email needs `prepare_email_<entity>` on its primary.
2. The writer requires `read_relation_<binding>` or `read_reference_<field>` on the selected binding. A contact must match a disclosed link or the primary and have `disclose_contact_<entity>` on its entity. Staff need active accounts and live company membership. `communication_admit_direct(company, release, fence, peer)` also requires the staff-chat action.
3. Governed setup calls `communication_register_discussions(tickets)` to register immutable anchors in key order. The scalar form refuses a backward acquisition. After any reminder occurrence lock, prelock a batch with `communication_lock_creations(tickets)`, then call `communication_resolve_thread(ticket)` or `communication_lock_thread(ticket, thread_id)`. Take existing thread IDs in ascending order. Private inserts can occur anywhere in that order.
4. `communication_write_participants(ticket, thread_id)` returns stable IDs and locks the admitted subjects. One subject can participate in both channels while each channel retains its own membership. Continue with message, consent, suppression and send intent in that order. Commit or rollback discards every admission ticket.

The scope includes storage and writer entry points. COMMS-1 owns its inbox and consent projections. COMMS-2 owns staff message events and the discussion surface. The email-action patch and address refresh with R1–R9 follow this merge-line checkpoint. Migration numbering is provisional until integration. [Slice 2a packet CI](https://github.com/AnserBeg/2rain-greenfield/actions/workflows/ci.yml?query=branch%3Apacket%2FCONNECT-1-s2)

## Test it yourself

Run `node --import tsx --test test/postgres/communication-threads.test.ts` with Docker available. Expect matching concurrent email and discussion calls to return one thread, differing links to return two, a foreign company to refuse, and all 17 scenarios to pass, including opposite anchor batches and an unreadable supplier. The guard controls are in `test/evidence/CONNECT-1-threads.expected-red.json`.

In the local demo as Manager, open `/?customize=address`, enable **Demo Maps** for a company and leave **Locate saved addresses** checked. Under **Customize**, draft, approve and activate a new address field on Item, then a map placement on its record page. Save an address on an item and reopen it to see its pin.
For the outage and delayed-response cases, run `node --import tsx --test test/postgres/address-connector.test.ts` with Docker available. As Buyer, open the same item: its pin shows, and **Company settings** refuses to enable a provider. The authority, quota, expiry and late-reply guards run with `CI=1 node --import tsx --test test/postgres/address-authority.test.ts`.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "CONNECT-1",
  "base": "630e2aa690906af9256c5964c398ba90585515d2", "head": "dcd6c58b2e7779127a6bb517697b5f03690d66cc",
  "changedPaths": ["db/migrations/0060_communication_threads.sql", "db/schema.snapshot.json", "test/architecture/release-persistence-boundary.test.ts", "test/architecture/repository-hygiene.test.ts", "test/architecture/tenant-completeness.manifest.json", "test/architecture/tenant-completeness.test.ts", "test/evidence/CONNECT-1-threads.expected-red.json", "test/fixtures/booking-commitments.sql", "test/fixtures/communication-threads.sql", "test/postgres/communication-threads.test.ts", "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts", "test/postgres/trust-substrate.test.ts"],
  "symbols": []
}
```
