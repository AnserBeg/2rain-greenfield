# 5g3-langnarrow — relation declarations are honoured or refused

Status: evidence-ready implementation candidate; full matrix green, Critical
review pending

Tier: Critical

Base: `1eb64f1` (the branch absorbed the parallel docs-only ADR-0041 commit
before candidate freeze)

Authorities:
[ADR-0021](../../decisions/ADR-0021-total-absent-value-semantics.md),
[ADR-0039](../../decisions/ADR-0039-experimental-output-protocol-and-lineage-regeneration.md),
and
[ADR-0041](../../decisions/ADR-0041-declared-shapes-must-be-honoured-or-refused.md)

## Outcome

The relation grammar now admits only the declaration the platform implements:
`cardinality: 'manyToOne'` and `joinEligibility: 'query'`. The cardinality
spellings `oneToOne` and `oneToMany`, the join-eligibility spelling `none`, and
an omitted join eligibility all fail at the canonical authoring boundary. None
is rewritten to the supported declaration.

ADR-0021's pattern applies directly. It keeps required but unimplemented
comparison spellings outside the admitted language and makes their use a
compile-time error rather than a silent rewrite. This packet does the same for
relations: it rules the semantics, declines the spellings that have no
executing semantics, and leaves a future capability to arrive with its own
enforcement.

A repository-wide search found no authored use of `oneToOne`, `oneToMany`, or
`joinEligibility: 'none'`. Party, Inventory, the composed application artifact,
and the module fixtures declare `manyToOne` plus `query`. The representative
canonical fixture was the only omission; it relied on the old implicit `none`
default and was made explicit rather than treated as evidence of a needed
semantic.

The existing parent-scoped-child semantic guard remains in
`normalize.ts:1444-1461`. With the supported literals present, changing the
fixture relation's `required` member to `false` still reaches that guard and
returns `CANON_RELATION_PARENT_SCOPE_INVALID`. The narrowing therefore does not
turn the existing guard into dead evidence.

## Controls and victim evidence

| Control | Observed fact | Victim and recorded red |
| --- | --- | --- |
| `oneToOne` refusal | A `reference` relation carrying `oneToOne` returns `CANON_RELATION_CARDINALITY_UNSUPPORTED`, with the relation ID and `$.relations[0].cardinality`. Using `reference` prevents the parent-scope guard from masking the authoring result. | `schemas.ts:583`. Temporarily restoring the three-value enum made the test fail with `Missing expected exception`; the literal was restored and the test passed. |
| `oneToMany` refusal | The same independent observation for `oneToMany`. | `schemas.ts:583`. The same loosening was run against this test independently; it failed with `Missing expected exception`, then passed after restoration. |
| `none` refusal | A `reference` relation carrying `joinEligibility: 'none'` returns `CANON_RELATION_JOIN_ELIGIBILITY_UNSUPPORTED`, with the relation ID and exact member path. | `schemas.ts:591`. Temporarily restoring the two-value enum made the test fail with `Missing expected exception`; the literal was restored and the test passed. |
| omission refusal | Removing `joinEligibility` returns the same named diagnostic instead of recreating the former implicit `none`. | The absence of an optional override at `schemas.ts:602-605` and the absence of a default at `normalize.ts:327-331`. Temporarily restoring both the optional authored member and the old `none` default made the test fail with `Missing expected exception`; both were removed again and the test passed. |
| parent-scoped-child regression | With allowed relation literals, `required: false` still returns `CANON_RELATION_PARENT_SCOPE_INVALID`. | `normalize.ts:1449-1455`. This is the pre-existing control at `negative-contracts.test.ts:880-887`; it passed alongside all four new refusal controls. |

The named author diagnostics are selected at `normalize.ts:534-541`, and their
accepted alternatives are owned at `normalize.ts:2227-2233`.

## Artifact event

The canonical fixture previously omitted `joinEligibility`, which normalized
to the now-declined implicit value `none`. Making the authored declaration
explicitly `query` necessarily moved its canonical bytes. The values below were
produced by executing `normalizeApplicationPackage` and
`canonicalizeAndHash`; no digest was invented or edited independently of that
result.

| Artifact/profile | Before | After |
| --- | --- | --- |
| `representative.normalized.golden.sha256` / v3 | `bda130f1ac2bcbd57c7a7be906897ae09a67268467f1c7880b4a3d6c3f0f511c` | `51fa3abbc4e256b4d96223022c3ab2fa3ab1f0ec70e3e5798127e469a024fc02` |
| normalization v0-experimental | `00444e2e40aedea745ea23cc89ac5f2f01f9234dcae2473481b39134f3f036ba` | `6eb27fb2b977d50288e3f141b16330c63e381ec05d638295d406ba7a6992af27` |
| normalization v1 | `7126210813d43a1b8097f8500c8d3ece3ef5966dfdbe27bbfe988f035bcd0231` | `5c77f2c3b273e4704c17118c65eb0a1576316c21ac1c67d958ec455acb5c7d58` |
| normalization v2 | `538ed9deca0fed3f2c2340ce05ce65213fbacb02f153544b1d58cc9844d5048a` | `dbabd07e6e946eabbb93136cbbd48d46ed35dd646a9b4c83440c32287f5a8cb8` |

Authored-token telemetry moves from 3,651 to 3,661 because the fixture now
states its join behavior; normalized telemetry remains 2,567.

The checked-in composed application already declares `query` on every
relation. A real repository recompile with
`corepack pnpm --filter @north-star/web build:app-release`, followed by
`node --import tsx apps/web/scripts/compile-app-release.ts --check`, moved
**zero** lineage entries and left `apps/web/release/app.compiled.json`
byte-identical. Its bootstrap root remains
`7619e59cba92a3cc786eae11c0d9f83a6bb344e3d613a3039b53a1d05cfa1a55`;
the eight application roots remain, in order:

```text
a9c37c7784e726977cd32cd106ea441cfa5442568726bf04c60a0ec4e261e486
ba87d2155d9d8fcc2d7c12a058ccc44094857310f6bb2cf4c095955711e7aa05
bf932f8a4a69edc23c7a62c4191e1e9cf92c9482d38fc8bcef90945461615783
a8f6e2c14510a687a0eaa1e244d025dedc3062114d42d14861b26417e36e9420
6bf235d970f0ffb12c676d5925dc18aa01f1ef04ea864f2c1c04aa60712325a1
57f2649094526e0f7cad7ddca275537b2e41089c90755529bf95914d5a379699
575ee2c33421dcdded6efba646f41695168e76acc5cabd3895abeb8a8989d66f
9e3f36df340bc3db500929ca90f14a93238e0027799bcf782a9da6abda27d58d
```

Every entry still declares
`northstar.compiler-output/v0-experimental`. This is ADR-0039's named
zero-movement outcome, established by recompilation rather than assumption.

## Scope

No compiler conformance source was changed, no relation semantics were
implemented on speculation, and no language-coverage instrument was built.
Future one-to-one or one-to-many support must arrive with executing storage
semantics and its own negative controls.

## Gates

- `corepack pnpm typecheck` — PASS.
- `corepack pnpm lint` — PASS.
- `corepack pnpm test:unit` — PASS, 58/58.
- `corepack pnpm test:compiler` — PASS, 114/114.
- `corepack pnpm test:architecture` — PASS, 106/106.
- `corepack pnpm test:integration` — PASS, 68/68.
- `corepack pnpm test:postgres` — PASS, 147/147 in 471,486.9 ms.
- Real application release build and `--check` — PASS, zero lineage movement.
- The first matrix admission attempt terminated with
  `COMPILE_BUDGET_INDETERMINATE`: observed CPU idle was 86.4%, below the
  required 90.0%. This was not treated as a failure or retried while another
  test process was active.
- The quiet retry observed 96.7% CPU idle, 1,785.7 ms CPU and 1,377.7 ms wall
  time for the 5,000 ms compile budget, then completed the full repository
  matrix with
  `FULL_MATRIX_PASS_SHA=1fc58e86643adc23233593c25270b0791ab303c4`.
