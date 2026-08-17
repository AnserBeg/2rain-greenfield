# scoped-create-operand — legal-entity create scope design pass

Status: evidence ready; external review pending; preserved probe, never merge

Tier: Critical

Lane: writer/design

Branch: `packet/scoped-create-operand`

Base: `5546d6c3ccca60b9cabfea0e9d6bebe2b0e3c18b`

Probe commit: `7fbe0f0`

## Ruling

[ADR-0054](../../decisions/ADR-0054-legal-entity-create-scope-is-gateway-issued.md)
rules that legal-entity identity for a generic create is selected by the
request, validated and authorized by the semantic operation gateway, and added
only to the effective execution input. It is not an authored field, caller
argument, default, or module branch.

The existing compiler-derived `systemInput` is enough to declare the storage
binding, so no canonical-language change is required. Literal reuse of Q1-P5's
canonical query syntax does not work: the strict operation schema has no
`parameters` or `legalEntityScope` member and refuses both. The read-side
symmetry is a semantic rule, not a syntax transplant.

## First-thirty-minute determination

This remained a design pass.

It was not the mechanical packet “copy Q1-P5's operand onto create contracts.”
That copy requires a canonical version cut, which is an explicit stop condition.
The measured alternative exposed a real fork that needed a ruling:

- preserve `5g3-write-scope`'s direct caller-supplied `legalEntityId`; or
- make `classification: 'INTERNAL'` enforceable and let the gateway derive the
  effective value from separately carried request scope.

ADR-0054 chooses the second route. The direct-call behavior on current `main`
also corrects one claim in the packet premise: direct semantic invocation is
constructible today when the caller supplies `legalEntityId`; the generic web
path is not.

## Scope and ownership

The preserved probe owns only:

- `packages/runtime/src/semantic-operation-gateway.ts`
- `apps/web/src/surface-runtime.ts`
- `test/integration/module-runtime.test.ts`
- `test/integration/surface-data-binding.test.ts`
- `docs/decisions/ADR-0054-legal-entity-create-scope-is-gateway-issued.md`
- this packet record

It did not touch `docs/execution/current-plan.md`, `lanes.md`, compiler output,
the PostgreSQL interpreter, `release-verification-service.ts`, Inventory
definitions, or the live `inventory-form-anatomy` packet.

## Evidence reconstructed from disk

### The structural gap

- `packages/compiler/src/storage.ts` derives the non-null entity-owned
  `legalEntity` descriptor outside canonical entity columns and separately adds
  `legal_entity_id` to entity-scoped relation storage.
- `packages/compiler/src/projections.ts` derives a create-only
  `systemInput` whose physical column is `legal_entity_id` and includes its key
  in the effective input contract.
- `packages/postgres-provider/src/module-runtime-interpreter.ts` requires that
  input, checks it against storage metadata, and supplies it to the generic
  insert.
- `apps/web/src/surface-runtime.ts` previously built create input from only
  `recordId`, `relations`, and `values`, despite already reading the selected
  legal entity from the scoped query URL.

### The Q1-P5 precedent

The actual Q1-P5 diff and ADR-0031 show that the caller supplies an untrusted
declared query argument. The query gateway evaluates its canonical cardinality,
obtains live per-member policy decisions, and issues the sealed capability. The
important symmetry is “selection is not authority,” not “the client supplies no
UUID.”

The current canonical operation definition is a strict object without query
parameters or a scope member. A literal operation-side `legalEntityScope`
therefore fails at canonical parsing. The runtime operation request is also
closed to five top-level keys, and its current web adapter has no scope carrier.

### Probe outcome

Commit `7fbe0f0` demonstrates the route without changing those canonical
contracts:

- the web adapter passes the form query's URL selection in operation execution
  context;
- the gateway recognizes the compiler-derived internal descriptor and applies
  the existing exactly-one scope kernel;
- operation policy, confirmation comparison, the input digest, and the generic
  executor receive the same effective internal value;
- omitted, multiple, directly injected, and undeclared scope values refuse
  before execution; and
- changing only the scope changes the digest.

The web control uses a synthetic scoped form binding. An attempted control over
the actual Inventory form on this base returned its pre-existing
`OPERATION_UNSUPPORTED` before invocation. Changing its surface anatomy would
have invaded the live `inventory-form-anatomy` lane, so that variant was
discarded and is not presented as probe evidence.

Four isolated mutations were applied one at a time in a disposable detached
worktree at the frozen SHA, then removed. Each produced the expected red for its
own victim:

| Victim removed | Observed red |
| --- | --- |
| web URL-selection handoff | scoped-form probe received 422 instead of 200 |
| direct-internal-input refusal | `Missing expected rejection` at the direct `legalEntityId` case |
| unscoped-operation refusal | `Missing expected rejection` at the admission twin |
| effective-input digest | the two different legal entities produced the same digest |

Omission and exactly-one array refusal use Q1-P5's accepted canonical kernel;
that packet already records the per-cardinality mutation reds. This probe reads
the exact refusal reasons and independently holds the executor count at its
pre-refusal value.

## Gate evidence

- `corepack pnpm typecheck`: PASS.
- `corepack pnpm lint`: PASS.
- `corepack pnpm format`: PASS.
- `node --import tsx --test test/integration/module-runtime.test.ts test/integration/surface-data-binding.test.ts`:
  PASS, 37 tests, including both named `probe:` controls.
- The first raw test command in the fresh worktree did not collect because
  dependencies were not linked (`ERR_MODULE_NOT_FOUND: tsx`).
  `corepack pnpm install --offline --frozen-lockfile` reused the lockfile store;
  the exact command then passed. This was environment setup, not a product red.
- `bash scripts/check-parked-work.sh`: expected FAIL. It reports the six
  pre-existing stale branches `packet/proj-disc`, `packet/ps-0`, `packet/ps-1`,
  `packet/ps-2`, `packet/pur-1`, and `packet/u5-design`. This preserved probe is
  listed at age 0 and is not marked stale. No branch was changed.
- Full matrix: NOT RUN, by charter. This branch has no integrated SHA and the
  preserved-probe doctrine says it owes no matrix.
- Integration: NOT RUN and not applicable. This branch must never merge.

## Probe limits

- It stops at the real generic executor port. The prior accepted PostgreSQL
  evidence proves that the derived system input populates `legal_entity_id`;
  the implementation packet must compose both facts in one persisted web
  control.
- It intentionally breaks current internal callers that directly place
  `legalEntityId` in operation input. Those callers are migration targets, not
  compatibility evidence.
- It does not make a human-required scoped create constructible. Such a path
  must mint and verify its confirmation grant against the same effective input
  or refuse.
- It does not define an API wire spelling. An adapter without a separate scope
  carrier must refuse entity-owned create rather than re-admit the direct key.

## Recommended implementation packet

Name: `scoped-create-operand-impl`

Tier: **Critical**, because the change controls legal-entity write attribution,
policy input, confirmation binding, and idempotency identity.

Owned paths:

- `packages/runtime/src/semantic-operation-gateway.ts`
- `packages/runtime/src/semantic-gateway-api-adapters.ts`
- `apps/web/src/surface-runtime.ts`
- `packages/postgres-provider/src/release-verification-service.ts`
- `test/integration/module-runtime.test.ts`
- `test/integration/semantic-gateways.test.ts`
- `test/integration/surface-data-binding.test.ts`
- `test/postgres/composed-application.test.ts`
- `apps/web/test/browser/composed-application.spec.ts`
- its packet record and the accepted ADR-0054 copy

The PostgreSQL interpreter and compiler are not expected owned paths. Needing
either is a stop-and-bridge request because it changes the measured design or
compiler output. Updating release verification means only migrating its exact
arranged legal entity from direct input to execution scope; it must not absorb
`5g3-mount`'s verification derivation mapping.

Required controls:

1. One real scoped web create persists the selected UUID in the exact
   `legal_entity_id` column and reads it independently.
2. Omitted, array/multiple, malformed, and uppercase/noncanonical selections
   each refuse with no row and no executor call.
3. A direct `input.legalEntityId` refuses even when it matches the selected
   scope; the admission twin succeeds through separate context.
4. A tenant-shared create is unchanged and refuses supplied scope; an
   entity-owned create cannot execute without it.
5. The registered operation policy sees the exact effective UUID. Policy DENY
   produces no execution or persistence.
6. Changing only the UUID changes the input digest, conflicts under one
   idempotency key, and makes a confirmation grant stale. If scoped
   human-required create remains unsupported, a negative control proves the
   typed refusal.
7. Release verification uses only an entity it arranged and preserves the
   existing exact verification partition. It supplies no direct internal key.
8. The API adapter either carries separate request scope end to end or returns
   a typed refusal; it never reintroduces the internal key on the caller wire.
9. No module id or Inventory family name appears in the mechanism, and no
   compiler/release bytes move.
10. Every vacuity vector has a recorded red: subject absent, zero executor
    calls, proxy-only input, unknown parser shape, and scope repaired before
    measurement.

Required acceptance gates for the implementation packet include the full CI
matrix at its reviewed integrated tree, including `test:postgres` because the
change reaches a persisted provider output. That later obligation is not a gate
of this preserved design probe.

## Checkpoint

The program-review triggers were evaluated. No review is due: this is an
unintegrated preserved design probe, so the clean-integrated-tree anti-trigger
applies; it creates no stage boundary, stabilized correctness domain, or
fan-out. The ADR's separate external Critical arm remains required.

Test it yourself by reading ADR-0054 section **“Preserved probe and evidence”**
and checking the targeted probe output recorded above: `pass 37`, `fail 0`,
with these two named subtests:

- `probe: scoped create converts a request selection into INTERNAL input and refuses vacuity`
- `probe: a scoped form create carries URL scope as gateway INTERNAL input`

The next action is the user-run external Critical review. This packet does not
integrate and does not continue into `scoped-create-operand-impl` autonomously.
