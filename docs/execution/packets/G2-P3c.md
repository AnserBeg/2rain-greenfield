# G2-P3c — Explicit resolver authority

Status: active
Tier: Critical
Branch: `packet/g2-p3c-resolver-authority`
Frozen candidate: pending

## Goal and sequencing

Make resolver selection authority explicit in canonical definition data before
the Party walking slice can establish Freeze G. `G2-P3c` is a shared press
packet inserted ahead of the paused `G2-P3b` Party packet. It composes the
ratified explicit-declaration constitution and Freeze F, so no debate is
required.

The paused Party salvage ruling rejects weak fuzzy auto-selection and
caller/field-name heuristics. This packet makes that ruling architectural:
generic resolution consumes only compiler-projected match keys whose authority
is declared as `identifier` or `advisory`. No quarry code enters this packet,
and no Party definition or Party-specific branch is added.

## Contract

- Canonical language and normalization profile advance together from v1 to
  v2. The v0-experimental and v1 profiles remain parseable with their original
  normalization meanings; only v2 admits explicit `resolveMatchKeys`.
- Every v2 resolve query declares stable, ordered match-key identities, a
  field reference, and an `identifier` or `advisory` authority. Match keys are
  invalid on get/list/search, duplicate field declarations fail closed, and
  compiler type checking requires the declared field to belong to the query's
  source entity.
- The compiler rejects a v2 resolve query with no declared authority using
  `COMPILER_RESOLVE_MATCH_AUTHORITY_REQUIRED`. The query catalog carries the
  ordered authority metadata only for the v2 language; older query-catalog
  output is not silently rewritten.
- The pinned-query parser rejects missing, malformed, duplicate, or
  query-type-incompatible match authority. The generic PostgreSQL interpreter
  matches only declared fields under the request's forced-RLS tenant and
  environment context.
- One unique exact normalized match through an `identifier` key returns
  `exact`. Any match through an `advisory` key returns `ambiguous`, including a
  single record. Multiple identifier matches also return `ambiguous`; no match
  returns `not-found`. Identifier and advisory comparisons use the same
  version-pinned Unicode case fold as module-storage uniqueness.
- Get, list, and search retain their existing serving paths. Registration
  remains data; there is no module-specific code.

## Scope

Owned implementation paths:

- `packages/canonical-model/**`
- `packages/compiler/**`
- `packages/postgres-provider/src/module-runtime-interpreter.ts`
- `packages/runtime/**`
- `test/compiler/*`
- `test/postgres/module-runtime*.test.ts`
- `test/unit/*`
- affected golden fixtures
- this packet record and `docs/execution/ledger.md`

Named deterministic and downstream consequences:

1. **Canonical-v2 golden bridge.** The G1 bootstrap/vertical release-root and
   vertical-diff goldens plus the G2 module release-structure golden are
   regenerated from real compiler output. Two complete compiles must reproduce
   every value; storage-transition envelope v1 remains unchanged.
2. **Compiler fixture version consequence.** Focused storage-transition test
   nodes that belong to the canonical definition use the canonical current
   version constant instead of a stale v1 literal. Frozen storage-transition
   ABI version assertions are unchanged.
3. **Consumer-suite version consequence.** The integration gateway fixture,
   materializer backfill fixture, and canonical unknown-version negative use
   the new source-of-truth version or an actually unsupported v3. No behavioral
   assertion is weakened.

Out of scope: Party or another real module, fuzzy scoring, performance,
migrations, schema snapshots, surfaces/UI, and any compiler storage-transition
contract amendment.

## Decisive review charter

Threat model: honest-code resolver defects that infer authority from
uniqueness or field names, auto-select an advisory name, match undeclared
fields, or only half-apply the language bump. Hostile input, Party/other module
behavior, and performance are out of scope.

The Critical review answers only:

1. Is resolve authority explicit in canonical and compiled query data, never
   inferred from uniqueness, field names, or caller behavior?
2. Does a unique exact identifier match return `exact`, while every advisory
   match returns `ambiguous` even when only one record matches?
3. Is the language plus normalization-profile bump sanctioned and complete
   from v1 to v2, with actual twice-stable regenerated goldens?
4. Does the compiler fail closed when a resolve query has no declared match
   authority?
5. Is the implementation generic, with no module code and no get/list/search
   behavior change?

Review chain: one fresh naive Codex `gpt-5.6-sol` xhigh review, then Fable max
on the identical unchanged SHA. Any fix produces a new SHA and fresh review;
maximum two REVISE rounds.

## Evidence

Pending frozen candidate, final gates, and both Critical reviews.

## Test it yourself

After the candidate is frozen, from the repository root:

```bash
cd /home/rvham/2rain-greenfield
corepack pnpm test:compiler
node --import tsx --test test/postgres/module-runtime.test.ts
corepack pnpm test:postgres
corepack pnpm test:architecture
corepack pnpm check:schema
```

Expect compiler determinism and all pinned goldens to pass. In the focused
PostgreSQL journey, resolving `a-001` through the declared identifier returns
`exact`; the single advisory name `Solo` and duplicate advisory name `Acme`
both return `ambiguous`; `Missing`, a cross-tenant identifier, and a selected
but undeclared notes field return `not-found`.

## Program-review trigger assessment

No whole-app program review runs on this unintegrated shared-contract packet.
The strong trigger remains the accepted first real Party walking slice just
before Catalog/Location fan-out. Party stays paused until this packet is
accepted and its v2 declarations can be added on the Party branch.

## Candidate next packet

After user acceptance, resume `G2-P3b` Party on the accepted resolver-authority
foundation. Do not begin that work from this packet.
