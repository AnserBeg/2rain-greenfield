# G2-P2a-fix — align release-manifest canonical versions

Status: evidence_ready
Tier: Critical
Branch: `fix/g2-p2a-manifest-version`
Frozen candidate: `eaba9772477b9888b345a4ccb10e88be02f96e27`
Review: PASS — fresh Codex `gpt-5.6-sol` xhigh, then Fable max on the
identical unchanged SHA

## Root cause and invariant

G2-P2a retained a legacy-compatible `DEFAULT_COMPILER_PROFILE` so accepted G1
authored inputs remain reproducible. `compileApplication` incorrectly copied
that input profile's `languageVersion` and `normalizationProfileVersion` into
the persisted `ReleaseManifest`. That conflated an accepted compiler-input
compatibility profile with the current cross-layer release envelope. The
PostgreSQL release repository correctly requires a registered manifest to
match the current canonical `AppPackageRevision` versions, so a legacy-input
compile could not pass release registration.

The one-source invariant is: persisted `ReleaseManifest` language and
normalization versions derive directly from canonical `LANGUAGE_VERSION` and
`NORMALIZATION_PROFILE_VERSION`. An input profile may select an accepted input
reader, but it is not authority for current persisted release-envelope
metadata.

## Named corrective bridge

> **G2-P2a-fix P2a-to-P2b manifest-version bridge:** current persisted
> `ReleaseManifest` language/profile versions derive from canonical authority;
> legacy input compatibility remains input-only. The resulting release-level
> G1 golden changes are deterministic consequence evidence, not a G1 reopen.
> Accepted G2-P2a remains accepted, consolidated G2-P2 remains active, and
> Freeze F remains unratified pending P2b/P2c.

## Exact scope

Owned paths:

- `packages/compiler/src/compiler.ts`
- `test/compiler/freeze-b.test.ts`
- `test/fixtures/g1/compiler/bootstrap.release-root.golden.sha256`
- `test/fixtures/g1/compiler/vertical-v1.release-root.golden.sha256`
- `test/fixtures/g1/compiler/vertical-v2.release-root.golden.sha256`
- `test/fixtures/g1/compiler/vertical-v1-v2.diff.golden.sha256`
- `docs/execution/packets/G2-P2a-manifest-version.md`
- `docs/execution/ledger.md`
- `learnings.md`

The compiler change replaces only the two release-manifest assignments. The
Freeze-B change adds one focused legacy-input/current-envelope regression; no
existing or unrelated Freeze-B assertion changed. The four release-level
goldens are actual regenerated compiler outputs.

Out of scope: P2b or P2c work; PostgreSQL tests or provider implementation;
canonical-model, protocol, migration, schema, runtime, application, or UX
changes; changes to the accepted G2-P2a record; Freeze F ratification; and
prior-repository salvage. All eight `test/postgres/*.test.ts` files are
unchanged.

## Digest lineage

| Artifact | Before | After |
|---|---|---|
| Bootstrap release root | `ad172b054fd0b3c155778f4cdc328402218a445ae23f1f5a7360f7a3a2f6903c` | `8a231b3d71951fbb14982a5ca7c862d4227cd6ec112ed9e3fd2626d7157c79b8` |
| Vertical v1 release root | `76625bcbc3a561884b23bb99c2f9ccc47e78c19d3a50ab9ce0484c1d5a2508eb` | `82dc0b81b01554d19ecddaad89eb812df67cddef56d101c54d65cfb9078b6199` |
| Vertical v2 release root | `7c23bc04e4a58da9a38d4b4a68d2eca9a1d354b548bea6c45ed07ca6a7342091` | `60f639e46a915a197a45bd1472f303b244d20109115e8fa134161b259cb3e974` |
| Vertical v1-to-v2 canonical diff | `f6ed6712ed1bd8e1acd7b12c89716bca72d0262dc8dc206cb9a8a41f7c42c5b8` | `9c55e1ccac5e71b191583a5218728aab1cab7dace6b2beaab186fe172cc0e7f8` |
| Vertical v1-to-v2 transition plan | `cd749ddb7cd152ab0b39d6fc387e68d5e7dd3010118905da31c0877128b5c0a0` | `b3832cfdf15e5d15a13e464aaaab3dfeba7d85aea205033f06e7dddf8e53f97e` |

Two independent regeneration processes each executed 117 pair compiles. The
processes produced byte-identical outputs and the same after-values above.

## Gate evidence

| Gate | Result |
|---|---|
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm check:boundaries` | PASS — 81 files checked |
| `corepack pnpm format` | PASS |
| `corepack pnpm test:compiler` | PASS — 45/45 tests |
| `node --import tsx --test test/compiler/g2-module-*.test.ts` | PASS — 23/23 tests |
| `node --import tsx --test test/compiler/determinism.test.ts test/compiler/freeze-b.test.ts test/compiler/golden-vectors.test.ts` | PASS twice — 21/21 tests in each run |
| Independent release regeneration | PASS — two fresh processes, 117 pair compiles each, with byte-identical outputs |
| `corepack pnpm test:postgres` | PASS — 48/48 tests across all eight unchanged PostgreSQL test files (15 top-level suites plus their nested subtests) |
| `git diff --check` | PASS |
| Exact owned-path audit | PASS — only the nine paths listed above changed; no `test/postgres` path changed |

The earlier red PostgreSQL run reported only 22 tests because failing parent
suites aborted their nested subtests. After this fix, the unchanged eight
PostgreSQL files execute the complete test graph and report 48/48. The larger
count is the honest complete result and is stronger than the earlier “22/22”
shorthand; no test was changed or selectively rerun to manufacture that count.

## Review status and limitations

Fresh naive Codex `gpt-5.6-sol` xhigh returned PASS on all four decisive
questions for `eaba9772477b9888b345a4ccb10e88be02f96e27`: one canonical
version authority, deterministic golden consequences with Freeze-B coverage
preserved, compiler and unchanged PostgreSQL suites green, and no scope drift.
Fable max independently returned PASS with no findings on the identical SHA.
The packet remains `evidence_ready` pending user acceptance.

This packet corrects only persisted release-envelope version authority and its
deterministic release-level consequences. It does not implement or test the
P2b materializer/provider contract, execute Freeze F DDL, prove P2b
preparation/receipt/drift behavior, serve a module, ratify Freeze F, or alter
the accepted G2-P2a contract. The existing PostgreSQL suite proves the current
release-registration consumers still compose; it is not P2b evidence.

Program-review triggers do not fire at this checkpoint: this is an
unintegrated corrective packet, not a first end-to-end slice, fan-out point,
new stabilized correctness domain, zero-dev-code module, or stage gate.

## Test it yourself

From the repository root, these commands take under ten minutes:

```bash
cd /home/rvham/2rain-greenfield
git show -s --format='%H %s' HEAD
corepack pnpm test:compiler
node --import tsx --test test/compiler/g2-module-*.test.ts
corepack pnpm test:postgres
```

Expect the first command to show the frozen SHA reported at handoff and
`fix(compiler): align release manifest canonical versions`. Expect 45/45
compiler tests, 23/23 focused G2 tests, and 48/48 PostgreSQL tests. In the
compiler run, the focused Freeze-B regression proves that a legacy compiler
input emits a release manifest carrying the canonical current language and
normalization versions. The PostgreSQL run must discover the same eight
unchanged test files and complete all nested subtests.

No next implementation packet is authorized by this checkpoint. Stop for the
required candidate review and user decision; do not begin P2b.
