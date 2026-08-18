# ADR-0055: Legal-entity create scope is a permission-authorized operand

Date: 2026-08-18
Status: proposed — the orchestrator ruled the model; packet acceptance still
requires the external Critical review and integrated full matrix
Tier: Critical (the value attributes writes, enters authorization, confirmation,
idempotency and execution, and controls whether archived masters can own new work)

## Context

An entity-owned create already declares a required `systemInput` descriptor in
the compiled operation contract. For the Inventory transaction create its
`argumentKey` is `legalEntityId`, and the same key is already present in the
contract's closed argument set. The PostgreSQL interpreter already rejects an
omitted or malformed value. No canonical-language or compiler-output change is
needed.

The live defect was smaller: the web boundary built a create input from
`recordId`, `relations` and `values` and dropped the legal entity selected by the
surface URL. A composed-browser comparison established that an otherwise
equivalent unscoped create succeeded while the scoped create reached the
provider and failed with `MODULE_REQUIRED_SYSTEM_INPUT_MISSING`.

There was also a separate accepted-ADR violation. ADR-0015 says archived legal
entities cannot be selected for new work. Presence, UUID validation and a
foreign key do not enforce that rule: an archived legal-entity master remains a
valid foreign-key target. The generic interpreter already receives the compiled
legal-entity-master descriptor, including the status column and active value,
but did not use them for create admission.

The preserved `scoped-create-operand` design probe proposed describing the web
gateway as the issuer of write scope, by analogy to ADR-0031 and Q1-P5's read
scope. That analogy is false. `LegalEntityReadScope` is sealed by runtime object
identity held in a private `WeakMap`; its fields are explicitly not the seal. A
semantic operation execution request is a plain copyable object, and the public
internal executor port accepts a correctly shaped request directly. Passing a
plain object from code located in the gateway does not turn it into an issued
capability.

## Decision

### 1. `legalEntityId` is untrusted operation input

For an entity-owned create, `legalEntityId` is an **untrusted operand authorized
by the registered operation permission**. It is not a default, a module-family
branch, an issued value or a capability.

The intended semantic-operation route presents the complete input, including
this operand, to the compiled operation's permission decision. A denial stops
before execution. The same complete input is then used for confirmation
comparison, input digest and idempotency identity, and execution. There is no
second effective-input object and no duplicated scope authority.

`classification: 'INTERNAL'` on the existing system-input descriptor classifies
the operation-contract slot and its storage derivation; it does **not** attest
that the value is trusted or gateway-issued. `closedArgumentKeys` states which
executor arguments the operation accepts. The descriptor has one contract
audience, while the value remains untrusted at every caller-facing boundary.

### 2. The web carrier is contract-derived

For a create whose selected operation declares a system input, the web runtime:

- reads the legal-entity selection already resolved from that surface's URL;
- requires exactly one selected value;
- places it under the operation contract's `systemInput.argumentKey`; and
- refuses omission or multiplicity before semantic invocation.

The form action preserves the selected scope parameter so an ordinary click
does not lose it between GET and POST. The runtime never hardcodes
`legalEntityId`, a module id, an Inventory entity or a fixture UUID. A create
without a declared system input refuses a supplied URL scope rather than
accepting and ignoring it.

Malformed UUID values remain untrusted operation input and are refused by the
existing provider contract. This ADR does not add a second UUID parser at the
web boundary.

### 3. Active ownership is enforced generically and transactionally

For every create of an entity whose storage descriptor declares legal-entity
ownership, the PostgreSQL interpreter reads the one compiled legal-entity-master
descriptor. Under the trusted tenant and environment context, it locks the
selected master row and compares the descriptor's status column with its
`activeStatusValue`.

That check runs inside the same accepted-mutation transaction and module-runtime
role as the insert. `FOR NO KEY UPDATE` prevents a concurrent status update from
changing the enforcing fact between admission and insertion. A non-active
selection refuses as `MODULE_LEGAL_ENTITY_CREATE_INACTIVE` and names the selected
legal-entity id as its subject. The web boundary preserves that subject in a
dedicated operator diagnostic.

This is the generic enforcing layer because it holds both facts required by
ADR-0015: the compiled storage meaning and the transactional master row. An
allow-all local policy is not a substitute for this invariant.

### 4. No sealed write-scope receipt is introduced

A request constructed directly for `SemanticOperationExecutor` can carry the
same operand and succeed. The committed PostgreSQL control observes both the
gateway route and a freshly constructed direct request. That is an accepted,
explicit consequence of this ruling, not a capability claim.

The registered permission is the authorization decision on the intended
semantic-operation boundary; it is not cryptographic or object-identity proof
that every internal execution request crossed that boundary. The current threat
model accepts this internal-port property. If later work must make direct
construction unrepresentable or provider-detectable, it requires a separately
ruled sealed write receipt. It must not be smuggled in by renaming a copyable
field "gateway-issued."

## Consequences

- The selected legal entity participates in policy, confirmation, digest and
  idempotency through the one existing operation input.
- Changing only `legalEntityId` under the same idempotency key conflicts; an
  identical replay is stable.
- An archived master cannot own a new entity-scoped record even when its UUID
  and foreign key remain valid. The identical request is admitted after the
  sole enforcing fact changes back to the descriptor's active value.
- Existing internal adapters that construct execution requests remain able to
  supply the untrusted operand directly. They do not gain a scope capability.
- The compiler-derived descriptor was sufficient. No language version, compiler
  projection or release artifact changes.

## Rejected alternatives

### Gateway issuance equivalent to Q1-P5

Rejected. Q1-P5's seal is private runtime object identity. A copyable operation
request has no equivalent seal, and the provider cannot distinguish an object
forwarded by the gateway from one assembled directly. Calling the latter
"issued" would make code location stand in for an issuance decision.

### A sealed write-scope receipt now

Rejected for this packet. It would change the executor contract and threat
model, and it is not required to honour the accepted untrusted-operand ruling.
The choice is recorded so a future packet does not accidentally re-propose it
as though it had never been considered.

### Enforce active status in composed policy

Rejected. The local composed policy deliberately allows; changing it would
special-case one composition and leave direct generic execution unprotected.
The generic provider owns the transactional storage facts.

## What this ADR does not decide

- An API wire spelling for the operand.
- A separate carrier for scoped human-confirmation flows. The implemented web
  create has `confirmation: none`; any future human-required route must bind its
  grant to the same complete operation input or refuse.
- Relation picker rendering, same-scope relation enumeration or bounded picker
  search.
- A sealed write-scope capability or a stronger internal-adapter threat model.
- Release-verification derivation mapping or dev seed data.
