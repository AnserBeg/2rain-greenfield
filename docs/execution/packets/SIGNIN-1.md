# SIGNIN-1 — staff sign-in and authority for human decisions

[ADR-0081](../../decisions/ADR-0081-staff-sign-in-and-decision-authority.md) fixes the pilot origins, user-verified passkeys, session limits and attended recovery. Slice 1 landed at `60451569`. The orchestrator requested eight corrections after its independent read.

The original slice binds ERP reads and protected writes to the session and supports enrollment, recovery, revocation and sign-out across instances. The [initial slice record](https://github.com/AnserBeg/2rain-greenfield/blob/60451569/docs/execution/packets/SIGNIN-1.md) preserves its gates.

## Slice 1 corrections

| Finding | Decision and observed control |
| --- | --- |
| Store mode | Installation and demo bootstrap claim the same durable database mode. Concurrent first claims admit one mode, and another environment cannot change it. |
| Reauthentication | A passkey assertion rotates the existing family under lock. Two completions have one winner, the family ID and original deadline agree to the microsecond, and the previous handles are refused. |
| ERP verifier | ERP sign-in persists a five-minute transaction with the prior ERP handle digest. Two handoffs sharing its verifier yield one redemption, and a failed exchange leaves the transaction available. |
| Clock rollback | Session checks share a database time watermark that survives transaction rollback. Injected database time crosses each deadline and moves back. Both idle and absolute expiry hold. Application reads run with a read-only transaction. |
| Recovery | The issuer must cover the target’s live permissions, resources, companies and release authority. Policy locks cover revocation and replacement, and enrollment checks the issuer again. A refused recovery keeps the credential active and issues zero invitations. |
| Source limits | A configured ingress supplies one verified client address. Other connections use their socket peer. The HTTP test observes distinct source allowances. |
| Grants | Database column privileges permit credential counter, backup state and revocation changes and account lifecycle updates. The test enumerates the identity login’s actual writable columns. |
| Enrollment logging | An enrollment conflict returns a generic refusal. The database log test observes a duplicate constraint error while the credential identifier and key bytes stay absent. |

## Gates and test it yourself

The PostgreSQL regressions and the Chromium passkey rotation check are red on `60451569`. Packet CI [run 44696495008](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44696495008) passed.
Run `node --import tsx --test test/postgres/staff-signin.test.ts` and `node --import tsx test/helpers/staff-browser-journey.ts`. Both use temporary databases. Expect passing database checks and a signed-in purchase-order list within three transactions and forty statements.
The [operator guide](../../operations/staff-signin.md) describes ingress configuration. Slice 2 awaits the orchestrator’s narrow read.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "SIGNIN-1",
  "base": "b64cd6aa2e829eac1b0a4610cfcd5f56a8b67d34",
  "head": "1e5842bc017850b09024d61947b62410d3718822",
  "changedPaths": [
    "apps/api/src/pilot-composition-root.ts", "apps/api/src/staff-erp-transport.ts",
    "apps/api/src/staff-identity-http.ts", "apps/api/src/staff-identity.ts",
    "apps/api/src/staff-main.ts", "db/migrations/0047_staff_session_integrity.sql",
    "db/schema.snapshot.json", "docs/operations/staff-signin.md",
    "packages/dev-tooling/src/tenant-completeness.ts", "packages/postgres-provider/src/composed-application-runtime.ts",
    "packages/postgres-provider/src/request-context.ts", "test/architecture/release-persistence-boundary.test.ts",
    "test/architecture/tenant-completeness.manifest.json", "test/architecture/tenant-completeness.test.ts",
    "test/evidence/SIGNIN-1.expected-red.json", "test/helpers/staff-browser-fixture.ts",
    "test/helpers/staff-browser-journey.ts", "test/helpers/staff-passkey-checks.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts", "test/postgres/staff-signin.test.ts",
    "test/postgres/trust-substrate.test.ts"
  ],
  "symbols": [
    {"path":"apps/api/src/staff-identity.ts","name":"StaffIdentity"},
    {"path":"apps/api/src/staff-identity-http.ts","name":"identityHandler"},
    {"path":"packages/postgres-provider/src/request-context.ts","name":"staffRequestEntry"}
  ]
}
```
