# UPGRADE-2 slice 1 — replay a customized release on a new platform base

An approved tenant record type and a revised purchase-order layout can move to a new first-party base. The verified source serves while a clean candidate awaits human approval. [ADR-0085](../../decisions/ADR-0085-platform-upgrades-for-customized-tenants.md)

## Claims and gates

- A literal allowlist admits 21 patch kinds, including lifecycle Boards, Address fields and map placements. The parser, published vocabulary and named replay fixtures must agree. Each kind meets a compatible destination and a conflicting one. The raw admission check examines changeSet members before parsing.
- The v1 table pins 14 codes. Replay reports independent conflicts in deterministic order, with patch, member, edit, subject and both sides. A dependent edit names the earlier failure. A failed validation witness identifies the tenant rule and the obstructing base constraint.
- On the authoring base, exact edit and result digests must reproduce. On another base, moving, retiring or changing the binding of a member produces a typed conflict. A compatible addition follows its base-order predecessor into that predecessor’s current section.
- The PostgreSQL test saves an Equipment record, moves a purchase-order field into Delivery and upgrades to a base adding Dock note. It checks zero findings, Manual approval, the effective digest and placement-rule version on the candidate, the business row, and the exact ordered patch rows across staging, activation and rollback. The CI test invokes the actual preceding reader on both releases.
- The scoped source/target refusal row stores the latest report, including the verified fence. CLI status reads it after restart. The Customize screen passes the caller’s scope to the same read. Per-attempt history belongs to waves.
- The pre-change controls exercise the 30 focused replay tests, three sandbox cases and three PostgreSQL cases against the Boards release. The connector proof checks the typed member and destination base root. [Pre-change controls](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44785339001)

## Test it yourself

Run `node --import tsx --test --test-name-pattern='a tenant with Equipment' test/postgres/customization.test.ts`. The fixture creates the tenant, saves a record, reviews and activates the upgrade, checks Delivery, then rolls back.

## Decisions

The existing refusal JSON and immutable candidate payload hold the report and its layout evidence. The placement-rule version requires surface reader 34. The preceding Boards binary supports 33. No database migration.

```record-claim
{"schemaVersion":"northstar.record-claim/v1","packet":"UPGRADE-2-slice-1","base":"8e3603b8e734a14ed350f2f2f7f64d1e2b034eb7","head":"9a519eff013914904e383c0a10f0893079bd9c84","changedPaths":[".github/workflows/ci.yml","apps/api/scripts/customize-cli.ts","apps/web/src/customize-screen.ts","docs/execution/packets/UPGRADE-2-slice-1.md","package.json","packages/canonical-model/src/layout.ts","packages/compiler/src/projections.ts","packages/customization/src/apply.ts","packages/customization/src/candidate.ts","packages/customization/src/index.ts","packages/customization/src/layout-revision.ts","packages/customization/src/sandbox-worker.ts","packages/customization/src/sandbox.ts","packages/customization/src/upgrade-diagnostics.ts","packages/customization/src/upgrade-replay.ts","packages/postgres-provider/src/customization-service.ts","packages/postgres-provider/src/layout-admission.ts","packages/runtime/src/request-runtime-view.ts","test/architecture/repository-hygiene.test.ts","test/fixtures/g2/language-conformance/coverage-decisions.json","test/helpers/reachability-producers.ts","test/postgres/customization.test.ts","test/postgres/request-runtime-view.test.ts","test/unit/customization-upgrade.test.ts","test/unit/customization.test.ts"],"symbols":[{"path":"packages/customization/src/upgrade-replay.ts","name":"replayCustomizationPatches"},{"path":"packages/customization/src/upgrade-diagnostics.ts","name":"UPGRADE_PATCH_KINDS"},{"path":"packages/customization/src/layout-revision.ts","name":"applyLayoutRevision"},{"path":"packages/postgres-provider/src/customization-service.ts","name":"PostgresCustomizationService"}]}
```
