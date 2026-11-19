# CRITFIX-C — Only verified release generations serve requests

Critical release activation and migration change. All nine findings confirmed in the source. The swap, pointer compare-and-swap, fence and verification receipt remain separate durable facts.

## Claims and controls

| Finding | Regression |
|---|---|
| 1. Requests and restart use the prior verified generation across a post-swap crash. | The two interrupted activations in `customization-world.test.ts` compare the served release ID and fence before and after reopening. |
| 2. An invalid or refused platform successor leaves a standard tenant online. | The standard boot test supplies unreadable JSON, a mismatched predecessor and a rejected pointer update, then issues a real request. |
| 3. Forward activation requires a verified source and rollback requires the exact verified predecessor. | `release-activation.test.ts` refuses an interrupted source. The platform label upgrade test moves the predecessor receipt to a different fence. |
| 4. Approval backfill requires evidence of the original action. | `assertLegacyApprovalReconciliation` executes the original 0035 backfill and its correction against the same ambiguous approval. |
| 5. First-party boot takes the release-scope lock. Reconciliation locks the exact verified physical generation while updating inventory. | Standard boot waits behind a held lock before its first-party swap. The same test presents a stale fence and checks that every inventory root remains unchanged, then reuses the exact proof. |
| 6. Historical replay supplies each recorded acknowledgement and evaluator binding. | The field-only chain test removes both kinds of permission from the installed compiler input and reproduces the historical root. |
| 7. A verified swap retains its exact rollback target when replay history is unreadable. | The cyclic-history case rolls back and checks the restored release. The screen test submits its displayed release and fence. |
| 8. Upgrade patch IDs are ordered, distinct, scoped references. | Persistence refuses a number, a duplicate and an absent reference. Status omits a digest-valid malformed legacy row and preserves its siblings. |
| 9. Activation checks the selected base against the installed tip under lock. | The platform label upgrade test approves on one checkout and attempts activation from another at the same source and fence. |

## Decisions

The forward migration conservatively marks indistinguishable legacy approvals for reconciliation. Historical actions with missing compiler inputs cannot be reproduced safely. Both cases preserve verified serving and rollback. Deployments retain every tenant's patch-parser and surface-reader floors.

## Test it yourself

Run `node --import tsx --test --test-name-pattern="field-only chain|release-bound rollback" test/unit/{customization,customize-screen}.test.ts`. Expect the historical root to reproduce and rollback to remain available for an unreadable history.

## Gates

[Hosted CI 44483314661](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44483314661) passed on the executable tree. The final branch synchronization changed only documentation. The local historical replay exceeded the sandbox time limit under contention.

```record-claim
{
  "schemaVersion":"northstar.record-claim/v1","packet":"CRITFIX-C",
  "base":"5dc9c849f484d033dfccd3615cfc23cb2e2b683b","head":"bc35cc289923fec6db773121ebbaaec3fd59425b",
  "changedPaths":[
    "apps/api/src/composition-root.ts", "apps/web/src/customize-screen.ts", "db/migrations/0037_verified_release_history.sql", "db/schema.snapshot.json", "packages/customization/src/sandbox-worker.ts",
    "packages/customization/src/sandbox.ts", "packages/postgres-provider/src/active-release-root.ts", "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/customization-lineage.ts", "packages/postgres-provider/src/customization-service.ts",
    "packages/postgres-provider/src/release-activation-service.ts", "packages/postgres-provider/src/release-approval-service.ts", "packages/postgres-provider/src/release-reverse-transition-policy.ts", "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/postgres-provider/src/verified-release-generation.ts",
    "test/agent/assistant-endpoint.test.ts", "test/architecture/release-persistence-boundary.test.ts", "test/architecture/request-runtime-view-boundary.test.ts", "test/evidence/CRITFIX-B.expected-red.json", "test/fixtures/g2/catalog/runtime-harness.ts",
    "test/fixtures/g2/location/runtime-harness.ts", "test/fixtures/g2/party/runtime-harness.ts", "test/helpers/verified-fixture-release.ts", "test/postgres/composed-application.test.ts", "test/postgres/customization-world.test.ts",
    "test/postgres/customization.test.ts", "test/postgres/inventory-backup-restore.test.ts", "test/postgres/inventory-onhand.test.ts", "test/postgres/inventory-posting.test.ts", "test/postgres/inventory-reconciliation.test.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts", "test/postgres/module-runtime.test.ts", "test/postgres/module-storage-transition.test.ts", "test/postgres/release-activation.test.ts",
    "test/postgres/request-runtime-view.test.ts", "test/postgres/trust-substrate.test.ts", "test/unit/customization.test.ts", "test/unit/customize-screen.test.ts"
  ],
  "symbols":[{"path":"packages/postgres-provider/src/composed-application-runtime.ts","name":"readVerifiedServing"}]
}
```
