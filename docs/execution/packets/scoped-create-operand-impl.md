# scoped-create-operand-impl — permission-authorized legal-entity create operand

Date: 2026-08-18
Base: `22154a7db5cdae739cacaae2ea46771d805b20cf` (`origin/main`, verified before cut)
Branch: `packet/scoped-create-operand-impl`
Tier: Critical
Status: evidence-ready matrix-bridge revision; round 2 passed both external
Critical arms at `ad7c6b8`, then the first full matrix found an unleased,
unregistered manual mutation entrypoint; executable correction `2c747ed` passed
both fresh narrow arms at identical candidate `ae6df65`; full matrix rerun owed

## Packet definition

Goal: let a person create a legal-entity-scoped record from a web surface while
honouring ADR-0015's prohibition on new work for archived legal entities.

The ruling is [ADR-0055](../../decisions/ADR-0055-legal-entity-create-scope-is-a-permission-authorized-operand.md).
The lease was recorded in `lanes.md` in first commit `a32bb19`. No compiler path
was taken. The preserved branch `packet/scoped-create-operand` at `32031b4` was
read as diagnosis and probe evidence only and is never merged.

## Reconstructed diagnosis

The prompt's two defect halves are confirmed on current disk:

1. `operationInput` omitted the selected legal entity although the compiled
   create contract already named `legalEntityId` as required system input and a
   closed argument. The independent browser journey on the base recorded a
   scoped provider refusal beside an otherwise equivalent unscoped success.
2. UUID shape and the foreign key did not enforce ADR-0015:100. The accepted
   legal-entity master descriptor already carried `fieldColumns.status` and
   `activeStatusValue`; the generic interpreter had the needed storage facts and
   did not consult them.

The preserved design probe's ruling was not adopted. A Q1-P5 read scope is
sealed by private runtime object identity. A plain
`SemanticOperationExecutionRequest` is copyable and can be handed to the public
internal executor. The implementation therefore calls `legalEntityId` an
untrusted permission-authorized operand and makes no issuance or capability
claim.

## Implementation

- `readCompiledSurfaceDataBinding` carries only the selected operation
  contract's system-input argument key. The web runtime derives no key from a
  module or entity name.
- The rendered form action preserves the compiled URL scope across the click.
  Create input requires exactly one selection for a declared system input and
  refuses scope on an unscoped create.
- The existing semantic gateway receives one complete input. Its registered
  operation permission, confirmation comparison, digest and executor request
  therefore all see the same operand.
- `PostgresModuleRuntimeInterpreter` checks active ownership inside the same
  accepted-mutation transaction as insertion, using the compiled master status
  column/value, the independent compiler-derived generic archive column and one
  row lock. It emits
  `MODULE_LEGAL_ENTITY_CREATE_INACTIVE` with the legal-entity id as subject.
- The web message boundary preserves that subject as
  `OPERATION_LEGAL_ENTITY_INACTIVE`; it does not add another instance of the
  existing unnamed-provider-refusal defect.

No compiler output, application release or canonical language changed.
`packages/postgres-provider/src/composed-application-runtime.ts` was not used;
the allow-all local policy remains an honest fact and the invariant sits in the
generic provider.

## Controls and committed mutation evidence

`test/integration/scoped-create-operand-mutations.mjs` is registered as the
manual `evidence:scoped-create-operand-mutations` entrypoint. The complete
harness runs under an exclusive repository test lock because three mutations
execute the PostgreSQL composed-application control; it is evidence that
expects red tests, not a CI `test:*` suite. It requires a clean tracked tree,
replaces one unique production victim, runs the named control in a fresh
process, verifies the expected red text, and restores the exact source in
`finally`. One uninterrupted invocation against gated tree `fe7d514` executed
all nine mutations one at a time and restored a clean tracked tree:

| Production victim | Admission/refusal discriminator | Observed red |
|---|---|---|
| form action drops its link context | rendered action must retain compiled scope | `MUTATION_RED rendered-form-action-drops-url-scope` |
| web handoff hardcodes the first UUID | two different URL selections reach policy/executor and disjoint scoped reads | `MUTATION_RED web-handoff-hardcodes-one-legal-entity` |
| exactly-one check removed | omission/multiplicity refuse beside two admitted values | `MUTATION_RED scoped-cardinality-refusal-removed` |
| registered operation denial removed | boundary permission allows while only create permission denies | `MUTATION_RED registered-operation-permission-refusal-removed` |
| provider subject erased at web boundary | exact inactive diagnostic and subject | `MUTATION_RED provider-refusal-subject-erased` |
| effective-input digest collapsed | same key and changed legal entity must conflict; exact replay is stable | `MUTATION_RED effective-input-digest-collapsed` |
| unscoped create closed-key fence removed | supplied operand refuses beside no-operand admission twin | `MUTATION_RED unscoped-create-closed-key-fence-removed` |
| transactional active-owner check removed | identical request refuses while inactive, then succeeds after only master status returns active | `MUTATION_RED active-legal-entity-enforcement-removed` |
| generic archive comparison removed while status check remains | registered archive-first create and post-archive create refuse beside a create-first admission | `MUTATION_RED archived-legal-entity-predicate-removed` |

The first permission control was initially vacuous: a blanket-deny policy let
the earlier semantic-boundary permission hide deletion of the registered
operation permission. The mutation stayed green, so the control was corrected
to allow the boundary and deny only the compiled create permission. The first
archived mutation also found a wrong red: the inactive attempt reused an active
specimen's unique transaction number. The control now retries an identical,
otherwise unused request across the status change; the corrected mutation reds
only because the inactive refusal is absent. Both failures are retained here
because they are evidence that the harness discriminates its subject rather
than accepting any nonzero exit.

External review round 1 at `08adef83a2be501918bf08704c5c479aae4b498c`
returned REVISE. It found the cheapest surviving broken tree the author-selected
mutations missed: keep the whole owner check and its business-status comparison,
but ignore the independent generic archive marker changed by
`legal_entity_archive`. The correction subsumes that finding by reading both
compiler-derived lifecycle facts from the same locked row. The new mutation
removes only the archive comparison; the status check remains intact.

External Codex xhigh round 2 and the independent Fable max confirmation both
returned PASS on identical candidate
`ad7c6b8c6ac1e601bd1d93f09b5e89cefc13c984`. The first arm closed D-F with no
new material defect; only the Codex arm supplied detailed findings. The later
matrix bridge changes no product logic, ADR ruling, PostgreSQL specimen or
mutation victim. Fresh Codex and Fable confirmation arms both returned PASS on
identical bridge candidate `ae6df65e785868792d2b71be86e4ce8ae0c189bf`:
the `evidence:*` classification is honest, the exclusive lease spans the whole
harness and its children, the victim tests remain CI-reachable through their
ordinary suites, and all three architecture failures close without weakening
their assertions. A-E CLOSED with no material finding.

## Direct generic execution — observed and accepted

The real PostgreSQL `v3 inventory reads require issued legal-entity scope and
preserve generic operations` specimen now creates through the gateway, captures
the exact executor request, and then:

1. replays that request directly through the interpreter; and
2. constructs a fresh direct request with a fresh record/idempotency identity
   and the same untrusted legal-entity operand.

Both succeed and both independently persist the selected `legal_entity_id`.
This is the most important negative capability claim in the packet: the write
operand is not sealed and the provider cannot infer issuance. It is correct
under ADR-0055, not hidden as a limitation.

## Evidence classification

Observed by this packet:

- two different web URL values reach the contract-declared argument key and the
  exact registered permission input;
- omission, multiplicity, permission denial and unscoped scope refuse before
  execution beside their admission twins;
- the rendered form action retains scope across GET to POST;
- the selected legal entity is independently read from persisted PostgreSQL
  rows, including direct-executor creates;
- changing only the legal-entity operand under one idempotency key conflicts;
- the exact inactive request leaves no row and succeeds after the same master
  status becomes active;
- the human-confirmed registered legal-entity archive and a scoped create were
  queued behind the same row lock in both orders: archive-first refuses the
  waiting create with no business row or receipt, while create-first succeeds,
  the archive follows, and every later create refuses; and
- the provider refusal subject survives the web message boundary.

Inherited premises, not newly proven in isolation:

- Q1-P5's read-scope object identity remains the accepted seal for reads; this
  packet reads that mechanism only to reject the analogy for writes.
- ADR-0031's distinction between caller operands and storage derivation remains
  authoritative; this packet uses the already-compiled system-input descriptor.
- The generic semantic gateway's existing confirmation mechanism binds the
  complete input. The live scoped create declares `confirmation: none`, so no
  human-confirmation journey is claimed.

## Bridges and limits

Two pre-authorized test bridges were used: one root package script registers the
committed mutation runner, and the web contract census advanced from 29 to 30
when the new subject-bearing message code was added. The first contracts run
reported that exact stale count; no semantic assertion was weakened. No
policy-seam bridge was taken.

Valid future work, not packet defects:

- required-relation picker rendering and same-scope enumeration;
- API wire spelling and a scoped human-confirmation carrier;
- dev Inventory seed data;
- release-verification derivation mapping; and
- a separately ruled sealed write-scope receipt if the threat model changes.

The packet does not claim those routes. It does claim the web
`inventory_transaction_form` create with no required relation.

## Gate and checkpoint record

The manual checkpoint ran against `pnpm dev` at
`http://127.0.0.1:4174`. A headless browser drove the same native controls a
person uses:

1. open Inventory → Transactions → New under the default legal entity;
2. fill transaction number `MANUAL-SCOPE-20260818`, type `adjustment`, state
   `draft`, source, timestamps and actor;
3. click **Save**; and
4. open the independently scoped Inventory Transaction list.

Observed output:

```json
{
  "action": "/?surface=northstar.app%3Asurface.inventory_transaction_form&northstar.app%3Aparameter.inventory_transaction_get_legal_entity_scope=74000000-0000-4000-8000-000000000001",
  "click": "Save",
  "listObserved": "MANUAL-SCOPE-20260818",
  "status": "Create complete. The saved record is reflected below and its trust evidence is linked."
}
```

The managed dev container stopped cleanly after the observation.

The exact gated tree `fe7d5146ecb09f461cae42c7615a52eaf2208712`
passed the prescribed sequence. Its latest executable commit is
`a7154234253fdc98654e8271def58e950b78d2d2`; the intervening `fe7d514` commit
changes only ADR prose:

- `pnpm typecheck`, `pnpm lint`, `pnpm format` — pass;
- `pnpm test:postgres` — 203 passed, 0 failed;
- `pnpm test:browser` — 90 passed, 0 failed;
- `pnpm test:integration` — 140 passed, 0 failed; and
- `pnpm test:contracts` — 16 passed, 0 failed.

The first full matrix ran against exact reviewed candidate `ad7c6b8` after both
Critical arms passed. Its performance gate passed, then `test:architecture`
reported 138 passed and 3 failed before later matrix suites or the online
security tail ran:

- the `test:scoped-create-operand-mutations` root command acquired no repository
  lock;
- lock derivation therefore observed undefined rather than shared access; and
- CI reachability found that root `test:*` entrypoint neither invoked nor
  explicitly justified.

All three were one registration defect. Executable correction
`2c747edfbf351fb907c42d5d22cca5d963c59d19` renames the command to the manual
`evidence:*` namespace and places the complete mutation harness under an
exclusive lock. This is evidence that intentionally mutates tracked production
files and expects red tests, so it does not claim CI suite or reachability
status. On that corrected tree, `pnpm typecheck`, `pnpm lint`, `pnpm format` and
`pnpm test:architecture` pass; architecture reports 141 passed and 0 failed.
The failed matrix token is retained exactly:

```text
FULL_MATRIX_FAILED rc=1 sha=ad7c6b8c6ac1e601bd1d93f09b5e89cefc13c984
```

Fresh Codex and Fable narrow reviews both passed identical candidate `ae6df65`.
The full matrix rerun is now the remaining acceptance gate. Review was executed
by the user in separate online seats, never by this writer lane.

The program-review trigger is not run at this freeze because the application is
not yet cleanly integrated, which is an explicit anti-trigger. Re-evaluate it
immediately after acceptance and integration: this packet establishes the first
user-visible legal-entity-scoped write immediately before relation and PUR
fan-out, so the first-end-to-end-slice trigger is likely due then.
