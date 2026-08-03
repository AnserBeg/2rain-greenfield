# Packet 5g3-rowparam — bind declared row-query parameters

Status: evidence_ready  
Tier: Behavioral  
Original packet base: `e4ae60ff38b430b5e126de6e9d54375348cccad2`
Rescue parent: `30c0b06cad5bc8c19ae229cc6e5f534c8cfb8ab7`

## Outcome

`SemanticQueryGateway.#invoke` still has one parameter-binding call for both
result shapes. `bindQueryParameters` now binds every declared row parameter
through the same field-type matcher used by aggregates. Aggregate argument
roots retain their exact-key contract; row roots retain their existing
record/list members and require every declared parameter without claiming
authority over those other arguments.

The legal-entity operand remains separate. `acceptedLegalEntityScopeSelection`
runs before binding and owns cardinality, UUID, duplicate, limit, and omission
semantics. The binder copies that already-accepted operand into
`parameterValues` but skips field-type matching for its exact declared id. An
ordinary invalid row parameter therefore raises
`MALFORMED_SEMANTIC_QUERY_REQUEST`, while an invalid scope operand still raises
`SEMANTIC_QUERY_LEGAL_ENTITY_SCOPE_INVALID` with the kernel reason.

## Executed controls

| Control | Observation | Victim evidence |
|---|---|---|
| A — row binding | The executor observes the exact frozen `parameterValues` map, not merely the original request argument. | Restoring the former non-aggregate early return produced `{}` and failed the assertion. |
| B — wrong type | A Boolean supplied to a declared v4 text parameter is refused with code `MALFORMED_SEMANTIC_QUERY_REQUEST`; executor count remains zero. | Restoring the early return made the request execute and the independent control red. |
| C — omitted | Omitting the declared row parameter is refused with the same typed code and no executor call. | Restoring the early return made the omitted request execute and the independent control red. |
| D — one scope authority | A valid `nonEmptySet` selection reaches an issued capability and the frozen bound map; malformed and omitted selections retain `SEMANTIC_QUERY_LEGAL_ENTITY_SCOPE_INVALID` plus the canonical reason. | Bypassing `acceptedLegalEntityScopeSelection` made the omission case execute and the control red. The ordinary binder did not substitute another refusal. |
| E — aggregate regression | The existing real PostgreSQL required-sum control still binds both aggregate parameters and returns the exact narrowed sum. | Returning `{}` for aggregates failed with `MODULE_QUERY_PARAMETER_MISSING`; restoration passed the same control. |

All mutations were restored before the final focused green runs.

The ordinary-row controls enter at the runtime's closed pinned-catalog
boundary. They prove that a declared catalog parameter is bound and typed;
they do not independently prove compiler lowering. Compiler conformance owns
the separate fact that an authored declaration is consumed by a predicate or
scope rather than emitted unused.

## Artifact and ownership record

No compiler, canonical model, projection, checked-in release, golden, or root
changed in this packet. `packages/postgres-provider/src/module-runtime-interpreter.ts`
is byte-identical to the rescue parent; the aggregate regression only executed it.

The reusable lesson is the existing ADR-0031 rule: one declared argument has
one semantic authority, while transport binding copies the accepted value. It
is recorded here rather than appended to `learnings.md` because the live
`packet/write-scope` branch currently edits that add-only shared file.

## Gates and review

Pre-freeze gates:

- `corepack pnpm typecheck` — pass.
- `corepack pnpm test:unit` — pass, 54/54.
- `corepack pnpm test:compiler` — pass, 115/115.
- `corepack pnpm test:integration` — pass, 71/71.
- `corepack pnpm test:postgres` — the first quiet run was red when the first
  composed-application parent reached its unchanged 300-second harness limit
  (138 passed, one cancelled). The same parent then passed alone in 243,264 ms,
  and the complete quiet retry passed 139/139 in 943,282 ms; no code, test, or
  budget changed between those runs.

Behavioral review and the exact-SHA full matrix are recorded at the packet
checkpoint rather than self-referentially embedding the eventual commit id in
this document.
