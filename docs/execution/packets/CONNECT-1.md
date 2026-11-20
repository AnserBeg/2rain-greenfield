# CONNECT-1 — company connectors for addresses, maps and email

Slice 0 established [ADR-0080](../../decisions/ADR-0080-connector-framework.md) after Fable’s read. Slice 1 implements Address and Maps. Email remains slice 2. Its first deliverable is the email action patch member (the extended `addDocumentEmailAction`, schemaVersion 2, with its own surface rung, replay test and old-reader refusal), per [ADR-0088 R11](../../decisions/ADR-0088-governed-communications-and-reminders.md#amendments-from-the-2026-11-20-fable-read). CONNECT-1 is the single writer of thread and participant rows and of the canonical message. Consent and suppression rows have COMMS-1 as their single writer. Lock order: reminder occurrence, thread, participant, message, consent, suppression, send intent. Slice 2 is jointly gated on DOCS-1 version handles and SIGNIN-1 slice 2b.

## Claims and decisions

1. A business user adds one Address field and places its map on an eligible office or tenant-authored record. An address requires surface reader 31 and a separate map placement requires 32.
2. The ADR-0080 storage amendment keeps one logical ID over existing text and `numeric(11,8)` columns. Text, user coordinates, revision, status and source digest commit together. Retirement withdraws its connector and map while retaining its columns. Rollback hides the field, and reactivation restores its value. An invalid manual pin leaves both text and coordinates intact.
3. A host worker resolves an enabled company installation, delivers an outbox intent after save and rechecks the active release, record, address revision, source digest and installation after provider I/O. Only the current company’s unexpired enrichment supplies a provider pin.
4. CI selects the deterministic fake even when the configuration requests Google. Google static imagery remains disabled under ADR-0080. User-entered coordinates and company-owned provider coordinates have separate lifetimes.
5. ADR-0085 replay admission for both patch kinds has a named test in `test/unit/customization.test.ts`. It replays across a compatible base change and refuses field-label and map-section conflicts. UPGRADE-2 owns the shared allowlist inventory.

## Gates and controls

- [Prerequisite CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44728026806) exercised Party posting after an ordinary custom text field and PostgreSQL coordinate bounds and precision.
- [Packet CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44762142200) at `ba16020e` covers the checked-in first-party release, the historical tenant envelope, prior-reader refusal, refused types, schema replay and the application suites.
- [PostgreSQL and mutation controls](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44761638148) exercise outage save, late edits, installation replacement, release rollback and two enabled companies reading one shared record. The controls are `late-address-response` and `shared-record-company-pin`.
- Critical paths include release verification and migration 0052 with connector RLS and grants. The unread Critical diff exceeds 400 lines and the orchestrator owes the trunk read.

## Test it yourself

In the local demo as Manager, open `/?customize=address`, enable **Demo Maps** for a company and leave **Locate saved addresses** checked. Under **Customize**, draft, approve and activate a new address field on Item, then a map placement on its record page. Save an address on an item and reopen it to see its pin.
For the outage and delayed-response cases, run `node --import tsx --test test/postgres/address-connector.test.ts` with Docker available.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "CONNECT-1",
  "base": "eda6d12ffc4d38ba84146b712c3bbeed1eabb729", "head": "ba16020e957550a0f39e789064aa1b4046398071",
  "changedPaths": [
    "apps/api/src/composition-root.ts", "apps/web/src/address-context.ts", "apps/web/src/address-field.ts", "apps/web/src/address-settings.ts",
    "apps/web/src/app-server.ts", "apps/web/src/component-registry.ts", "apps/web/src/customize-screen.ts", "apps/web/src/document-editor.ts",
    "apps/web/src/list-declaration.ts", "apps/web/src/surface-client.ts", "apps/web/src/surface-composition.ts", "apps/web/src/surface-contract.ts",
    "apps/web/src/surface-runtime.ts", "db/migrations/0052_address_connectors.sql", "db/schema.snapshot.json", "package.json",
    "packages/canonical-model/src/address.ts", "packages/canonical-model/src/formula-validation-bindings.ts", "packages/canonical-model/src/index.ts", "packages/canonical-model/src/normalize.ts",
    "packages/canonical-model/src/schemas.ts", "packages/compiler/src/address.ts", "packages/compiler/src/compiler.ts", "packages/compiler/src/diff.ts",
    "packages/compiler/src/formula-validation-examples.ts", "packages/compiler/src/projections.ts", "packages/compiler/src/protocol.ts", "packages/compiler/src/storage.ts",
    "packages/customization/src/apply.ts", "packages/customization/src/patch.ts", "packages/postgres-provider/package.json", "packages/postgres-provider/src/address-geocodes.ts",
    "packages/postgres-provider/src/address-provider.ts", "packages/postgres-provider/src/address-storage.ts", "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts",
    "packages/postgres-provider/src/release-verification-service.ts", "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/postgres-provider/src/serving-gateways.ts", "packages/runtime/src/address-gateway.ts",
    "packages/runtime/src/formula-validation.ts", "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-operation-gateway.ts", "packages/runtime/src/semantic-query-gateway.ts",
    "pnpm-lock.yaml", "test/architecture/release-persistence-boundary.test.ts", "test/architecture/repository-hygiene.test.ts", "test/architecture/tenant-completeness.manifest.json",
    "test/architecture/tenant-completeness.test.ts", "test/evidence/CONNECT-1.expected-red.json", "test/fixtures/g2/language-conformance/coverage-decisions.json", "test/helpers/reachability-producers.ts",
    "test/integration/field-kind-round-trip.test.ts", "test/postgres/address-connector.test.ts", "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts", "test/postgres/request-runtime-view.test.ts", "test/postgres/trust-substrate.test.ts", "test/unit/address-connector.test.ts",
    "test/unit/customization.test.ts"
  ],
  "symbols": [{"path":"packages/compiler/src/address.ts","name":"compileAddressBindings"},{"path":"packages/postgres-provider/src/address-storage.ts","name":"readAddress"}]
}
```
