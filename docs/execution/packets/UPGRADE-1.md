# UPGRADE-1 — customized upgrades and a reliable first dev start

## Claims

1. On first start, the managed database must accept TCP on container loopback before migrations begin. The image starts its temporary initialization server on a Unix socket.

## Decisions

- Use the same TCP readiness check for a new container and a restarted one. The dev entry point owns the check.
- The service reports `CUSTOMIZE_BASE_STALE` for authored bytes that disagree with the compiled tip and `CUSTOMIZE_BASE_MOVED` for a customized release with a different first-party base.

## Slice 1 decision

- A focused sandbox probe renamed the Item SKU field on a test base, replayed an added Shelf code field and a Warehouse name list-column label, and observed all three in the normalized candidate. Its diff started at the replayed field-only release. The original two-patch release had a different root. This probe ran the compiler only.
- Rollback checks the exact revision-parent edge and the verified forward swap at the live fence. A staged upgrade needs to bind the prior live tenant release and the new first-party base. Migration 0029 records an authored patch per row. A base upgrade introduces no new authored patch.
- STOP before migration or grant edits. Choose an append-only upgrade relation or extend the existing lineage table with a distinct replay record. The separate relation preserves original patch authorship and the rollback edge. Slice 2 follows that decision.
- Dependency collision observed at [CUSTOMIZE-2 `9646b4f3`](https://github.com/AnserBeg/2rain-greenfield/commit/9646b4f3b97fa5aa583e898528cd408faec261a8). Its writer changed both the stored `addField` payload and how `patchRecord` interprets historical payloads. Run the upgrade proof against the integrated contract.

## Gates

- Slice 0 passed local format, typecheck, lint, and the focused readiness unit test. GitHub [CI run 44382708043](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44382708043) passed at packet tip `6d199dd3`. Critical paths touched in slice 0 — none. The agent fixes on the integration parent `62d34bd6` share no executable files with this slice.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "UPGRADE-1",
  "base": "fe5079d39277ba6d0e39946c23158888a4fe8ce2", "head": "6d199dd3d83f5cf3a19295369765b7e4dae6f465",
  "changedPaths": ["apps/api/src/main.ts", "test/unit/dev-environment.test.ts"],
  "symbols": [{"path": "apps/api/src/main.ts", "name": "ensureLocalPostgres"}]
}
```

## Test it yourself

Run `node --import tsx --test --test-name-pattern='dev readiness' test/unit/dev-environment.test.ts` to see the dev process probe container TCP. To exercise a fresh volume, run the following in one shell. Expect `COMPOSED_APPLICATION_READY` on the first invocation of `dev`. Press Ctrl-C to stop it.

```bash
export NORTH_STAR_DEV_DATABASE_CONTAINER=upgrade-1-readiness-demo
export NORTH_STAR_DATABASE_PORT=55483 PORT=4183
unset DATABASE_URL
corepack pnpm --filter @north-star/api dev:reset && corepack pnpm dev
```
