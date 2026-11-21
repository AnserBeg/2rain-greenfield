# UPGRADE-2 fixes — replay compatible base changes

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44861594209

## Claims

- F1. A bound choice admits additional options. Layout replay compares stable bindings across bases, preserves tenant labels and accepts position-derived disclosure changes. The Board v2 replay path retains its authoring and structural checks.
- F2. Moving a section ignores its untouched children. Renaming a member preserves a base reorder among siblings.
- F3. ADR-0085 assigns `ID_COLLISION` to occupied non-field IDs and names. Unclassified package refusals carry the package identity. A database or sandbox failure returns `UPGRADE_PREPARATION_FAILED` and preserves the stored verdict.
- F4. Each of the 21 admitted kinds has a compatible replay and a first-party move that conflicts on a named subject. Tenant-only members replay with their creation history.
- F5. Tests cover report ordering, scope, source lineage, reader floor 33, predecessor-free placement, redaction, refusal identity and drafting against an activated layout upgrade. Final formula checks identify retired operands separately from changed types and attribute tenant formulas to their patches.
- A lifecycle-stage or option relabel plans zero storage elements. A relabel with new options still plans the domain widening. Narrowing, rebinding and changed order keys retain their refusal.

## Decisions and controls

- Saved layout digests keep their original bytes. Cross-base checks read the authoring and destination contracts for the edited members.
- The compiler uses the authenticated predecessor definition to recover labels included in historical column fingerprints. Storage targets and existing reader floors retain their wire format.
- No Customize member, migration, capability rung or drafter exception is introduced.
- Focused mutations cover the choice comparison, layout bindings, tier, section children, sibling order, identity collisions, report ordering, scope, source lineage, rule placement, admission floor and storage relabel checks.
- The shared history scan matched a booking SQL column assignment twice in commit `42766ca9`. Two exact historical fingerprints cover the migration line and its generated snapshot.

## Try it yourself

Run `node --import tsx --test --test-name-pattern='appended choice|document header label|early optional|untouched|report subjects' test/unit/customization-upgrade.test.ts`. The tenant label survives, the new field lands at the end of the first section and independent findings sort by subject within each edit.

## Filed

F6 tracks the other writers of refusal rows. F7 tracks the placement marker on a subsequent ordinary edit. F8 tracks the successful query owed by the existing floor-33 serving proof. [Execution archive](../current-plan-archive.md#filed-during-the-freeze)

```record-claim
{"schemaVersion":"northstar.record-claim/v1","packet":"UPGRADE-2-fixes","base":"0a9f7ca52304969c65092893f50375c90f8c2265","head":"8080278bbe05b3995bbb240962b89e3ff1890e2b","changedPaths":[".gitleaksignore","docs/decisions/ADR-0064-a-released-enum-domain-widens-in-one-statement-at-prepare-time.md","docs/decisions/ADR-0085-platform-upgrades-for-customized-tenants.md","docs/execution/current-plan-archive.md","docs/execution/packets/UPGRADE-2-fixes.md","packages/canonical-model/src/layout.ts","packages/compiler/src/compiler.ts","packages/compiler/src/protocol.ts","packages/compiler/src/storage.ts","packages/customization/src/apply.ts","packages/customization/src/index.ts","packages/customization/src/layout-revision.ts","packages/customization/src/release-envelope.ts","packages/customization/src/upgrade-diagnostics.ts","packages/customization/src/upgrade-replay.ts","packages/postgres-provider/src/composed-application-runtime.ts","packages/postgres-provider/src/customization-service.ts","test/evidence/enum-widen.expected-red.json","test/postgres/customization.test.ts","test/postgres/module-storage-transition.test.ts","test/unit/customization-board.test.ts","test/unit/customization-upgrade.test.ts","test/unit/customization.test.ts"],"symbols":[{"path":"packages/customization/src/upgrade-replay.ts","name":"replayCustomizationPatches"},{"path":"packages/customization/src/layout-revision.ts","name":"applyLayoutRevision"},{"path":"packages/compiler/src/storage.ts","name":"buildStorageTransitionEnvelope"},{"path":"packages/postgres-provider/src/customization-service.ts","name":"PostgresCustomizationService"}]}
```
