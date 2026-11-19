# CRITFIX-A — Definer scope, Confirm denial evidence and assistant approval

Critical migration. Trunk status is `merged — unread`. The migration exceeds the 400-line threshold for the orchestrator's next read.

## Claims and controls

| Item | Observable result | Expected-red control |
| --- | --- | --- |
| 1 | Every application definer in the migrated catalog has an explicit search path ending in pg_temp. CREATE OR REPLACE retains all 25 signatures, owners and ACLs. | temporary-schema-implicit |
| 2 | A runtime caller with a matching tenant and environment and an empty principal receives SQLSTATE 42501 from the epoch lock. | principal-omitted-from-epoch-lock |
| 3 | A goods receipt commits during Confirm, its read-back denial insert fails, and the HTTP request returns 500 without the recovery form. | live-confirm-loses-denial |
| 4 | Twelve reviewed field/update pairs may run with Undo. An unknown field, record type or tier, a mixed patch or a missing prior value requires confirmation. | unreviewed-field-auto-approved |

## Decisions and evidence

On a freshly migrated database, PUBLIC holds TEMPORARY without grant option. All five application roles with callable definers, including north_star_runtime, have TEMP and cannot grant it onward. The database owner can.
Auto-approval uses the reviewed first-party field/update pairs, the release's existing policy guards, a revision-checked inverse and an observed prior value for each field. A sandbox-compiled Equipment name and a new Party desk label both classified as `needsYes`.

**platform** `bump_current_policy_epoch`, `create_active_release_pointer_for_environment`, `create_release_activation_authority_epoch_for_tenant`, `lock_current_policy_epoch`, `lock_release_activation_attempt`, `lock_release_activation_authority_epoch`, `provision_inventory_scope`, `read_tenant_release_artifacts`, `record_fresh_tenant_install_evidence`, `set_release_activation_control`, `set_release_approver_eligibility`, `set_release_executor_authority`, `stage_release_artifact`.

**north_star_internal** `advance_semantic_aggregate_generation`, `inventory_base_unit_change_allowed`, `inventory_business_period`, `inventory_provisioned_legal_entity_id`, `module_storage_lock_backfill_attempt`, `module_storage_read_active_release_pointer`, `module_storage_read_approved_attempt`, `module_storage_read_kernel_live_roots`, `module_storage_read_preparation_authority`, `module_storage_read_release_artifacts`, `provision_inventory_period_lock`, `witness_module_fold_function_ddl`.

## Test it yourself

Run `node --import tsx --test --test-name-pattern='auto-run snapshot|a new field|prior value of a multi-field' test/agent/business-map.test.ts`. Expect three passing tests. The HTTP and SQL checks run on GitHub.
[Candidate CI](https://github.com/rainerp-com/2rain-greenfield/actions/runs/44453372282) · [Pre-fix Confirm test](https://github.com/rainerp-com/2rain-greenfield/commit/322244fc73c6bf06cd7e67d8e49e4fdfe00acc26) returned 409 under the exclusive lock · [Four expected-red controls](https://github.com/rainerp-com/2rain-greenfield/actions/runs/44446856393).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CRITFIX-A",
  "base": "7df1ea960f03528926be71e55cbbea7cfcbb77a3",
  "head": "a4321c079417e8316f4cfe86969041ccaad067f6",
  "changedPaths": ["db/migrations/0033_definer_search_paths.sql", "db/schema.snapshot.json", "packages/operations-agent/src/risk.ts", "packages/operations-agent/src/session.ts", "packages/postgres-provider/src/request-context.ts", "test/agent/business-map.test.ts", "test/architecture/release-persistence-boundary.test.ts", "test/evidence/CRITFIX-A.expected-red.json", "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts", "test/postgres/read-snapshot.test.ts", "test/postgres/speed-fixes.test.ts", "test/postgres/trust-substrate.test.ts"],
  "symbols": [{"path": "packages/postgres-provider/src/request-context.ts", "name": "withReadSnapshot"}, {"path": "packages/operations-agent/src/risk.ts", "name": "operationRisk"}]
}
```
