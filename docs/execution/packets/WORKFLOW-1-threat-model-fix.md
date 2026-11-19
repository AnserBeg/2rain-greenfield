# WORKFLOW-1 authority boundaries and receipt scope

N2 workflow correction. [ADR-0073](../../decisions/ADR-0073-workflow-isolate-and-authority.md#authority-boundaries) records the pre-sign-in authorities, the four runtime rules and the local demo scheduler policy. Integration disposition is `merged — unread`.

## Claims and controls

- R1. An unproven write leaves no committed operation receipt without approval. Control `workflow-missing-dependency-proof`.
- R2. A definition verified after approval never enters replay. Control `workflow-verify-before-approval`.
- R3. A write leaves no committed receipt after the automation actor loses its grant. Control `workflow-revoked-automation-grant`.
- R4. Activation and rollback complete while replay is stalled. Control `workflow-stalled-replay-release-lock`.
- Dispatch and the committed operation derive company and receipt from the source event. Control `workflow-substituted-receipt-scope`.

[Expected-red manifest](../../../test/evidence/WORKFLOW-1-threat-model-fix.expected-red.json)

## Decisions

- Derive receipt scope in `loadRun` from the posting event and linked change document. Preserve stale-run suspension, cancellation and committed-effect reconciliation when the worker cannot read historical source rows.
- Worker-written query replay results can change the branch taken. The gateway still requires exact Tier A proof for unattended writes and checks current grants. Filed in the archive.
- The R4 test covers release changes during stalled guest replay. Isolation from a compromised database session retaining a release lock remains open and is filed.
- The fix uses existing trust rows and requires zero migrations.

## Test it yourself

Run `node --import tsx --test test/postgres/workflow-consumer.test.ts` with Docker running. The four rule tests and the receipt-scope regression should pass. The receipt regression checks the actual operation receipt after the instance supplies different scope values.

## Gates

The ledger and review log link the acceptance run for the integrated packet.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "WORKFLOW-1-threat-model-fix",
  "base": "9ac017b915d24b058a35450db92433c97486a2f7",
  "head": "d6149efcc7f4a730778719aa2569a8eebb27ae79",
  "changedPaths": [
    "packages/postgres-provider/src/workflow-execution.ts",
    "test/evidence/WORKFLOW-1-threat-model-fix.expected-red.json",
    "test/postgres/workflow-consumer.test.ts"
  ],
  "symbols": [
    {"path": "packages/postgres-provider/src/workflow-execution.ts", "name": "loadRun"}
  ]
}
```
