# COMPANY-BOUND-WRITES — a write naming an existing company-owned record acts only in the company its page was entered in

Status: executable on draft PR against `packet/INTEGRATION`; no merge, no deployment. Sole local author on `packet/COMPANY-BOUND-WRITES`. Fixes RETURNABLE-ASSETS round 1 finding F4 (P2, inherited shared runtime).
Tier: outside the Critical set — the web runtime, the semantic operation gateway, the generic interpreter (`module-runtime-interpreter.ts`, not the posting kernel) and one read-only accessor on `postgres-provider/src/trust/postgres-trust-service.ts`. No change to `platform-runtime/src/trust/`, the posting kernel, the serializer, the materializer, activation, release verification, migrations, RLS or grants. No compiled output, authored definition or release lineage changes. Stops taken: none.
Base: `origin/packet/INTEGRATION` at `8c8cfab1`.

## The defect (reproduced first)

A tenant-wide operator posted company B's stock count id and current revision through the stock count form entered in company A. At the base (`8c8cfab1` in a detached worktree, only `test/postgres/company-bound-writes.test.ts` added) the write committed: subtest `"an edit posted through a page entered in A does not change B's record"` failed with B's stored row moved from `number: 'EDIT-B', revision: '1'` to `number: 'MOVED-BY-A', revision: '2'`, company still B. Archive through A also archived B's record (`"archiving B's record through A's page must be refused"`). The base refused every operand-carrying write as `MODULE_INPUT_MALFORMED` (an unknown key), and its lock subtest leaked an open transaction that confounded the last subtest (fixed in `198242aa`).

## Claims

1. Update, archive, restore and transition (every generic write that names an existing record) admit an optional `legalEntityId` operand, through one list (`admittedOperationArgumentKeys`) that both the gateway's closed-key fence and the provider's parser use. Capability commands and creates are unchanged.
2. When it is present, the provider reads the record's company from the persisted row, `FOR NO KEY UPDATE`, in the write's transaction, after the parent guards and before the writer (`requireRecordLegalEntityBinding`), so the writer's revision compare-and-increment runs under the same lock. A different company refuses `MODULE_LEGAL_ENTITY_BINDING_MISMATCH` and writes nothing; a company on a tenant-level record refuses `MODULE_LEGAL_ENTITY_BINDING_UNSUPPORTED` and writes nothing.
3. The operand is the key a scoped create carries, so current policy authorizes it the same way: a principal granted only company A may now write A's records through a bound write (before, any generic update needed a tenant-wide grant), cannot reach B's through it (claim 2), and is denied naming B. An unbound write still needs the tenant-wide grant.
4. The operand is part of the canonical input, hence of the idempotency digest. A request key recorded without it (every write before this packet, and any caller that sends none) replays for a bound retry only when the record it wrote is in the named company; otherwise the retry is refused as claim 2. A key recorded with a company is bound to it: another company, or none, is `SEMANTIC_OPERATION_IDEMPOTENCY_CONFLICT`.
5. The web runtime sends the page's company on every company-owned record write it issues: the record form and lifecycle actions (`operationInput`), record transitions, Task steps (fixed with the step's input, so a retry replays the same binding) and the document editor's persisted header and lines. Ownership is read from the write's compiled read-back (`operationBindsRecordLegalEntity`). A company-owned write entered in no single company is refused before invocation (`OPERATION_INPUT_INVALID`); a tenant-level write carries no company.
6. The refusal reads "Record belongs to another company … Nothing was changed." (`OPERATION_LEGAL_ENTITY_MISMATCH`, catalog 50 -> 51), naming neither company.

## Decisions

- The binding rides the input (not a new envelope field), as the brief asked: it is then in the policy decision input and the digest by construction, and no request schema version moves.
- Optional, not required, at the provider: API, agent, import and release-verification callers send no company and keep their behaviour; the web, the one caller that enters a company, always sends it. Requiring it would break every unbound caller without a channel that names the company.
- The comparison sits after the parent guards, not at the top of `prepareMutation`: every writer already locks parent then record, and locking the record first would invert that order against a transaction holding the parent.
- Legacy receipts: the provider reads the key's recorded digest first (receipts are never updated or deleted, migration 0009's rules) and, only when it equals the digest of the same input without the operand, checks the persisted company and replays under that digest. No trust contract changes.
- Ownership from the read-back: the pinned view carries no storage, and in the composed release every non-create record write's read-back is scoped exactly when its entity is company-owned (measured: 98 writes, 0 exceptions). A future mismatch fails visibly (claim 2's UNSUPPORTED), never silently.
- Bulk actions on Lists issue no write today (the bulk bar is selection only), so none is bound.

## Gates

- (filled at freeze)

## Test it yourself

1. `NORTH_STAR_TEST_LOCK_TIMEOUT_SECONDS=3600 node scripts/run-with-test-lock.mjs exclusive -- node --import tsx --test test/postgres/company-bound-writes.test.ts` — 7 subtests pass (about 2 minutes): B's record refused through A's page and unchanged; A's own edit saves; archive and restore bound; a party edit unaffected; the in-flight move judged under lock; old request keys replay only in their company; a company-A operator writes A only.
2. In the app (`node --import tsx test/helpers/order-entry-fixture.ts --serve`, open the printed URL): Inventory → Stock counts → New, fill it and Save, then change Number and Save. Expect "Update complete" with the new number. Open a Party, edit Contact summary, Save: "Update complete" (a tenant-level record, unchanged behaviour).
3. Edit a sales order draft (Sales → Sales orders → an order → Record actions → Edit → change a quantity → Save draft): it saves as before; its header and lines are now written bound to the order's company.

## Filed

- Registered capability commands (post, release, reserve and others) authorize the persisted company their adapter reads but do not compare it with the page's company; each adapter would need its own operand. Not a generic write, so outside this brief.
- `operationBindsRecordLegalEntity` infers ownership from the read-back query; an explicit ownership flag in the operation catalog would need a compiler profile version.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "COMPANY-BOUND-WRITES",
  "base": "8c8cfab1c54ac1b51b4617e45f8e2f0ddd1dfa1b",
  "head": "198242aa917f3a6bb90457b4e8df2303edb24eb5",
  "changedPaths": [
    "apps/web/src/document-editor.ts", "apps/web/src/gateway-error-codes.ts", "apps/web/src/message-catalog.ts",
    "apps/web/src/surface-composition.ts", "apps/web/src/surface-runtime.ts", "apps/web/test/browser/composed-application.spec.ts",
    "apps/web/test/browser/message-catalog.spec.ts", "apps/web/test/surface-runtime-contract.test.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/postgres-provider/src/trust/postgres-trust-service.ts",
    "packages/runtime/src/semantic-operation-gateway.ts", "test/evidence/COMPANY-BOUND-WRITES.expected-red.json",
    "test/integration/surface-data-binding.test.ts", "test/postgres/company-bound-writes.test.ts"
  ],
  "symbols": [
    {"path": "apps/web/src/surface-runtime.ts", "name": "recordLegalEntityBinding"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "optionalLegalEntityBinding"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "requireRecordLegalEntityBinding"},
    {"path": "packages/runtime/src/semantic-operation-gateway.ts", "name": "RECORD_LEGAL_ENTITY_BINDING_ARGUMENT_KEY"},
    {"path": "packages/runtime/src/semantic-operation-gateway.ts", "name": "admittedOperationArgumentKeys"},
    {"path": "packages/runtime/src/semantic-operation-gateway.ts", "name": "operationBindsRecordLegalEntity"},
    {"path": "packages/runtime/src/semantic-operation-gateway.ts", "name": "unboundRecordInputDigest"}
  ]
}
```

Review: not owed — outside the Critical set.
