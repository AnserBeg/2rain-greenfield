# G2-P3b salvage admission — generic resolver text matching

Status: admitted for G2-P3b
Mode: PORT (bounded primitives), plus REFERENCE-only module coverage

## Source and provenance

- Quarry repository: `/home/rvham/2rain_erp`, read-only branch `chess`
- Immutable source commit: `668a60bb3912a2df0b66f098b4c47ff8fe1396a6`
- Port source: `server/resolvers/text-match.ts`, blob
  `62a8e8e5b5dfb1d69b9e96f04d52a0777d0bb50f`
- Resolver evidence inspected: `tests/resolver-contracts.test.ts` at the same
  commit
- Coverage-checklist sources: `shared/modules/customers/{metadata,validators,
  permissions,business-semantics,query-concepts,intent-context,events,types}.ts`
  at the same commit. As a provenance check, `metadata.ts` is blob
  `e6f9c5defead1df7b162ac59c2c9902986fcb818`.
- Modeling reference: `docs/purchasing-inventory-plan.md` section 1, blob
  `c0c6007b7cb369cebb90ed39fb1c03ef3554f039`, at the same commit.

The quarry stays unmodified and is not a dependency of this repository.

## Admission decision

### KEEP and port

Only pure, deterministic primitives cross the boundary:

1. normalization to a stable comparison form;
2. normalized Levenshtein similarity;
3. token-sort similarity;
4. token-set/Jaccard similarity; and
5. deterministic candidate ordering by score and stable record identity.

The greenfield implementation is
`packages/runtime/src/resolve-by-name.ts`. It is a clean implementation, not a
file copy. It takes only explicitly declared identifier/name fields and frozen
semantic DTOs. Party, Catalog, and Location can consume it without a module
branch.

### REWRITE

- The contract is the frozen `SemanticQueryResultEnvelope`, not the quarry's
  `selected/candidates/canAutoSelect/clarification` object.
- Candidate acquisition runs through `SemanticQueryGateway` with an issued,
  release-pinned `RequestRuntimeView`; the primitive never opens a repository,
  table, or cross-tenant search path.
- The caller supplies compiled resolve/list query IDs and explicitly declared
  selected identifier/name field IDs. The bridge validates that both queries
  are compatible projections for the same entity.
- An exact declared identifier can produce `exact`. An exact name, duplicate
  name, partial name, or fuzzy name produces `ambiguous`; fuzzy rank is
  presentation order only and never selection authority.
- Missing and cross-tenant identifiers are indistinguishable `not-found`
  results. Match fields, physical storage facts, and hidden candidate text do
  not enter the envelope.

### REJECT

- company-suffix stripping (`Ltd`, `Inc`, and similar) as hidden domain policy;
- alias dictionaries and caller-specific normalization;
- inferred candidate fields such as `name`, `unitNumber`, `orderNumber`, or
  `jobDescription`;
- inferred-label tie breaking;
- weak fuzzy, suffix-stripped, prefix, or single-candidate name auto-selection;
- `matchedField` / `matchedText` metadata in public results;
- the prior private service/repository resolver wiring; and
- any Party-specific resolver branch.

## Named defects in the quarry shape

1. `normalizeCompanyResolverText` silently changes business identity by
   stripping legal suffixes, and the prior evidence permits that transformed
   name to auto-select.
2. Candidate fields and display labels are inferred from object property names,
   coupling a supposedly shared primitive to caller DTO shapes.
3. Aliases are supplied as caller heuristics rather than versioned compiled
   contract data.
4. Similarity thresholds influence service selection behavior and are not
   carried in a frozen/versioned resolver contract.
5. The primitive has no tenant/environment boundary itself; safety depends on
   every caller choosing the correct repository scope.
6. Public candidate metadata reveals which hidden field matched and its source
   text.

## Admitted invariants

1. Normalization and scoring are pure and deterministic for identical bytes.
2. Candidate order is independent of input enumeration order.
3. Only an exact value in a declared identifier field may auto-select.
4. Name and fuzzy candidates always require clarification (`ambiguous`).
5. Candidate acquisition is tenant/environment/policy scoped by the Semantic
   Query gateway and the pinned request view.
6. Empty, missing, and cross-tenant input returns `not-found` without an
   existence oracle.
7. Declared fields must belong to compatible compiled resolve/list queries for
   one entity; malformed resolver registration fails closed.
8. The result contains canonical semantic DTOs only—no table, storage class,
   matched-field, or hidden-text metadata.
9. The implementation contains no Party, Catalog, or Location literal.

## Evidence gaps and compensating gates

The quarry does not prove compiler registration, release pinning, policy
rechecks, environment scope, same-DTO identity, forced RLS, or PostgreSQL
coexistence. It also has no golden vector for Unicode normalization and no
large-candidate performance evidence. G2-P3b compensates with:

- focused deterministic normalization/scoring tests, including reversed input
  order;
- compiler projection and no-private-branch tests;
- exact/duplicate/fuzzy/missing/cross-tenant resolver tests through the
  Semantic Query gateway;
- real PostgreSQL two-tenant and composite-FK rejection tests;
- UI/query/agent/read-back DTO identity checks; and
- the full compiler, PostgreSQL, architecture, schema, and browser gates.

Performance and rich result paging remain outside G2-P3b and belong to G2-P5.

## REFERENCE-only module coverage checklist

The prior customer module was inspected only to ensure the new walking slice
accounts for identity and fields, validation, permissions, business semantics,
query concepts, agent context, events, DTOs, list/detail/form surfaces,
create/update/archive/restore actions, parent relations, and reporting. The
greenfield canonical definition plus compiled projections is the sole
authority for every item.

Static metadata/overlay lineage, private registries, framework wiring, direct
routes/services, bespoke DTO families, and all delete actions/events are
rejected. The purchasing plan contributes one modeling lesson only: supplier
or vendor is a role of Party; it is not a second Vendor master.

## Rollback

If the port fails its gates, remove the shared `resolve-by-name.ts` bridge and
its focused assertions, leaving the accepted semantic-query envelope and
provider exact resolver unchanged. Do not restore quarry services, aliases,
heuristics, or private registries. Re-admission would require a new packet and
fresh evidence.
