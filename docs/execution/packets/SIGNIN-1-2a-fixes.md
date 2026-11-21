# SIGNIN-1 slice 2a fixes — pilot decision and proposal evidence

Critical database migration and verifier changes. The exact integration candidate requires full CI.

## Claims

1. Pilot Retry requires proof both when recording the decision and when advancing the run. A legitimate proof advances the fence and records one decision.
2. Company-scoped staff can review only Retry runs owned by their company. Environment-wide release approval requires unscoped membership.
3. The approval trigger refuses a missing proof, a receipt from a prior transaction, or a proof for another preparation.
4. GRANTS-GUARD checks effective privileges in unclaimed, pilot and demo stores.
5. The verifier re-renders the release diff from immutable release data and checks the text and digests before inserting an approval.
6. The Customize draft service records a staff-session proposal through the pilot database writer and returns its assigned patch ID.
7. Repeat consumption returns the original receipt under current authority. New consumption checks the current fence, expiry and session. ADR-0081 records why Cancel requires no proof.

## Decisions

- Reuse the locked staff session to serialize receipt creation and repeated consumption.
- Resolve forward and reverse rendering from the activation policy and persisted release pair.
- Staff-session drafts use the Customize service. Pilot browser authoring requires the governed builder route.
- The database-only migration uses the current release reader rung.

## Gates and controls

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44844682135

The focused release and grants files passed locally, including production Customize draft recording. The focused PostgreSQL Retry fixture passed in pilot with both guards active. The broader workflow file hit its local timeout and is covered by full CI. Removing the corresponding checks made the regressions fail for both Retry guards, company authority and owner matching, approval binding, diff rendering, draft routing, claimed-mode grants, fence changes, expiry, session revocation and receipt replay. The branch preflight above found a fixture type error that was corrected for the integration candidate.

## Test it yourself

Run `node --import tsx --test test/postgres/release-approval.test.ts test/postgres/application-grants.test.ts`. Expect the staff approval refusals and verified swap to pass, with grants matching in both claimed modes.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "SIGNIN-1-2a-fixes",
  "base": "67e4efce31eb663f12d6f161aa91c0ce1220dffc",
  "head": "84a9a9611f6b2618f34ce1ef9396392c2348bcb2",
  "changedPaths": ["apps/api/src/staff-decisions.ts", "db/migrations/0058_staff_decision_corrections.sql", "db/schema.snapshot.json", "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/customization-service.ts", "packages/postgres-provider/src/release-approval-service.ts", "packages/postgres-provider/src/release-diff-binding.ts", "packages/postgres-provider/src/request-context.ts", "test/architecture/release-persistence-boundary.test.ts", "test/helpers/staff-decision-checks.ts", "test/postgres/application-grants-by-mode.tsv", "test/postgres/application-grants.test.ts", "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts", "test/postgres/release-approval.test.ts", "test/postgres/trust-substrate.test.ts", "test/postgres/workflow-consumer.test.ts"],
  "symbols": [
    {"path": "packages/postgres-provider/src/customization-service.ts", "name": "PostgresCustomizationService"},
    {"path": "packages/postgres-provider/src/release-diff-binding.ts", "name": "releaseDiffBinding"},
    {"path": "packages/postgres-provider/src/release-diff-binding.ts", "name": "loadPersistedDiffRelease"},
    {"path": "packages/postgres-provider/src/request-context.ts", "name": "recordStaffCustomizationProposal"},
    {"path": "test/helpers/staff-decision-checks.ts", "name": "checkReleaseDecisions"},
    {"path": "test/helpers/staff-decision-checks.ts", "name": "checkRetryDecision"}
  ]
}
```
