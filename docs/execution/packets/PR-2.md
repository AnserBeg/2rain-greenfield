# PR-2 — CRITICAL SEMANTIC-PRESERVATION corrective

Status: accepted
Tier: Critical
Branch: `fix/pr2-semantic-preservation`
Base: `cf2d669b2aaf2e09fdf4ae8c9d8c0de2c769b331`
Frozen reviewed candidate: `9d5f4187866410da3311e321f9982d56c4c073a3`
Acceptance merge: `5d5676f9c6e3ef26d6ebf808c1f3ec02da690ff5`
Review: PASS — fresh naive Codex `gpt-5.6-sol` xhigh, then Fable max on
the identical unchanged candidate

## Authority and outcome

This packet implements the six binding PR-2 dispositions in
`docs/execution/program-reviews/2026-07-24-g2-p3-party/converged-record.md`.
It is the semantic-preservation corrective required before Catalog/Location
fan-out. Registration remains data and the production press remains generic:
there is one compiler/provider/runtime path, with no Party- or future-module
branch in production.

PR-2 does not begin PR-3. `apps/web` production is unchanged; the only browser
change is a test-fixture correction that keeps its archive journey legal under
the newly enforced relation contract.

## Corrective scope

1. **Executable verification plan.** The verification projection emits
   content-derived scenario IDs from declarations, fields, relations, queries,
   and entities. `executeVerificationPlan` is the only issuer of accepted
   execution results; validation requires runner-issued object identity,
   matching scenario fingerprints, real-PostgreSQL provider identity, and the
   required positive/negative proof digests. Labels, copied results, and
   fabricated results fail. Party and the metamorphic module execute every
   compiled scenario against real PostgreSQL. Recovery evidence is a real
   create → archive → restore journey for each entity, including PartyRole.
2. **Archive-restrict enforcement.** `archiveBehavior` is carried through the
   storage relation contract. The generic interpreter serializes parent
   archive against child create/restore with conflicting row locks, rejects an
   archive with active dependents, and rejects create/restore against an
   archived parent with typed canonical errors. Missing pre-PR-2 semantic
   metadata fails closed before DML as
   `MODULE_SEMANTIC_CONTRACT_UNSUPPORTED`. Party's previously illegal archive
   expectation and the browser fixture now use legal lifecycle sequences.
3. **Enum and input contracts.** Versioned operation/field contracts close
   argument keys, writable fields, relation inputs, field kinds, enum option
   IDs, requiredness, text length, numeric precision/scale, and temporal
   precision/timezone semantics. Validation runs before storage loading and
   DML. Numeric `(precision, scale)` requires integral digits no greater than
   `precision - scale`; real PostgreSQL accepts `123.45` and rejects `12345`
   for `exactDecimal(5,2)` with `MODULE_FIELD_VALUE_INVALID` before DML. Enum
   defense-in-depth is installed through ADR-0011's additive materializer path
   as idempotent `NOT VALID` CHECK constraints. No kernel migration was needed;
   schema migration count remains eight.
4. **Searchability and normalization parity.** Search matches only columns
   whose compiled `searchMapping` is `normalizedTextIndex`; the former raw-type
   fallback is gone, so Party's confidential `contactSummary` is excluded.
   Search, resolver matching, and case-insensitive uniqueness all call the same
   pinned `nsm_unicode_case_fold_v1` database primitive.

   The business-key normalization decision is **no NFKC compatibility
   normalization**. Case-fold-equivalent keys conflict, while compatibility-
   distinct strings remain distinct. Fullwidth `Ｐ－１００` and ASCII
   `P-100` coexist and resolve independently in both real-provider suites.
5. **Typed error surface.** SQLSTATE 23505 and 23503 are reverse-mapped through
   compiled storage metadata to canonical fields/relations and emitted as
   `MODULE_UNIQUE_VIOLATION` and `MODULE_RELATION_VIOLATION`. Other provider
   failures receive a generic typed diagnostic. Error-path assertions reject
   raw PostgreSQL messages, schema/table/constraint names, storage classes, and
   physical `nsm_*` identifiers.
6. **Declared-semantics behavioral suite.** The required semantic-contract gate
   is folded into `test:postgres`. The compiled plan drives positive and
   negative real-provider probes for Party and a randomized-namespace
   metamorphic module: enum rejection, archive restriction, searchable
   exclusion, typed errors, uniqueness folding, resolver authority, and all
   declared evidence kinds. Removing a declaration or an enforcement layer
   makes the suite fail.

## Compiler-output and migration bridge

PR-2 intentionally changes versioned projection content. The structural
goldens were regenerated from real compiler output and rerun twice without
movement. Final module-conformance roots are:

- V1: `78786e298e43042c0e7432a26cc830372d9266084539fda3e91cb5c8f45147bb`
- V2: `35b4df073f62d1516f3661664e239a5e2b22c55b49aed3d4ee400ff0fc144c45`

The V1→V2 transition has six ordered elements, including the expected amount
field and enum CHECK transition. Existing hash algorithms and domain strings
did not change; `verificationScenario` is a new, separately versioned domain.
The full PostgreSQL consumer suite ran because compiler output changed.

Enum CHECKs use the existing ADR-0011 transition/materializer machinery. No
new `db/migrations` file or schema-snapshot change was required, so the
pre-authorized migration-count bridge was not used.

## Commit trail

| Commit | Purpose |
|---|---|
| `8152ad00de4abb4df52973cb17818103c7d938d1` | Implement the six generic semantic-preservation dispositions |
| `9793eda` | Track the V2 semantic fixture revision in architecture evidence |
| `45449bf` | Keep the Party browser fixture legal under archive restriction |
| `442ee9b` | Bind verification to runner-issued execution; fail prior metadata closed; complete temporal contracts |
| `9d5f4187866410da3311e321f9982d56c4c073a3` | Match decimal integral-width validation to PostgreSQL `numeric(p,s)` |

## Full-matrix evidence on the frozen candidate

The commands below ran from a clean checkout at exactly
`9d5f4187866410da3311e321f9982d56c4c073a3`. Focused and review-correction runs
did not substitute for this matrix.

| Gate | Result |
|---|---|
| Frozen install | PASS — pnpm 11.9.0, all 13 workspace projects |
| `corepack pnpm format` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm check:boundaries` | PASS — 93 files scanned |
| `corepack pnpm build` | PASS |
| `corepack pnpm test:unit` | PASS — 27/27 from the explicit six-file set |
| `corepack pnpm test:compiler` | PASS — 48/48, repeated twice-stable |
| `corepack pnpm test:integration` | PASS — 40/40 |
| `corepack pnpm test:agent` | PASS — 1/1 |
| `corepack pnpm test:architecture` | PASS — 42/42 |
| `corepack pnpm check:schema` | PASS — 8 applied, 8 verified, no drift |
| `corepack pnpm test:postgres` | PASS — 61/61, including both generated semantic-contract executions |
| `corepack pnpm test:locale` | PASS — 1/1 |
| `corepack pnpm test:browser` | PASS — full suite 5/5 |
| Security CI job | PASS — dependency audit and clean repository scan; required synthetic-negative fixture detected |
| Observability CI job | PASS — 5/5 |
| Patch and tree cleanliness | PASS — `git show --check`, base diff check, and clean status |

Development reds were retained rather than hidden. The initial implementation
made architecture 41/42 because the fixture-version assertion still named V1;
`9793eda` corrected it. The next candidate made browser 4/5 because the fixture
archived a parent with active roles; `45449bf` corrected the fixture. During
the first review correction, format exposed a transition-golden formatting
change and compiler/focused tests exposed the expected projection count,
temporal fixture, relation-subject, and golden updates; these were regenerated
from real output and rerun stable. At `442ee9b`, the first full PostgreSQL run
was 60/61 because an unchanged observability test hit a Docker `--rm` cleanup
race; the isolated test passed and the unchanged full suite reran 61/61. The
final numeric fixture initially moved two expected compiler assertions; the
goldens were regenerated and the compiler suite then passed 48/48 twice.

## Review evidence

The Critical review charter was bounded to the six converged dispositions,
generic production scope, genuine browser fixture-only movement, executable
real-provider semantics, exact archive concurrency, pre-DML value contracts,
canonical typed errors, normalization parity, and expected compiler-output
goldens. It excluded PR-3 UI, module-specific production behavior, hostile DB
administration, performance redesign, and future-module requirements.

Codex round 1 reviewed `45449bf` and returned REVISE with three unique material
findings: fabricated proof objects could satisfy verification; valid prior
artifacts missing `archiveBehavior` could skip enforcement; and temporal
precision/timezone contracts were incomplete. `442ee9b` corrected exactly
those findings.

Fresh Codex round 2 reviewed `442ee9b` and returned REVISE with one material
finding: decimal validation did not constrain integral width to
`precision - scale`. `9d5f418` corrected both canonical and runtime validation
and added canonical and real-provider positive/negative evidence.

Fresh Codex round 3 reviewed `9d5f418` and returned **PASS** on all seven
decisive questions. Fable max then independently confirmed **PASS** on the
identical unchanged SHA. An earlier Fable process was stopped at the user's
request before it returned any output; it produced no verdict and was not
counted. The completed confirmation was a fresh run.

Fable recorded three non-blocking future observations, not PR-2 findings: add a
direct negative test for the compile-time executable-scenario diagnostic;
explicitly design archive-behavior evolution across coexisting roots when it
is needed; and explicitly design existing-column enum-option evolution before
Catalog requires it. Current behavior fails those future evolution cases
conservatively rather than weakening semantics.

The packet used exactly two REVISE rounds and then converged to PASS/PASS.

## Test it yourself

From the repository root, these commands take under ten minutes:

```bash
cd /home/rvham/2rain-greenfield
git switch fix/pr2-semantic-preservation
git show -s --format='%H %s' 9d5f4187866410da3311e321f9982d56c4c073a3
corepack pnpm test:compiler
corepack pnpm test:postgres
corepack pnpm test:architecture
corepack pnpm test:browser
```

Expect the frozen commit `9d5f418`, compiler 48/48, PostgreSQL 61/61 including
the generated Party and metamorphic semantic-contract probes, architecture
42/42, and the unfiltered browser suite 5/5.

## Checkpoint

PR-2 was accepted by non-squash merge
`5d5676f9c6e3ef26d6ebf808c1f3ec02da690ff5`, preserving reviewed candidate
`9d5f4187866410da3311e321f9982d56c4c073a3` as an ancestor. The converged
G2-P3 program review still governs sequencing: PR-3 remains required before
Catalog/Location fan-out. No new whole-app review trigger fires while that
already-converged corrective sequence is incomplete. Do not start PR-3
without explicit user selection.
