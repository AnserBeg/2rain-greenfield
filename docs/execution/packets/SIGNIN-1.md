# SIGNIN-1 — staff sign-in and authority for human decisions

Slice 2a adds reviewed staff decisions. [Slice 1 and its gates](https://github.com/AnserBeg/2rain-greenfield/blob/17618776/docs/execution/packets/SIGNIN-1.md) · [Accepted design](../../decisions/ADR-0081-staff-sign-in-and-decision-authority.md)

## Decisions

- Release approval freezes the verified candidate, preparation, reviewed diff, source pointer and fence. The isolated activation verifier consumes the evidence and creates the prebound attempt in one transaction. The activation kernel checks current authority, performs the swap and reads back the generation.
- Customize uses the same release approval, with the exact patch payloads, bases and reviewed diff in the proof. A fresh passkey confirmation binds the principal, assurance, authentication time and decision time.
- Retry records the company, suspended run, occurrence, definition, journal and original and restored fences. WORKFLOW-1’s join is the transaction that writes its retry decision and resumes the run. The database requires a matching proof consumption in the same transaction. Pilot scheduling remains closed pending effect reconciliation and that join.
- Release and Customize cover every company on the environment pointer and require an unscoped membership. Retry takes the company from the event and checks the operator’s live membership. A reviewed batch binds each named target and its ordered aggregate.
- Slice 2b stays closed pending CONNECT-1’s canonical connection and outward-send records and their writers. Pilot enablement requires a proof-consuming function. Real provider calls remain limited to the local demo.
- This slice uses a forward database migration and the existing surface reader. The orchestrator owns the independent post-merge read.

## Gates and test it yourself

Run `node --import tsx --test test/postgres/release-approval.test.ts`. The staff subtest checks release and Customize decisions, refuses activation after membership loss, then observes a verified swap. The Retry case runs in `test/postgres/workflow-consumer.test.ts`. [Staff pilot instructions](../../operations/staff-signin.md#approvals-and-activation)

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "SIGNIN-1",
  "base": "17618776dd058bbb8efec032eae13a00a5d5398b",
  "head": "7eb35bbb55dd0d0326cad639cebd81176cc731e4",
  "changedPaths": [
    "apps/api/src/staff-decisions.ts", "apps/api/src/staff-identity-http.ts",
    "apps/api/src/staff-identity.ts", "apps/api/src/staff-main.ts",
    "apps/api/src/staff-protocol.ts", "db/migrations/0051_staff_decision_proofs.sql",
    "db/schema.snapshot.json", "docs/execution/ledger.md",
    "docs/execution/packets/CONNECT-1.md", "docs/execution/packets/SIGNIN-1.md",
    "docs/execution/review-log.md", "docs/operations/staff-signin.md",
    "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/release-activation-service.ts",
    "packages/postgres-provider/src/release-approval-service.ts", "packages/postgres-provider/src/request-context.ts",
    "test/architecture/release-persistence-boundary.test.ts", "test/architecture/tenant-completeness.manifest.json",
    "test/architecture/tenant-completeness.test.ts", "test/helpers/staff-decision-checks.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts", "test/postgres/release-approval.test.ts",
    "test/postgres/staff-signin.test.ts", "test/postgres/trust-substrate.test.ts",
    "test/postgres/workflow-consumer.test.ts"
  ],
  "symbols": [{"path":"apps/api/src/staff-decisions.ts","name":"applyStaffDecision"},{"path":"apps/api/src/staff-decisions.ts","name":"runDecisionVerifier"}]
}
```
