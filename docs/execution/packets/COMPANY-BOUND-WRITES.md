# COMPANY-BOUND-WRITES — a write naming an existing company-owned record acts only in the company its page was entered in

Status: executable on draft PR against `packet/INTEGRATION`; no merge, no deployment. Sole local author on `packet/COMPANY-BOUND-WRITES`. Fixes RETURNABLE-ASSETS round 1 finding F4 (P2, inherited shared runtime).
Tier: outside the Critical set — the web runtime, the semantic operation gateway and the generic interpreter (`module-runtime-interpreter.ts`, not the posting kernel). No change to `postgres-provider/src/trust/` or `platform-runtime/src/trust/`, the posting kernel, the serializer, the materializer, activation, release verification, migrations, RLS or grants. No compiled output, authored definition or release lineage changes. Stops taken: none.
Base: `origin/packet/INTEGRATION` at `8c8cfab1`.

## The defect (reproduced first)

A tenant-wide operator posted company B's stock count id and current revision through the stock count form entered in company A. At the base (`8c8cfab1` in a detached worktree, only `test/postgres/company-bound-writes.test.ts` added) the write committed: subtest `"an edit posted through a page entered in A does not change B's record"` failed with B's stored row moved from `number: 'EDIT-B', revision: '1'` to `number: 'MOVED-BY-A', revision: '2'`, company still B. Archive through A also archived B's record (`"archiving B's record through A's page must be refused"`). The base refused every operand-carrying write as `MODULE_INPUT_MALFORMED` (an unknown key), and its lock subtest leaked an open transaction that confounded the last subtest (fixed in `198242aa`).

## Claims

1. Update, archive, restore and transition (every generic write that names an existing record) admit an optional `legalEntityId` operand, through one list (`admittedOperationArgumentKeys`) that both the gateway's closed-key fence and the provider's parser use. Capability commands and creates are unchanged.
2. When it is present, the provider reads the record's company from the persisted row, `FOR NO KEY UPDATE`, in the write's transaction, after the parent guards and before the writer (`requireRecordLegalEntityBinding`), so the writer's revision compare-and-increment runs under the same lock. A different company refuses `MODULE_LEGAL_ENTITY_BINDING_MISMATCH` and writes nothing; a company on a tenant-level record refuses `MODULE_LEGAL_ENTITY_BINDING_UNSUPPORTED` and writes nothing.
3. The operand is the key a scoped create carries, so current policy authorizes it the same way: a principal granted only company A may now write A's records through a bound write (before, any generic update needed a tenant-wide grant), cannot reach B's through it (claim 2), and is denied naming B. An unbound write still needs the tenant-wide grant.
4. The operand is part of the canonical input, hence of the idempotency digest. A request key recorded without it (every write before this packet, and any caller that sends none) replays for a bound retry only when the record it wrote is in the named company; otherwise the retry is refused as claim 2. A key recorded with a company is bound to it: another company, or none, is `SEMANTIC_OPERATION_IDEMPOTENCY_CONFLICT`. The trust service's public API is unchanged.
5. The web runtime sends the page's company on every company-owned record write it issues: the record form and lifecycle actions (`operationInput`), record transitions, Task steps (fixed with the step's input, so a retry replays the same binding) and the document editor's persisted header and lines. Ownership is read from the write's compiled read-back (`operationBindsRecordLegalEntity`). A company-owned write entered in no single company is refused before invocation (`OPERATION_INPUT_INVALID`); a tenant-level write carries no company.
6. The refusal reads "Record belongs to another company … Nothing was changed." (`OPERATION_LEGAL_ENTITY_MISMATCH`, catalog 50 -> 51), naming neither company.

## Decisions

- The binding rides the input (not a new envelope field), as the brief asked: it is then in the policy decision input and the digest by construction, and no request schema version moves.
- Optional, not required, at the provider: API, agent, import and release-verification callers send no company and keep their behaviour; the web, the one caller that enters a company, always sends it. Requiring it would break every unbound caller without a channel that names the company.
- The comparison sits after the parent guards, not at the top of `prepareMutation`: every writer already locks parent then record, and locking the record first would invert that order against a transaction holding the parent.
- Legacy receipts (`#replayUnboundReceipt`): only when a bound write's key meets the trust service's idempotency conflict is the key presented once more with the digest of the same input without the operand. The trust service replays that receipt or refuses again (the first conflict then stands); a replay is returned only when the persisted record is in the named company. The second attempt's mutation refuses, so neither attempt writes (a conflicting key holds a receipt, and receipts are never updated or deleted, migration 0009). No trust contract or trust service change, and no extra transaction on a write that does not conflict.
- CI at `39c74f15` (run 37481071482) was red three ways, each fixed at its cause in `b434e740`. (a) `trust-substrate` pins `PostgresTrustService`'s public methods (Freeze E: no seam beyond the accepted and non-accepted writers); the packet's read-only `recordedIdempotencyInputDigest` widened it. The recorded facts never changed, the API did, so the expectation stands and the accessor is gone. (b) The period-lock Task's writes now carry the page's company: the lock is company-owned, so the expectation moved to the input the fix intends (`legalEntityId: scope`). (c) A gateway comment used `storage`, a word the owned-gateway seam guard bans; reworded.
- Ownership from the read-back: the pinned view carries no storage, and in the composed release every non-create record write's read-back is scoped exactly when its entity is company-owned (measured: 98 writes, 0 exceptions). A future mismatch fails visibly (claim 2's UNSUPPORTED), never silently.
- Bulk actions on Lists issue no write today (the bulk bar is selection only), so none is bound.

## Gates

- CI green at `aa7bd490`: https://github.com/AnserBeg/2rain-greenfield/actions/runs/38490789087 — unit 247, compiler 175, integration 258, agent 3, architecture and hygiene 200, web contracts 46; PostgreSQL schema and isolation 167 (+1 locale probe; `company-bound-writes` 7/7 among them), composed 24, commercial 21, inventory 83; browser 87, composed browser 23, operations 9, inventory browser 11; executed-file reachability green.
- Earlier reds: `39c74f15` (run 37481071482), see Decisions; `b246280a` (run 38488244768) one left, the hygiene gate's reviewed PostgreSQL inventory did not name the new test, which the suite's glob already ran (registered in `aa7bd490`).
- Expected-red controls on CI: https://github.com/AnserBeg/2rain-greenfield/actions/runs/38490789074 (evidence.yml, head aa7bd49018b5d6441beaac06821bdc8dcc998c28)
  - `company-binding-comparison-dropped` at aa7bd49018b5: killed with the declared reason (5 declared kill(s) failed as declared) and restored green (8 passing).
  - `company-binding-compares-the-operand` at aa7bd49018b5: killed with the declared reason (5 declared kill(s) failed as declared) and restored green (8 passing).
  - `company-binding-read-without-lock` at aa7bd49018b5: killed with the declared reason (1 declared kill(s) failed as declared) and restored green (8 passing).
  - `company-binding-unbound-replay-unchecked` at aa7bd49018b5: killed with the declared reason (1 declared kill(s) failed as declared) and restored green (8 passing).
  - `company-binding-unbound-replay-removed` at aa7bd49018b5: killed with the declared reason (1 declared kill(s) failed as declared) and restored green (8 passing).
  - `company-binding-on-tenant-record-admitted` at aa7bd49018b5: killed with the declared reason (1 declared kill(s) failed as declared) and restored green (8 passing).
  - `company-binding-web-update-unbound` at aa7bd49018b5: killed with the declared reason (1 declared kill(s) failed as declared) and restored green (1 passing).
- Local (no container run: Windows free memory 640 MB): typecheck, lint, format; `semantic-gateways` 52/52; the period-lock and company-bound integration tests 2/2; `repository-hygiene` 11/11; agent 3/3; web contracts 46/46; app and demo release freshness; language coverage.

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
  "head": "aa7bd49018b5d6441beaac06821bdc8dcc998c28",
  "changedPaths": [
    "apps/web/src/document-editor.ts", "apps/web/src/gateway-error-codes.ts", "apps/web/src/message-catalog.ts",
    "apps/web/src/surface-composition.ts", "apps/web/src/surface-runtime.ts", "apps/web/test/browser/composed-application.spec.ts",
    "apps/web/test/browser/message-catalog.spec.ts", "apps/web/test/surface-runtime-contract.test.ts",
    "packages/postgres-provider/src/module-runtime-interpreter.ts", "packages/runtime/src/semantic-operation-gateway.ts",
    "test/evidence/COMPANY-BOUND-WRITES.expected-red.json", "test/integration/surface-data-binding.test.ts",
    "test/architecture/repository-hygiene.test.ts", "test/postgres/company-bound-writes.test.ts"
  ],
  "symbols": [
    {"path": "apps/web/src/surface-runtime.ts", "name": "recordLegalEntityBinding"},
    {"path": "packages/postgres-provider/src/module-runtime-interpreter.ts", "name": "isIdempotencyConflict"},
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
