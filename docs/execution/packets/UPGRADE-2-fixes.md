# UPGRADE-2 fixes — replay compatible base changes

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44880694036

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
- B1(a). The provider's widening branch compares a strict ID superset in either direction, identical remaining contract properties, and identical remaining column properties except the fingerprint. It already admits a widening plus relabel. Planner and provider share this lowered enum comparison beside `widensEnumDomain`, including zero added IDs. The planner also authenticates source-only properties such as option order keys.
- B1(b). Keep the complete wider column. With equal domains, keep the complete column with the lexicographically smaller fingerprint in either order.
- B1(c). Enum storage is PostgreSQL text. CHECK DDL and catalog verification both use `enumCheckExpression` over option IDs. Index definitions use physical columns and predicates. Option labels reach the historical fingerprint alone on this storage path, so a pure relabel needs zero storage steps.
- No Customize member, migration, capability rung or drafter exception is introduced.
- Focused mutations cover the choice comparison, layout bindings, tier, section children, sibling order, identity collisions, report ordering, scope, source lineage, rule placement, admission floor and storage relabel checks.
- BOOKING-1 supplies the two historical SQL-assignment fingerprints on main. This packet has no secret-scan exception of its own.

- B2. If a base moves the Details fold so a tenant move no longer changes the visible order, replay names the tenant field, patch and edit index with `MOVED_MEMBER`.
- R1/R2. A changed lookup query conflicts. Replay ignores only the named display-label paths in the layout contract. A future reference binding named `label` participates in the comparison.
- R3/R4. A transient preparation error logs the error class and code. A disclosure read failure returns the transient outcome and preserves the stored refusal. Tests check the exact log arguments and exercise the failing disclosure read.
- R5/R7. The enum-widen manifest removes `enumRelabel` alone. ADR-0064's amendment records the shared lowered comparison and deterministic representative.
- Removal controls: disabling equal-domain merging refuses all three B1 cases. Removing the fingerprint tie-break fails the reverse-order proof. Removing fold attribution, non-type comparison, named label paths, transient logging, disclosure rethrow, or planner relabel admission each fails its focused assertion.

## Try it yourself

Run `node --import tsx --test --test-name-pattern='merging old and relabelled|shifted Details fold' test/postgres/module-storage-transition.test.ts test/unit/customization-upgrade.test.ts`. Both merge orders select the same complete column, and each fold-crossing move names the tenant edit. With Docker, run `node --import tsx --test --test-name-pattern='one tenant prepares and activates|a storage-changing prepare succeeds' test/postgres/module-storage-transition.test.ts` to exercise activation and mixed live roots.

## Filed

F6 tracks the other writers of refusal rows. F7 tracks the placement marker on a subsequent ordinary edit. F8 tracks the successful query owed by the existing floor-33 serving proof. [Execution archive](../current-plan-archive.md#filed-during-the-freeze)

```record-claim
{"schemaVersion":"northstar.record-claim/v1","packet":"UPGRADE-2-fixes","base":"d48c870bdf7cae3858a84e1dde6ea8125750e28d","head":"d9a9d62d4dd4bc7c96d60c0e12aef596f756267a","changedPaths":["docs/decisions/ADR-0064-a-released-enum-domain-widens-in-one-statement-at-prepare-time.md","docs/decisions/ADR-0085-platform-upgrades-for-customized-tenants.md","docs/execution/current-plan-archive.md","docs/execution/packets/UPGRADE-2-fixes.md","packages/canonical-model/src/layout.ts","packages/compiler/src/compiler.ts","packages/compiler/src/index.ts","packages/compiler/src/protocol.ts","packages/compiler/src/storage.ts","packages/customization/src/apply.ts","packages/customization/src/index.ts","packages/customization/src/layout-revision.ts","packages/customization/src/release-envelope.ts","packages/customization/src/upgrade-diagnostics.ts","packages/customization/src/upgrade-replay.ts","packages/postgres-provider/src/composed-application-runtime.ts","packages/postgres-provider/src/customization-service.ts","packages/postgres-provider/src/module-storage-materializer.ts","test/evidence/enum-widen.expected-red.json","test/postgres/customization.test.ts","test/postgres/module-storage-transition.test.ts","test/unit/customization-board.test.ts","test/unit/customization-upgrade.test.ts","test/unit/customization.test.ts"],"symbols":[{"path":"packages/customization/src/upgrade-replay.ts","name":"replayCustomizationPatches"},{"path":"packages/customization/src/layout-revision.ts","name":"applyLayoutRevision"},{"path":"packages/compiler/src/storage.ts","name":"buildStorageTransitionEnvelope"},{"path":"packages/postgres-provider/src/customization-service.ts","name":"PostgresCustomizationService"},{"path":"packages/compiler/src/storage.ts","name":"enumColumnTransition"},{"path":"packages/postgres-provider/src/module-storage-materializer.ts","name":"mergeExpectedTables"}]}
```
