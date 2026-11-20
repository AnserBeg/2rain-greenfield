# SIGNIN-1 — staff sign-in and authority for human decisions

## Claims and decisions

[ADR-0081](../../decisions/ADR-0081-staff-sign-in-and-decision-authority.md) incorporates Fable’s eight dispositions. The pilot uses one ERP/identity origin pair and user-verified discoverable passkeys. Each scoped account maps to one immutable staff principal.
The identity service enrolls the first owner and manages attended invitations, spare keys, deactivation and recovery. Recovery invalidates existing access and starts the 24-hour decision cool-off.
ERP request entry derives the principal from the session. Protected writes verify it again in their own database transaction. The pilot loads the existing ERP gateways and SurfaceRuntime through a separate composition root.
The loopback demo retains its explicit actor switch. The pilot requires the actual serving and identity logins and a database provisioned without fixture proof issuance.
One forward migration adds the identity realm, staff accounts, credentials, enrollment, challenges, sessions, shared rate counters and authentication audit. The compiled surface language and release lineage stay at their existing floors.

## Gates and controls

The PostgreSQL test observes committed writes, idle/absolute expiry, a clock regression, live role membership, concurrent bootstrap, cross-scope refusal, role privileges and append-only evidence. Two named controls remove the idle and revocation checks individually.
The Chromium test exercises real passkey registration and assertion on HTTPS, one-use handoffs, distinct session audiences, request identity, CSRF, recovery, deactivation and sign-out across ERP instances. It measures the signed-in purchase-order list against three transactions and forty statements.
The import-boundary test loads the pilot with demo actor, seed and CLI imports refused, then proves its control against the demo root.

## Test it yourself

With Docker and the project’s Chromium installed, run `node scripts/run-with-test-lock.mjs exclusive -- node --import tsx test/helpers/staff-browser-journey.ts`. Expect exit zero. The journey uses temporary loopback listeners and an isolated database.
Run `node --import tsx --test test/postgres/staff-signin.test.ts` for the database guarantees. See the [operator guide](../../operations/staff-signin.md) to run the two services.
Slice 2 awaits the orchestrator. Both ADR-0073 findings and proof-gated signatures, connections, sends, customer links and workflow decisions retain their gates.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "SIGNIN-1",
  "base": "f59afb11fda87bcde13170f8fe00795fadbf0506",
  "head": "705b986bc397bcffbf2d3ec5237832eb315e8904",
  "changedPaths": [
    "apps/api/package.json", "apps/api/src/composition-root.ts",
    "apps/api/src/erp-capabilities.ts", "apps/api/src/pilot-composition-root.ts",
    "apps/api/src/staff-erp-transport.ts", "apps/api/src/staff-identity-http.ts",
    "apps/api/src/staff-identity.ts", "apps/api/src/staff-main.ts",
    "apps/api/src/staff-protocol.ts", "apps/web/src/app-server.ts",
    "apps/web/src/surface-client.ts", "apps/web/src/surface-runtime.ts",
    "apps/web/test/browser/staff-signin.spec.ts", "db/migrations/0044_staff_signin.sql",
    "db/schema.snapshot.json", "packages/postgres-provider/src/composed-application-runtime.ts",
    "packages/postgres-provider/src/inventory-posting-service.ts", "packages/postgres-provider/src/request-context.ts",
    "packages/postgres-provider/src/serving-gateways.ts", "pnpm-lock.yaml",
    "test/architecture/pilot-identity-boundary.test.ts", "test/architecture/release-persistence-boundary.test.ts",
    "test/architecture/repository-hygiene.test.ts", "test/architecture/tenant-completeness.manifest.json",
    "test/architecture/tenant-completeness.test.ts", "test/evidence/SIGNIN-1.expected-red.json",
    "test/evidence/auth.expected-red.json", "test/helpers/staff-browser-fixture.ts",
    "test/helpers/staff-browser-journey.ts", "test/helpers/staff-passkey-checks.ts",
    "test/postgres/inventory-storage.test.ts", "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts", "test/postgres/staff-signin.test.ts",
    "test/postgres/trust-substrate.test.ts"
  ],
  "symbols": [
    {"path":"apps/api/src/staff-identity.ts","name":"StaffIdentity"},
    {"path":"apps/api/src/pilot-composition-root.ts","name":"createPilotApplication"},
    {"path":"packages/postgres-provider/src/request-context.ts","name":"staffRequestEntry"}
  ]
}
```
