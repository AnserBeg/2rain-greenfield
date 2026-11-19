# UPGRADE-1 — customized upgrades and a reliable first start

Status — slice 0 integrated at `607e3941`; slice 1 at `99371b43`; slice 2 from `29e95df2`.
Critical path — `db/migrations/0032_customization_upgrades.sql`, including RLS/grants. Approved by the orchestrator on 2026-11-18; logged `merged — unread`.

## Claims

1. The managed dev database accepts TCP before migration, after the image's socket-only initialization server.
2. Boot replays a live tenant's `addField` and `arrangeLayout` chain against a moved first-party base, staging one compiled child of the prior live revision. Approval and activation are explicit.
3. Missing targets and conflicts produce stable sandbox compiler diagnostics naming the tenant patch, first-party base and subject. A refused replay leaves the prior release serving.
4. The append-only upgrade row binds the source, new base, candidate and ordered patch IDs. PostgreSQL checks its digest and scope/actor policies. Runtime grants are SELECT and INSERT.
5. Every replay reproduces its original chain first. Retained immutable bases support a later baseline that omits them from the checked-in file. Rollback reverses the exact verified upgrade edge.
6. `customize recover` verifies the receipt matching the live pointer, release and fence through the existing kernel, then reconciles scopes under the existing release-scope lock. It never moves the pointer.
7. Recovery tests cut both activation and rollback after their swap, check scopes immediately on return, and check the unchanged pointer/fence. Concurrent recovery calls verify the current attempt even when an older attempt names the same release.

## Decisions

- Upgrade intent has its own data-plane relation. Original authored patch rows retain their identities and payloads, including CUSTOMIZE-2's `screens` and historical `legacy` interpretation.
- Supported replay keeps the package, language and normalization profile. Other patch kinds retain `CUSTOMIZE_BASE_MOVED`; stale authored/compiled files retain `CUSTOMIZE_BASE_STALE`.
- The checked-in new base can remain staged. Its retained artifacts are compiler input for subsequent replays. The tenant candidate passes ordinary semantic admission and activation gates.
- Git metadata under `/home/rvham/2rain-greenfield/.git/worktrees/2rain-greenfield-upgrade-1` is read-only. Commits use `/tmp/upgrade-1-lane-1000.git` with this worktree as GIT_WORK_TREE.
- Mechanical bridges update the migration inventory, tenant-completeness manifest and derived platform schema snapshot.
- Slice 1 includes accepted panel/style changes at `c4438d56`, with no shared upgrade file. Exact combined merge CI is the acceptance gate.
- A three-line PANEL-2 test bridge observes the restored desktop width before measuring its drag handle; the combined slice 1 CI exposed this resize race. Existing assertions stay intact.
- Recovery changes the customization service, CLI and journey test; the CAS, fence and verification kernel are unchanged. No stage-boundary program review is triggered.

## Controls

- [Manifest](../../../test/evidence/UPGRADE-1.expected-red.json) — omitted row/environment scope and digest validation each kill the upgrade journey. CI [44421999367](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44421999367) reproduced all three at `af424ffd`.
- `upgrade-replayed-as-separate-drafts` — one local declared red and restored green prove that the compiler test detects a replay with the wrong parent.

## Gates

- Slice 0 merge [CI 44391066375](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44391066375) passed at `607e3941`.
- Slice 1 candidate [CI 44426978571](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44426978571) passed at `d4ff6816`; exact merge [CI 44433440507](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44433440507) is being rerun as a whole workflow after the resize race at `99371b43`. Controls above passed.
- Slice 2 candidate [CI 44435768802](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44435768802) passed all 16 jobs at `29e95df2`; local format, typecheck and lint passed.
- Slice 1 merge CI first exposed a PANEL-2 mobile-to-desktop resize race; the test now waits for its existing width fact. A failed-job-only rerun passed the browser but reachability refused stale attempt evidence; the whole workflow is rerun. The superseded slice 2 run was cancelled after this test-only push.
- Initial slice 1 CI typecheck and schema drift reds were repaired; the generated 32-migration snapshot was reproduced under the exclusive lock. `scripts/check-records.sh` passed.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "UPGRADE-1",
  "base": "99371b437fdf45c51cf8ecfb3b7cf4c95459409a",
  "head": "29e95df284d6ac4c31a4f030abe598f6fdf627c5",
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

- Upgrade — boot the new first-party release against the same tenant database, read `CUSTOMIZATION_UPGRADE`, then `corepack pnpm customize status`. Approve its upgrade ID, activate that ID, and `corepack pnpm customize rollback` to return to the prior tenant release.
- Recover — after an interrupted activation, run `corepack pnpm customize recover`. Expect the live release's activation verified and scopes reconciled. Run it again; the pointer and fence remain unchanged.
- Isolated upgrade proof — after `timeout 15 docker info`, run `node scripts/run-with-test-lock.mjs exclusive -- node --import tsx --test --test-name-pattern='a platform label upgrade' test/postgres/customization.test.ts`. It checks conflict, field/layout survival, explicit activation, a second baseline and rollback.
- Isolated recovery proof — after `timeout 15 docker info`, run `node scripts/run-with-test-lock.mjs exclusive -- node --import tsx --test test/postgres/customization-world.test.ts`. It checks both interrupted directions, concurrent recovery and fresh postings under the recovered release.
