# SIGNIN-1 — staff sign-in and authority for human decisions

Slice 1 uses passkeys and session-bound ERP entry. The [previous correction record](https://github.com/AnserBeg/2rain-greenfield/blob/13902266/docs/execution/packets/SIGNIN-1.md) covers the eight corrections in Sol’s narrow read.

## Final slice 1 corrections

| Item | Verified behavior |
| --- | --- |
| ERP landing and retention | Four anonymous landing GETs leave zero rows. Login starts on a same-origin POST with the browser's CSRF token. The shared limiter admits 30 starts per client per 15 minutes. Each admitted start removes expired and consumed transactions in its realm. |
| Expiry | The accepted residual needs both a database crash and a backwards host clock. Session checks run inside the protected transaction. Independently committing its time observation would require a separate coordinated writer. [ADR-0081](../../decisions/ADR-0081-staff-sign-in-and-decision-authority.md#sessions-and-request-entry) |
| Handoff | A database trigger witnesses consumption before an expired handoff is refused. Rollback restores the verifier for a valid handoff. A second live ERP handle is refused and the original handle succeeds. |
| Recovery | Valid passkey ceremonies refuse a different permission resource, uncovered release approver eligibility and uncovered executor authority. A recovery started while its issuer has authority is refused at enrollment after revocation. The credential count stays zero and the invitation stays available. |

## Slice 2b: provider enablement and outward sends

Slice 2b is the part of slice 2 that enables providers and opens outward sends. It waits for CONNECT-1's canonical pending-send records and joins proof consumption to CONNECT-1's writer ([ADR-0088](../../decisions/ADR-0088-governed-communications-and-reminders.md)).

## Gates and test it yourself

The architecture check admits the transient login cleanup in its migration and schema snapshot. Its fixture flags business deletes in both files and login deletion in application code.

The landing regression failed on `13902266`. Temporarily removing the rollback, prior-handle, resource, release approver, release executor and enrollment protections in isolated checkouts made the corresponding assertions fail. [Targeted controls](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44716635434) · [Packet CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44720371650)

Run `node --import tsx --test test/postgres/staff-signin.test.ts` and `node --import tsx test/helpers/staff-browser-journey.ts`. Both use temporary databases. The browser completes sign-in through the ERP landing and identity origins, and reports the signed-in purchase-order page budget. The orchestrator owns the targeted check and the start of slice 2.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "SIGNIN-1",
  "base": "2042780bcc3889022af36493a2dcaa3a62b8cb56",
  "head": "1b1092a7514095ccfbe708ee6d9e97a0c48c0816",
  "changedPaths": [
    "apps/api/src/pilot-composition-root.ts",
    "apps/api/src/staff-erp-transport.ts",
    "apps/api/src/staff-identity-http.ts",
    "apps/api/src/staff-identity.ts",
    "apps/api/src/staff-main.ts",
    "apps/api/src/staff-protocol.ts",
    "db/migrations/0049_staff_login_creation.sql",
    "db/schema.snapshot.json",
    "docs/decisions/ADR-0081-staff-sign-in-and-decision-authority.md",
    "docs/operations/staff-signin.md",
    "packages/dev-tooling/src/architecture-boundaries.ts",
    "test/architecture/dependency-boundaries.test.ts",
    "test/architecture/release-persistence-boundary.test.ts",
    "test/helpers/staff-browser-fixture.ts",
    "test/helpers/staff-browser-journey.ts",
    "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/staff-signin.test.ts",
    "test/postgres/trust-substrate.test.ts"
  ],
  "symbols": [
    {"path":"apps/api/src/staff-erp-transport.ts","name":"erpTransport"},
    {"path":"apps/api/src/staff-protocol.ts","name":"attemptBucket"}
  ]
}
```
