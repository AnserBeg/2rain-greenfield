# SIGNIN-1 — staff sign-in and authority for human decisions

Slice 2a adds reviewed staff decisions. [Slice 1 and its gates](https://github.com/AnserBeg/2rain-greenfield/blob/17618776/docs/execution/packets/SIGNIN-1.md) · [Accepted design](../../decisions/ADR-0081-staff-sign-in-and-decision-authority.md)

## Decisions

- Release approval freezes the verified candidate, preparation, reviewed diff, source pointer and fence. The isolated activation verifier consumes the evidence and creates the prebound attempt in one transaction. The verifier reads the kernel’s scoped release evidence. It can update only the pointer’s release ID and fence. The kernel checks current authority, performs the swap and reads back the generation.
- Customize uses the same release approval, with the exact patch payloads, bases and reviewed diff in the proof. A fresh passkey confirmation binds the principal, assurance, authentication time and decision time.
- Retry records the company, suspended run, occurrence, definition, journal and original and restored fences. WORKFLOW-1’s canonical remedy writer records the proof, restores the run fence and appends the control journal entry in the consumption transaction. The worker reconciles committed effects before further dispatch. Pilot scheduling stays closed.
- Release and Customize cover every company on the environment pointer and require an unscoped membership. Retry takes the company from the event and checks the operator’s live membership. A reviewed batch binds each named target and its ordered aggregate.
- This slice uses a forward database migration and the existing surface reader. The orchestrator owns the independent post-merge read.

## Slice 2b — provider enablement and outward sends

Slice 2b stays closed pending CONNECT-1’s canonical connection and outward-send records and their writers. Only a database explicitly claimed for the local demo grants direct address installation writes. Pilot enablement awaits a proof-consuming function. Outward-send confirmation must consume its proof in CONNECT-1’s writer. [ADR-0088](../../decisions/ADR-0088-governed-communications-and-reminders.md)

## Gates and test it yourself

The four database controls temporarily remove single use, decision digest, scope and current authority in a disposable database. [Focused evidence run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44811891168)

Run `node --import tsx --test test/postgres/release-approval.test.ts`. The staff subtest checks release and Customize decisions, refuses activation after membership loss, then observes a verified swap. The Retry case runs in `test/postgres/workflow-consumer.test.ts`. [Staff pilot instructions](../../operations/staff-signin.md#approvals-and-activation)

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "SIGNIN-1",
  "base": "faf1b947c95c86403c838fcdbc0ff337d988c684",
  "head": "88b5a905382158fa705f6a14e0d33d47626e4d55",
  "changedPaths": [
    "apps/api/src/staff-decisions.ts", "apps/api/src/staff-identity-http.ts",
    "apps/api/src/staff-identity.ts", "apps/api/src/staff-main.ts",
    "apps/api/src/staff-protocol.ts", "db/migrations/0055_staff_decision_proofs.sql",
    "db/schema.snapshot.json",
    "docs/execution/packets/CONNECT-1.md", "docs/execution/packets/SIGNIN-1.md",
    "docs/operations/staff-signin.md",
    "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/release-activation-service.ts",
    "packages/postgres-provider/src/release-approval-service.ts", "packages/postgres-provider/src/request-context.ts",
    "test/architecture/release-persistence-boundary.test.ts", "test/architecture/tenant-completeness.manifest.json",
    "test/architecture/tenant-completeness.test.ts", "test/helpers/staff-decision-checks.ts",
    "test/postgres/application-grants.tsv", "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts", "test/postgres/release-approval.test.ts",
    "test/postgres/staff-signin.test.ts", "test/postgres/trust-substrate.test.ts",
    "test/postgres/workflow-consumer.test.ts"
  ],
  "symbols": [{"path":"apps/api/src/staff-decisions.ts","name":"applyStaffDecision"},{"path":"apps/api/src/staff-decisions.ts","name":"runDecisionVerifier"}]
}
```
