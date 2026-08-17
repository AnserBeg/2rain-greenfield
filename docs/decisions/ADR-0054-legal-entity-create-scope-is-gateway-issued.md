# ADR-0054: Legal-entity create scope is gateway-issued, not an authored input

Date: 2026-08-17
Status: proposed by packet `scoped-create-operand`; ratification requires the
pending external review arm
Tier: Critical (the ruling determines write attribution and authorization)

## Context

An entity-owned storage target has a required physical `legal_entity_id`
column. The compiler emits that fact as a `legalEntity` storage descriptor with
`familyClassification: 'entityOwned'`, `immutableAfterCreate: true`, and
`nullable: false`. It is deliberately outside the entity's authored columns.
An author therefore cannot add it to a form as an ordinary business field.

The accepted `5g3-write-scope` implementation added a compiler-derived
`systemInput` to create operation contracts. The PostgreSQL interpreter requires
its `legalEntityId`, cross-checks it against the storage descriptor, and inserts
it into `legal_entity_id`. That made a direct semantic-operation invocation
constructible when its caller supplies `input.legalEntityId`; it did not make a
generic web form constructible. `operationInput` in the web runtime builds only
`recordId`, `relations`, and `values` for create, while the operation gateway
passes the caller input through unchanged.

The original statement that the entity is wholly non-constructible is therefore
too broad on current `main`: a direct caller can construct it by supplying the
derived key. The product-path statement remains true. The generic web press has
no authored control and supplies no system input, so the observed PostgreSQL
failure remains `23502`, null `legal_entity_id`, for that path.

Q1-P5 solved the read-side problem with canonical `legalEntityScope` on queries.
Its exact mechanism matters:

1. the caller supplies an untrusted UUID or UUID set as an ordinary declared
   query argument;
2. the gateway evaluates that selection against the declared cardinality;
3. live policy authorizes each member; and
4. only then does the gateway issue a sealed read-scope capability to the
   executor.

Thus “gateway-issued” does not mean the caller never selects a company. It means
the caller's selection is not itself authority and never reaches storage as an
ordinary filter or trusted value.

## Decision

### 1. Reuse Q1's rule, not Q1's canonical spelling

A legal-entity-owned create obtains `legal_entity_id` from an untrusted request
selection that the semantic operation gateway validates and authorizes. The
caller does not author, default, or directly supply the physical value.

The operation gateway consumes the selection at `exactlyOne` cardinality using
the existing canonical legal-entity-scope kernel. Omission, an array, malformed
identity, or more than one identity is a typed refusal before an executor runs.
A create can belong to exactly one legal entity; `nonEmptySet` has no create
meaning.

The query shape is not copied onto `operationDefinition`. The current canonical
operation schema is a strict object with no `parameters` or
`legalEntityScope` member. Adding either member to the released language would
require a new canonical version. This ruling does not require that version cut.

### 2. The derived system input is the create-scope declaration

The compiler-derived operation `systemInput` remains the declaration that the
selected create targets entity-owned storage. Its exact descriptor binds the
runtime value to `legal_entity_id`; tenant-shared creates have no descriptor.
No module id, Inventory family name, or interpreter branch participates.

`classification: 'INTERNAL'` is normative rather than decorative:

- the external operation input must not contain `legalEntityId`;
- a direct `input.legalEntityId`, even when it equals the request selection, is
  refused as a caller attempt to supply an internal value;
- a legal-entity selection for an operation without the descriptor is refused;
  and
- only the gateway may add the exact accepted UUID to the effective execution
  input consumed by policy, mediation, hashing, and the generic executor.

This creates two deliberately different views of the operation input. The
external input carries only caller-authorable keys. The effective execution
input also carries compiler-declared internal keys. `closedArgumentKeys`
describes the latter; `classification` decides which of those keys the caller
may supply.

### 3. The operation permission is the issuance decision

The gateway first obtains an accepted `exactlyOne` kernel receipt, then presents
the candidate effective input — including its exact legal entity — to the
registered operation's live permission. A denial executes nothing. After ALLOW,
the value is issued for this one invocation and may reach the generic executor.

Unlike a query read scope, the issued write value is consumed immediately by
one operation and is not a reusable capability forwarded among query
executors. A second broad “write scope” permission would duplicate the selected
operation permission without adding a decision. If the value is ever made
reusable or forwarded independently, that change requires its own sealed
capability and ruling.

The effective input, not the external input, is the input to:

- the registered operation policy decision;
- confirmation-grant comparison;
- the canonical input digest and idempotency binding; and
- the generic executor.

Changing only the selected legal entity must therefore change the digest. A
confirmation grant minted for one selection must be stale for another. A
scoped operation whose confirmation-minting path cannot bind the same effective
input must refuse; it may not issue an unscoped grant. Current generic
entity-owned create operations declare `confirmation: 'none'`, so this does not
block the first implementation slice.

### 4. Request adapters carry selection separately from authored input

For the web runtime, the authority to ask is already present in the compiled
surface binding: the form's data-source query declares an exactly-one
`legalEntityScope`, and `legalEntitySelectionForSurface` reads its selected UUID
from the URL. On a bound create, the web adapter passes that selection to the
operation gateway as execution context, separate from `operationInput`.

The surface binding already proves that the bound operation and data-source
query address the same entity. A missing or multiple URL selection reaches the
gateway as an invalid selection and refuses; the adapter does not choose a
default or take the first value.

Other adapters must provide the same separate untrusted selection or return a
typed unsupported/refusal result for entity-owned create. They may not restore
the old direct `input.legalEntityId` route. This ruling does not require a new
canonical-language member or widen the v1 semantic operation envelope; the
adapter-to-gateway execution context is a runtime port, analogous to the query
gateway's existing execution context.

### 5. The generic press remains generic

The PostgreSQL interpreter continues to consume only the compiled system-input
descriptor and the gateway-created effective input. It does not read a URL,
choose a default legal entity, query a “first” entity, branch on Inventory, or
accept an authored movement field. The physical insert remains the already
measured generic `systemInput.physicalColumn` path.

This ruling supersedes ADR-0015 only where that ADR permits an entity-owned O0
create to obtain legal-entity identity from explicit operation input or a
default. For generic semantic create, neither is permitted. The identity comes
from the issued request selection. Module-specific workflows may still declare
their own business authority, but they do not change the generic press.

## Preserved probe and evidence

The probe is preserved, never to be merged, at commit `7fbe0f0` on
`packet/scoped-create-operand`.

It changes only the runtime and web seams plus two existing integration test
files. It does not alter the canonical model, compiler output, PostgreSQL
interpreter, release verification, Inventory definition, or the live
`inventory-form-anatomy` lane.

The measured positive path is:

1. a synthetic compiled surface/query binding declares an exactly-one legal
   entity scope;
2. a create URL carries one UUID;
3. the web adapter keeps it outside authored `values` and passes it as operation
   execution context;
4. the real operation gateway evaluates the existing canonical scope kernel;
5. the registered operation policy observes the effective input with that UUID;
6. the generic executor observes the same UUID as its derived `legalEntityId`;
   and
7. a second UUID produces a different input digest.

The probe also observes independent refusals for omitted selection, an array at
exactly-one cardinality, direct `input.legalEntityId`, and selection supplied to
an unscoped operation. Every refusal leaves the executor call count unchanged.
The two focused files pass 37 tests in total.

This is a seam probe, not a substitute for the implementation packet's real
PostgreSQL control. The accepted `5g3-write-scope` evidence already proves that
the derived system input reaches the physical column. The implementation packet
must compose that provider fact with this gateway issuance on one real web
create and read the stored column independently.

## Consequences

- The symmetric Q1 move works semantically without a canonical version cut.
- The accepted direct-caller route from `5g3-write-scope` becomes a migration
  target: its release-verification and test callers must supply request scope,
  not `input.legalEntityId`.
- The compiler emits no new bytes for this ruling. If implementation discovers
  that the existing descriptor cannot carry the distinction, that is a stop and
  a separately chartered compiler-output change with its downstream provider
  gates.
- A web form can create an entity-owned record once its own form anatomy and
  required relation controls are separately valid. This ADR does not claim
  those prerequisites.

## Rejected alternatives

- **Have the generic press choose a legal entity.** That invents business scope
  and is forbidden.
- **Put an Inventory branch in the interpreter.** That violates ADR-0011 and
  would leave every later entity-owned module unsolved.
- **Author a movement or transaction field backed by the same value.** The
  compiler would create a second physical column, while posting does not
  populate it.
- **Keep accepting direct `input.legalEntityId`.** Its spelling is a caller
  input even when the catalog labels it `INTERNAL`; it is a filter-shaped value,
  not an issued scope.
- **Copy `queryLegalEntityScope` into the current operation definition.** The
  strict canonical schema refuses it. Adding it requires a language cut that
  the measured runtime route does not need.

## What this ADR does not decide

- The slot and action anatomy of the Inventory form surfaces.
- Relation picker rendering, scoped enumeration, or the required relation
  selected by an inventory transaction form.
- Development seed inventory data.
- `5g3-mount`'s verification derivation that records an unconstructible
  scenario with entity, operation, and required storage column.
- A reusable legal-entity write capability. No such capability is needed while
  one gateway invocation consumes one issued value immediately.
