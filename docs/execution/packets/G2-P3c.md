# G2-P3c — Explicit resolver authority

Status: evidence_ready
Tier: Critical
Branch: `packet/g2-p3c-resolver-authority`
Frozen candidate: `01bddcfce741ff7cc64df1527b84654483f5c0d9`

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

The product candidate is frozen at
`01bddcfce741ff7cc64df1527b84654483f5c0d9`. The evidence-only packet close
commit does not alter the reviewed product bytes.

Implemented proof:

- Canonical language and normalization profiles advance from v1 to v2 through
  their shared source-of-truth constants. v0-experimental and v1 remain
  supported with their original normalization meanings.
- Resolve match authority is strict canonical data and survives normalization,
  compiler type checking, query-catalog projection, pinned-artifact parsing,
  and generic PostgreSQL execution. The interpreter has no field-name,
  uniqueness, caller, or module-specific authority inference.
- The generic runtime returns `exact` only for one identifier match with no
  advisory match. One or many advisory matches return `ambiguous`; multiple
  identifier matches return `ambiguous`; no declared-key match returns
  `not-found`. The PostgreSQL journey also proves forced-RLS cross-tenant
  not-found and that a selected but undeclared text field is not matched.
- An authority-less v2 resolve fails compilation with the stable typed
  `COMPILER_RESOLVE_MATCH_AUTHORITY_REQUIRED` diagnostic. Runtime registration
  and provider execution independently fail closed on absent or malformed
  authority metadata.
- Get, list, and search retain their existing generic paths. No Party or other
  module code is present.

Named consequences:

1. **Canonical-v2 golden bridge:** all affected values were regenerated from
   real compiler output and reproduced by two determinism runs. The resulting
   G1 roots are bootstrap
   `68ab5ef2235ebcda45623d72aaad12aef50f5cca92ad932b0abf80a981df2b3a`,
   vertical v1
   `2c2945947ca5f18224935a8f7e1ad3e1e95c875c193967d6d136caad77188993`,
   vertical v2
   `06efa88bb1d6adb4173b23544bcb2ba5e4a3b304603c4ab8bda04788b05a8c74`,
   and v1-to-v2 diff
   `dd5519ec94ec6400023349a0b01ca9bf59900faa7f23933030e945839cc69826`.
   The G2 release roots are
   `53595e9377d66e362876acb36ca793c91a748bac108c013211bddf9afcd66ece`
   and
   `6b9c88ea1d860518035326fbe319f1952c9e69353c826860c22851e2c316c1d8`.
   Storage-manifest, chunk, and transition-envelope-v1 goldens did not move.
2. **Compiler fixture version consequence:** storage-transition definition
   nodes now consume the current canonical version constant; their frozen ABI
   assertions are unchanged.
3. **Consumer-suite version consequence:** only stale canonical-version
   literals moved in the integration gateway fixture, materializer backfill
   fixture, and unsupported-version negative. No behavior assertion was
   removed or weakened.

Frozen-candidate gates:

| Gate | Result |
|---|---|
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm check:boundaries` | PASS — 88 production files |
| `corepack pnpm format` | PASS |
| `corepack pnpm test:compiler` | PASS — 46/46 |
| Determinism, Freeze-B, goldens, and focused G2 compiler suite, run twice | PASS — 45/45 both runs; fresh-process determinism executed |
| `corepack pnpm test:unit` | PASS — 18/18 |
| `corepack pnpm test:integration` | PASS — 38/38 |
| `node --import tsx --test test/postgres/module-runtime.test.ts` | PASS — 2/2 top-level journeys |
| `corepack pnpm test:postgres` | PASS — 58/58 |
| `corepack pnpm test:architecture` | PASS — 41/41 |
| `corepack pnpm check:schema` | PASS — 8/8, clean drift |
| `git diff --check` | PASS |

Critical review chain on the identical frozen candidate:

- Fresh naive Codex `gpt-5.6-sol` xhigh: **PASS** on all five charter
  questions; no actionable findings.
- Fable max: **PASS** on all five charter questions; no actionable in-scope
  findings. It independently confirmed explicit authority through every layer,
  advisory-never-auto-select semantics, complete v1-to-v2 versioning, the
  stable compiler diagnostic, and zero module-specific serving code.

## Test it yourself

From the repository root:

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
