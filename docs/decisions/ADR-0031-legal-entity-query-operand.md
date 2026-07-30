# ADR-0031: The legal-entity query operand and canonical language v4

Date: 2026-07-30
Status: accepted (packet `Q1-P5`)
Tier: Critical (review per `review-tiers`)

## Context

Inventory's stock identity is `(legalEntityId, itemId, locationId)`
([ADR-0016](ADR-0016-stock-identity-dimension-set.md)). The read path had no concept of
legal entity, so a balance query summed two companies' stock into one confidently wrong
number.

`Q1-P4` built the enforcement half: an issued, policy-approved read scope that fails
closed, with typed refusal before SQL and no false-zero path. What it cannot do is let
anyone **ask**. Both production callers invoke the query gateway with two arguments —
`semantic-gateway-api-adapters.ts:24` (`invoke(view, semanticEnvelope)`) and
`release-verification-service.ts:1269` (`invoke(this.view, {...})`) — so neither can
carry a separately issued execution capability.

The orchestrator initially declined a canonical language event, reasoning from
`LEGAL_ENTITY_FAMILY_RULES` (`conformance.ts:40-53`): legal-entity storage metadata was
added with **zero** canonical spelling, so the read scope could be too. **That ruling was
reversed** (commit `05d4d8d`), and the reversal is the premise of this ADR.

## Decision

### 1. The operand is a query member, because it changes the answer

The family map derives **compile-time storage metadata**: whether a family emits a
`legal_entity_id` column. It is a property of the schema, identical for every request.

The read scope selects a **runtime business value**: scope `{A}` returns `5` where scope
`{A,B}` returns `12`, for the same query, the same tenant, and the same principal.

`tenantId` and `environmentId` are ambient trust identity — they come from authenticated
request context, they lead every RLS predicate, and no authorized caller ever sees across
them. *Which legal entities to consolidate* is none of those things.
[ADR-0015](ADR-0015-legal-entity-business-dimension.md):38 already binds this distinction
("`legalEntityId` is a **business** dimension … resolved from operation input or a
declared default, never from ambient session state"). A query operand belongs in the
query shape. The precedent about where a *contract* lives does not settle where a
*runtime operand* lives.

### 2. The spelling

A v4 query definition — row or aggregate — may carry one optional member:

```text
legalEntityScope: {
  kind: "queryLegalEntityScope",
  schemaVersion: "v4",
  cardinality: "exactlyOne" | "nonEmptySet",
  operand: {
    kind: "queryParameterReference",
    schemaVersion: "v4",
    parameterId: <canonical id>
  }
}
```

`onHand` declares `exactlyOne`; ADR-0015's authorized consolidated reporting declares
`nonEmptySet`.

**The operand is an ordinary declared query parameter.** That is the load-bearing choice,
and it is what makes the scope reachable: the caller supplies a UUID (or a nonempty UUID
array) inside `envelope.arguments` under that parameter id, so the existing two-argument
adapter carries it with no new transport, no third gateway argument, and no API change.
The gateway — not the caller — turns that untrusted value into an issued capability.

**Row queries gain `parameters` at v4.** Q1-P4's enforcement keys on compiled storage
metadata, so *every* read of an entity-owned family is scope-required, not only
aggregates. Admitting the operand on aggregates alone would leave inventory's four Q0
reads unaskable and leave release verification with no declared contract to probe.

### 3. Cardinality is enforced by a kernel, not by each execution target

`evaluateLegalEntityScopeSelection` in `legal-entity-scope-kernel.ts` is a pure reference
evaluator, in the same class as `inspectPredicateForExecution` and
`evaluateQueryAggregateSemantics`. It is the single authority on what a selection means;
the gateway and any future execution target prove parity against it rather than
re-deciding.

Every clause is a refusal, never a repair:

| Input | Outcome |
|---|---|
| operand omitted (`undefined`/`null`) | `selection-omitted` |
| array where `exactlyOne` is declared | `set-selection-for-exactly-one` |
| scalar where `nonEmptySet` is declared | `scalar-selection-for-non-empty-set` |
| `[]` | `empty-selection` |
| repeated member | `duplicate-member` |
| non-lowercase or non-UUID member | `invalid-member` |
| more than 64 members | `selection-limit-exceeded` |

Three of these deserve their reasons stated.

**Omission is never "all."** It is not even a narrower scope — it is a refusal. A missing
scope that became `legal_entity_id = NULL` would return no rows, and `COALESCE(SUM(…), 0)`
would then return **zero**: the exact wrong-answer defect this dimension exists to
prevent.

**Duplicates are refused, not collapsed.** Collapsing rewrites the caller's request into a
different one, so the asked question and the answered question stop being the same
question.

**Members must be lowercase canonical UUIDs.** The repository's existing `uuidPattern` is
case-insensitive. A case-insensitive reader here would admit two spellings of one entity,
and the duplicate rule would then pass a two-member set naming one company — the same
class of wrong answer, arriving through the validator meant to stop it.

### 4. The parameter's type is derived, not authored

A scope operand carries legal-entity identity, not a business field value, so it has no
`FieldTypeSchema` spelling. Normalization derives
`{ kind: "legalEntityReferenceParameterType", schemaVersion: "v4" }` for exactly the
parameter a `queryLegalEntityScope` names. An author cannot separately assert a type and
create two authorities over one argument.

A parameter bound in **both** positions — scope operand and filter comparison operand — is
refused (`CANON_QUERY_LEGAL_ENTITY_SCOPE_PARAMETER_CONFLICT`) rather than given a winner.
A silent winner is a second authority on what the caller's argument means.

### 5. Release verification probes the refusal; it never supplies an entity

Release verification exercises every active query in a compiled release. A verification
path that supplied a real legal entity would **assert a business fact it has no authority
to assert** — that some particular company exists and is the right one to measure.

**Decision: verification invokes a scope-declaring query with the operand omitted and
requires the typed refusal.** It asserts nothing about any tenant's companies; an omitted
operand is not a claim.

Q1-P4's report proposed instead a versioned `queryLegalEntityScopeContractProbe` node
carried to a dedicated non-business verification seam. That is declined, for three
reasons:

1. **It would be a second authority.** The compiled catalog already carries
   `legalEntityScope` with its cardinality and operand. A probe node would restate the
   same contract in a second spelling that can drift from the first. ADR-0021's ruling
   pattern is to rule the semantics and decline the second spelling wherever it adds no
   authority — the same pattern the reversed ruling misapplied, applied correctly here.
2. **A dedicated seam is a proxy.** `AGENTS.md` §6 requires a gate to *observe* the fact
   it asserts. The negative probe traverses the real production path — same gateway, same
   pinned catalog, same refusal — where a parallel seam observes a parallel path.
3. **It cannot pass vacuously.** An unregistered query throws
   `NO_SUCH_REGISTERED_QUERY`, a different code; the probe requires the specific refusal,
   so a query that silently vanished from the catalog fails rather than passes.

### 6. One authority per query at the gateway

When the compiled query declares `legalEntityScope`, the gateway issues the scope from the
caller's argument. A separately supplied `SemanticQueryExecutionContext.legalEntityReadScope`
for that same query is **refused, not ranked**: two answers to one question is exactly the
second-authority failure this ADR spends its other rulings avoiding. Queries that declare
no operand keep Q1-P4's execution-context path unchanged.

No port was introduced. The gateway calls `issueLegalEntityReadScope` directly.

## What this ADR does not decide

The following are **owed and not shipped**:

- five `schemaVersion !== 'v3'` comparisons in `semantic-query-gateway.ts` that reject v4
  aggregate catalog nodes. Fail-closed and harmless today because no package is at v4;
  must be widened before one is. The row-query path this packet exercises does not reach
  them;
- `release-verification-service.ts:691-700`, whose `VerificationQueryContract` covers only
  `get|list|resolve|search` and must learn to run the omission probe ruled in §5. The
  probe's refusal is implemented and controlled at the gateway; the verification call site
  is not yet wired;
- migrating any package to v4, which is the artifact event, deliberately deferred exactly
  as `4c` was deferred from `4a`/`4b`.

Also unchanged and unshipped: grouping by entity, a returned legal-entity system field,
per-query opt-out, and any predicate reference to the compiler-owned column.

## Consequences

- **v4 is cut without adoption, so nothing moves.** `LATEST_LANGUAGE_VERSION` is now v4
  (newest readable) while a new `ADOPTED_LANGUAGE_VERSION` stays v3 and keys
  `DEFAULT_COMPILER_PROFILE`. Every checked-in root, golden and release artifact is
  byte-identical across this change. Collapsing the two constants migrates every package
  and moves every root; a control observes the default profile directly.
- **v3 is not widened.** `legalEntityScope` is absent from every v3 `z.strictObject`, so a
  v3 document carrying it is rejected. This is the control ADR-0021 exists for.
- **Feature levels are cumulative and asked as questions.** `languageHasV3Features` and
  `languageHasV2Features` answer yes for v4. Cutting v4 initially broke
  `languageHasV2Features`, which compared against `'v2' || 'v3'` — the standing lesson
  that every gate built for one situation needs widening the first time a second appears,
  observed again.
- **Version-tracking fixtures were following the wrong constant.**
  `test/fixtures/g2/module-conformance/definitions.ts` and three compiler suites derived
  their authored version from `LATEST_LANGUAGE_VERSION`, i.e. "newest readable", and broke
  the moment a readable-but-unadopted version existed. They now derive from
  `ADOPTED_LANGUAGE_VERSION`.
- **One negative control was probing with `'v4'`** as its stand-in for an unknown version
  (`negative-contracts.test.ts:76`). It now probes one past the newest readable version. A
  control that probes with a version the language later gains stops observing the fact it
  asserts.
- The scope operand costs one declared parameter per scope-requiring query and one
  argument per call. Callers that omit it are refused, which is the point.
