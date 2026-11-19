# CRITFIX-B — keep verified releases live through a refused customization upgrade

All nine charter findings were confirmed. Critical paths include the forward migration and its tenant grants.

## Claims

1. A moved base and an unsupported or unreadable patch leave verified records queryable. A stable diagnostic survives restart and appears on Customize and in CLI status.
2. Status and rollback follow immutable record identities. Rollback loads the approved release pair and retains the reverse-transition and fence checks.
3. Historical compilation narrows the checkout’s bindings and acknowledgements to each revision’s declared permissions.
4. PostgreSQL enforces the first-party base and candidate revision at insert. Both active-release readers reject cycles and follow the exact base release selected by the approval.
5. Equal candidates from successive bases coexist. Approval and activation select one upgrade ID. The rollback form identifies that upgrade and submits the release shown.
6. Boot logs contain diagnostic codes and opaque identities. Whole-package compiler failures retain their subject and omit patch attribution.

## Controls and gates

[Six mutation controls](../../../test/evidence/CRITFIX-B.expected-red.json) cover refusal scope, base provenance, revision binding, approval isolation, stale submissions and logging. Focused compiler and screen tests cover the remaining diagnostics.
[Hosted CI and integration](https://github.com/AnserBeg/2rain-greenfield/pull/100). Local format, typecheck and lint cover the packet. Two existing permission controls now target the shared compiler helper.

Deploy only versions at or above the newest patch-parser and surface-reader floors already used by any tenant.

```record-claim
{
  "schemaVersion":"northstar.record-claim/v1","packet":"CRITFIX-B",
  "base":"7df1ea960f03528926be71e55cbbea7cfcbb77a3","head":"9cbd3fa44b0e084fc005659cb24bd3e674e859f5",
  "changedPaths":[
    "apps/api/scripts/customize-cli.ts", "apps/api/src/main.ts", "apps/web/scripts/unbound-permission-acknowledgement.ts",
    "apps/web/src/customize-screen.ts", "db/migrations/0033_customization_upgrade_bindings.sql", "db/schema.snapshot.json",
    "packages/compiler/src/index.ts", "packages/compiler/src/protocol.ts", "packages/customization/src/candidate.ts",
    "packages/customization/src/sandbox-worker.ts", "packages/customization/src/sandbox.ts", "packages/postgres-provider/src/active-release-root.ts",
    "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/customization-lineage.ts", "packages/postgres-provider/src/customization-service.ts",
    "packages/postgres-provider/src/release-approval-service.ts", "test/agent/assistant-endpoint.test.ts", "test/architecture/release-persistence-boundary.test.ts",
    "test/architecture/tenant-completeness.manifest.json", "test/architecture/tenant-completeness.test.ts", "test/evidence/CRITFIX-B.expected-red.json",
    "test/evidence/policy-unbound-refusal.expected-red.json", "test/postgres/customization.test.ts", "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts", "test/postgres/module-storage-transition.test.ts", "test/postgres/trust-substrate.test.ts",
    "test/unit/customization.test.ts", "test/unit/customize-screen.test.ts"
  ],
  "symbols":[{"path":"packages/postgres-provider/src/customization-lineage.ts","name":"readCustomizationLineage"}]
}
```

## Test it yourself

- Run `node --import tsx --test --test-name-pattern="whole-package upgrade|field-only chain|release-bound rollback" test/unit/{customization,customize-screen}.test.ts`. All three cases pass.
- On a tenant with a live record-type change, start a newer base. Open a saved record, then Customize. The refusal code matches `corepack pnpm customize status`. Roll back the displayed release to restore its predecessor.
