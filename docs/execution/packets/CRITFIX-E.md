# CRITFIX-E — Company-owned writes and Inspection reader compatibility

Generic record updates, transitions, archive and restore authorize the stored company under a row lock in the write transaction. The same decision precedes idempotent replay. Only creation accepts the system company operand.
Saved views require surface reader 24, Today metrics 25 and Inspection metadata 26. Workflow-bearing releases reserve 27. Deployments must support the newest patch parser and surface reader any tenant has used.

## Evidence

The PostgreSQL ownership test failed on the baseline when the foreign update succeeded. Authorized updates, transitions, archive and restore exercise the same operations on the caller’s company. The control also checks owner immutability and replay after a grant change.
The baseline compiler assigned Inspection 25. The activated Inspection release now requires 26 and its serving loader refuses a reader capped at 25. The compatibility test covers every pairing from 22 through 26.
Regenerated the pre-tenant release, migration schema and fresh-tenant replay schema. All three reproduced byte for byte. No migration is required. The integration row links the hosted gate.

## Test it yourself

- Run `node --import tsx --test --test-name-pattern='company-owned tenant record mutations' test/postgres/customization.test.ts` for the two-company test.
- Run `node --import tsx --test --test-name-pattern='tenant line tables use|capability comparison' test/unit/customization.test.ts test/postgres/request-runtime-view.test.ts` for the floor checks.

```record-claim
{
  "schemaVersion":"northstar.record-claim/v1","packet":"CRITFIX-E","base":"5a7daf8e64aa50aee56cbdf068f1fe78583a2321","head":"f8e9be4166fbc80e1e63bf3044e976ba25d8c1d7",
  "changedPaths": ["packages/compiler/src/projections.ts", "packages/postgres-provider/src/current-policy.ts", "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/request-runtime-view-service.ts", "packages/postgres-provider/src/trust/postgres-trust-service.ts", "packages/runtime/src/request-runtime-view.ts", "packages/runtime/src/semantic-operation-gateway.ts", "test/agent/agent-world.ts", "test/evidence/auth.expected-red.json", "test/postgres/customization.test.ts", "test/postgres/request-runtime-view.test.ts", "test/unit/customization.test.ts"],
  "symbols":[{"path":"packages/postgres-provider/src/module-runtime-interpreter.ts","name":"readRecordCompany"},{"path":"packages/runtime/src/request-runtime-view.ts","name":"SUPPORTED_RUNTIME_CAPABILITIES"}]
}
```
