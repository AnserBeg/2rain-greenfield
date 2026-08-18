# scoped-create-operand-impl — permission-authorized legal-entity create operand

Date: 2026-08-18
Base: `22154a7db5f0c25d13fe33d133207bce6af63b12` (`origin/main`, verified before cut)
Branch: `packet/scoped-create-operand-impl`
Tier: Critical
Status: active; implementation and mutation evidence complete, prescribed gates
and manual checkpoint pending

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
  column/value and a row lock. It emits
  `MODULE_LEGAL_ENTITY_CREATE_INACTIVE` with the legal-entity id as subject.
- The web message boundary preserves that subject as
  `OPERATION_LEGAL_ENTITY_INACTIVE`; it does not add another instance of the
  existing unnamed-provider-refusal defect.

No compiler output, application release or canonical language changed.
`packages/postgres-provider/src/composed-application-runtime.ts` was not used;
the allow-all local policy remains an honest fact and the invariant sits in the
generic provider.

## Controls and committed mutation evidence

`test/integration/scoped-create-operand-mutations.mjs` is registered as
`test:scoped-create-operand-mutations`. It requires a clean tracked tree,
replaces one unique production victim, runs the named control in a fresh
process, verifies the expected red text, and restores the exact source in
`finally`. All eight mutations were executed one at a time:

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
  status becomes active; and
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

The pre-authorized test-registration bridge added one root package script for
the committed mutation runner. No policy-seam bridge was taken.

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

The managed dev container stopped cleanly after the observation. Final
prescribed gates remain pending. No full matrix is run before external review.
Review is executed by the user in a separate online seat, never by this writer
lane.
