# CRITFIX-E — Company-owned writes and Inspection reader compatibility

Generic record updates, transitions, archive and restore authorize the stored company under a row lock in the write transaction. The same decision precedes idempotent replay. Only creation accepts the system company operand.
Saved views require surface reader 24, Today metrics 25 and Inspection metadata 26. Workflow-bearing releases reserve 27. Deployments must support the newest patch parser and surface reader any tenant has used.

## Evidence

The PostgreSQL ownership test failed on the baseline when the foreign update succeeded. Authorized updates, transitions, archive and restore exercise the same operations on the caller’s company. The control also checks owner immutability and replay after a grant change.
The baseline compiler assigned Inspection 25. The archived floor-25 Today binary loads the predecessor and refuses the activated Inspection release at its surface gate before serving it. The compatibility test covers every pairing from 22 through 26.
Regenerated the pre-tenant release, migration schema and fresh-tenant replay schema. All three reproduced byte for byte. No migration is required. [CI 44588079841](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44588079841) passed all 18 jobs.

## Test it yourself

- Run `node --import tsx --test --test-name-pattern='company-owned tenant record mutations' test/postgres/customization.test.ts` for the two-company test.
- Run `node --import tsx --test --test-name-pattern='tenant line tables use|capability comparison' test/unit/customization.test.ts test/postgres/request-runtime-view.test.ts` for the floor checks.

```record-claim
{
  "schemaVersion":"northstar.record-claim/v1","packet":"CRITFIX-E","base":"d618fa3fa9f8ce51b3b05a70b990cdb411fe8909","head":"374a1f2609a7aae1ca55421ec07783e178937f05",
  "changedPaths": [".github/workflows/ci.yml", "packages/compiler/src/projections.ts", "packages/postgres-provider/src/current-policy.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/trust/postgres-trust-service.ts", "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-operation-gateway.ts", "test/agent/agent-world.ts", "test/evidence/auth.expected-red.json", "test/helpers/archived-customization-runtime.ts", "test/postgres/customization-inspection.test.ts", "test/postgres/customization-validation.test.ts", "test/postgres/customization.test.ts", "test/postgres/request-runtime-view.test.ts", "test/unit/customization.test.ts"],
  "symbols":[{"path":"packages/postgres-provider/src/module-runtime-interpreter.ts","name":"readRecordCompany"},{"path":"packages/runtime/src/request-runtime-view.ts","name":"SUPPORTED_RUNTIME_CAPABILITIES"}]
}
```
