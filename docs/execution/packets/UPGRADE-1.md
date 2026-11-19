# UPGRADE-1 — customized upgrades and a reliable first start

Status — slice 0 integrated at `607e3941`; slice 1 integrated at `99371b43`; slice 2 integrated from `f9fa27c6` (PR #98).
Critical path — `db/migrations/0032_customization_upgrades.sql`. Migration and RLS approved by the orchestrator on 2026-11-18.

## Claims

1. The managed dev database accepts TCP before migration, after the image's socket-only initialization server.
2. Boot replays a live tenant's `addField` and `arrangeLayout` chain against a moved first-party base, staging one compiled child of the prior live revision. Approval and activation are explicit.
3. Missing targets and conflicts produce stable sandbox compiler diagnostics naming the tenant patch, first-party base and subject. A refused replay leaves the prior release serving.
4. The append-only upgrade row binds the source, new base, candidate and ordered patch IDs. PostgreSQL checks its digest and scope/actor policies. Runtime grants are SELECT and INSERT.
5. Every replay reproduces its original chain first. Retained immutable bases support a later baseline that omits them from the checked-in file. Rollback reverses the exact verified upgrade edge.
6. Under the release-scope lock, `customize recover` verifies the attempt matching the live pointer and fence, then reconciles inventory scopes. The pointer and fence retain their values.

## Decisions

- Upgrade intent has its own data-plane relation. Original authored patch rows retain their identities and payloads, including CUSTOMIZE-2's `screens` and historical `legacy` interpretation.
- Supported replay keeps the package, language and normalization profile. Other patch kinds retain `CUSTOMIZE_BASE_MOVED`; stale authored/compiled files retain `CUSTOMIZE_BASE_STALE`.
- The checked-in new base can remain staged. Its retained artifacts are compiler input for subsequent replays. The tenant candidate passes the ordinary semantic admission and activation gates.
- Mechanical bridges update the migration inventory, tenant-completeness manifest and derived platform schema snapshot.

- Integration includes accepted panel/style changes at `c4438d56`, with no shared file in the upgrade diff. Combined merge CI is the final gate.

- Slice 2 includes the assistant-panel browser test fix that waits for the restored desktop width before measuring the resize handle.

## Controls

- [Manifest](../../../test/evidence/UPGRADE-1.expected-red.json) — omitted row/environment scope and digest validation each kill the upgrade journey. CI [44421999367](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44421999367) reproduced all three at `af424ffd`.
- `upgrade-replayed-as-separate-drafts` — one local declared red and restored green prove that the compiler test detects a replay with the wrong parent.

## Gates

- Slice 0 merge [CI 44391066375](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44391066375) passed at `607e3941`.
- Slice 1 [CI 44411290320](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44411290320) passed at `c65882b3`. Trunk-synchronized candidate [CI 44426978571](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44426978571) passed at `d4ff6816`. Its [controls 44421999367](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44421999367) passed.
- Local format, typecheck, lint and focused compiler tests passed before the trunk merge. The initial CI typecheck red was corrected. Its schema drift red was reproduced and repaired with the generated 32-migration snapshot under the exclusive lock.

- Slice 2 [CI 44441420212](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44441420212) passed all 16 jobs at `ec7857f1`. Synchronizing with `246bd643` changed only documentation.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "UPGRADE-1",
  "base": "8b61740a17c18a6201f01c4345c0e6c215ee91d3",
  "head": "ec7857f12a3dd3bbaa3c327c21942a69fe2e7a70",
  "changedPaths": [
    "apps/api/scripts/customize-cli.ts",
    "apps/web/test/browser/assistant-panel.composed-application.spec.ts",
    "packages/postgres-provider/src/customization-service.ts",
    "test/postgres/customization-world.test.ts"
  ],
  "symbols": [{"path": "packages/postgres-provider/src/customization-service.ts", "name": "PostgresCustomizationService"}]
}
```

## Test it yourself

First start — expect READY on the first start, then Ctrl-C to stop it.

```bash
export NORTH_STAR_DEV_DATABASE_CONTAINER=upgrade-1-readiness-demo NORTH_STAR_DATABASE_PORT=55483 PORT=4183
unset DATABASE_URL
corepack pnpm --filter @north-star/api dev:reset && corepack pnpm dev
```

- Upgrade — boot the new first-party release against the same tenant database, read `CUSTOMIZATION_UPGRADE`, then `corepack pnpm customize status`. Approve its upgrade ID, activate that ID, and `customize rollback` to return to the prior tenant release.
- Isolated proof — after `timeout 15 docker info`, run `node scripts/run-with-test-lock.mjs exclusive -- node --import tsx --test --test-name-pattern='a platform label upgrade' test/postgres/customization.test.ts`. It uses its own ephemeral database and checks conflict, survival, explicit activation, a second baseline and rollback.
- Recovery — after an interrupted activation or rollback, run `corepack pnpm customize recover`. It reports the verified live release and reconciled inventory scopes. Running it again returns the same live release.
