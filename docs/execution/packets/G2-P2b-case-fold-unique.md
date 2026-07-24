# G2-P2b corrective — enforce Unicode case-folded uniqueness

Status: evidence_ready
Tier: Critical
Branch: `fix/g2-p2b-case-fold-unique`
Frozen candidate: `5f2e7826e893b32671fc15546a461fa678c6f24c`
Review: PASS — fresh Codex `gpt-5.6-sol` xhigh, then Fable max on the
identical unchanged SHA

## Root cause and corrected invariant

The accepted P2b materializer rendered both the compiled
`StorageUniqueKeyTarget.normalization = unicodeCaseFold` contract and its
`caseInsensitiveUnique` index as plain unique indexes over the raw text
column. The compiler artifact was correct, but PostgreSQL did not enforce its
normalization semantics. Honest writes could therefore persist `P-001` and
`p-001` in the same tenant and environment.

The corrected invariant is: every compiled Unicode case-insensitive business
key is unique over `(tenant_id, environment_id, unicodeCaseFold(value))`.
Scope columns remain raw UUID qualifiers. The fold is one version-pinned
Unicode 15.0.0 full-case-fold table exported by canonical-model and consumed
by both application code and the provider renderer. PostgreSQL executes a
pure immutable managed-schema function generated from that same table; the
indexes call the function rather than locale-dependent `lower()`.

The materializer fails closed if a `caseInsensitiveUnique` index lacks its
matching compiled `unicodeCaseInsensitive` / `unicodeCaseFold` unique-key
contract. The catalog verifier attributes and compares the support function's
body, language, volatility, strictness, parallel safety, fixed search path,
ownership, and exact grants, plus both corrected expression-index shapes.
`PUBLIC` has no function execution grant; only the materializer owner and the
DML-only module runtime can execute the pure fold. Other index kinds are
unchanged.

No compiler protocol, storage target, transition envelope, migration, or
schema snapshot changed. This implements the already-ratified Freeze-F
normalization tag; it does not amend that contract.

## Regression proof

The focused real-PostgreSQL proof compiles and materializes the accepted G2
definition fixture, then:

- compares PostgreSQL and application output for all 1,530 non-identity
  Unicode 15.0 case-fold mappings, plus compound examples;
- rejects an exact duplicate (`P-001` / `P-001`), an ASCII case variant
  (`P-001` / `p-001`), an accented Unicode case variant (`Å-002` / `å-002`),
  and a multi-code-point fold (`Straße-003` / `STRASSE-003`) with PostgreSQL
  unique violation `23505`;
- permits the same normalized value in a second tenant/environment, proving
  the scope qualifiers were preserved; and
- inspects both generated unique indexes to require the versioned fold
  function and reject any `lower()` expression.

The inserted regression rows remain inside one transaction and are rolled
back, so subsequent backfill and tenant-isolation evidence is not polluted.

## Secondary unit diagnosis

The 17/18 unit result was a **stale test input**, not a source-side v0 leak.
The negative test called nested schema version `v1` “unknown”; after G2-P2a,
both v0-experimental and v1 are accepted, so the canonical model correctly
returned `CANON_VERSION_MIXED`. The test now supplies genuinely unsupported
`v2` and retains its existing `CANON_VERSION_UNSUPPORTED` assertion. No
diagnostic behavior or production version source changed; `test:unit` is
18/18.

## Exact scope

Corrective paths:

- `packages/canonical-model/src/unicode-case-fold.ts`
- `packages/canonical-model/src/index.ts`
- `packages/postgres-provider/src/module-storage-materializer.ts`
- `test/postgres/module-storage-transition.test.ts`
- `test/unit/canonical-model/negative-contracts.test.ts`
- `docs/execution/packets/G2-P2b-case-fold-unique.md`
- `docs/execution/ledger.md`
- `learnings.md`

Out of scope: Party or another real module; compiler/protocol/storage-target
changes; migrations or snapshot changes; query/operation runtime behavior;
surface/UI behavior; generated-storage promotion; and performance. The paused
Party work is preserved separately and is not present in this branch.

## Gate evidence

| Gate | Result |
|---|---|
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm check:boundaries` | PASS — 88 files scanned |
| `corepack pnpm format` | PASS |
| `corepack pnpm test:compiler` | PASS — 45/45 tests |
| `node --import tsx --test test/postgres/module-storage-transition.test.ts` | PASS — 8/8, including full fold parity and duplicate rejection |
| `corepack pnpm test:postgres` | PASS — 58/58 tests |
| `corepack pnpm test:unit` | PASS — 18/18 tests |
| `corepack pnpm check:schema` | PASS — 8 applied / 8 verified, clean drift; snapshot unchanged |
| `corepack pnpm test:architecture` | PASS — 41/41 tests |
| `git diff --check` | PASS |
| Fresh Codex `gpt-5.6-sol` xhigh | PASS — all four charter questions; no material findings |
| Fable max | PASS — identical candidate; all four charter questions; no material findings |

## Review charter and status

Threat model: honest-code correctness defects—unenforced uniqueness or a
database/application fold divergence. Party, other modules, and performance
are out of scope.

The fresh Critical reviewers decide only whether:

1. case-insensitive/Unicode-fold uniqueness is enforced in PostgreSQL using a
   fold consistent with canonical application normalization, with exact,
   ASCII-case, accented-Unicode, and expanding-Unicode cases proven and no
   `lower()` divergence;
2. the mechanism and catalog attribution are deterministic and correct;
3. existing materializer/storage behavior and non-case-fold index kinds do
   not regress; and
4. the v0/v1 unit correction is accurately classified as a stale test input
   and preserves the intended fail-closed diagnostic test.

Fresh naive Codex `gpt-5.6-sol` xhigh returned **PASS** on all four decisive
questions for `5f2e7826e893b32671fc15546a461fa678c6f24c`, with no material
findings. It independently compared the 1,530 frozen mappings with Unicode
15.0 and found zero mismatches. Fable max returned **PASS** on the identical
unchanged SHA, confirming storage enforcement, all-string fold equivalence,
tenant/environment scoping, catalog-verifier completeness, unchanged other
index behavior, and the stale-unit classification. No REVISE round was
needed. The packet remains `evidence_ready` pending user acceptance.

The first Codex launcher command was rejected before a reviewer started
because its local concurrency setting used an invalid `agents.max_depth=0`;
it produced no session or verdict and is not counted as a review seat. The
subsequent valid invocation was fresh and is the PASS recorded above.

The program-review trigger does not fire here: this is an unintegrated local
corrective packet, not the clean integrated Party walking-slice checkpoint.
The already-declared first-module program review remains due only after Party
is completed and accepted, before Catalog/Location fan-out.

## Test it yourself

From the repository root, these commands take under ten minutes:

```bash
cd /home/rvham/2rain-greenfield
git show -s --format='%H %s' HEAD
node --import tsx --test test/postgres/module-storage-transition.test.ts
corepack pnpm test:unit
corepack pnpm check:schema
```

Expect the focused PostgreSQL file to report 8/8, including
`unicode case-folded unique keys are storage-enforced and match the application fold`.
Expect the unit suite to report 18/18 and schema validation to report 8
applied / 8 verified with no drift. The focused proof must show case variants
rejected within one tenant while the same folded key remains valid in a
second tenant.

No next implementation packet is authorized by this checkpoint. Stop for
review and user acceptance; do not resume Party.
