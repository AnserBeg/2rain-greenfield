# G1-P2 salvage record — compiler design and evidence references

Mode: REFERENCE and RE-EXPRESS only
Packet: G1-P2
Quarry: `/home/rvham/2rain_erp`, branch `chess`, SHA
`668a60bb3912a2df0b66f098b4c47ff8fe1396a6`

No prior compiler, action, runtime manifest, test, dependency, generated
artifact, or mission output is copied or imported. The greenfield compiler,
fixtures, output protocol, hashing, diff, and tests are new.

## Sources consulted

- `docs/module-authoring-ir-design.md` for deterministic ordering, complete
  lowering, fail-closed object coverage, stable logical identity, structural
  diff, compiler-owned physical details, and preview isolation questions.
- `docs/module-authoring-slo-lock.md` for explicit scale envelopes, correctness
  before timing, and separately measured compiler/storage/operation budgets.
- `tests/runtime-customization-compiler.test.ts` as a behavioral checklist for
  deterministic full projection and rejection of unsupported constructs.
- `tests/runtime-manifest-invariant.test.ts` as a behavioral checklist for
  cross-artifact agreement and fail-closed invariant verification.

## KEEP / RE-EXPRESS / REJECT

| Disposition | Referenced lesson | Greenfield result |
|---|---|---|
| KEEP | Complete deterministic lowering or fail closed | Required projection families and cross-projection invariants must pass before a release root exists |
| KEEP | Stable logical identity, canonical ordering, structural diff, and correctness oracles before timings | Namespaced projection instances, canonical byte/hash vectors, factual diff, permutation tests, and a correctness-first numeric compile gate |
| KEEP | Compiler owns physical derivation; definitions do not embed SQL/routes/handlers | Freeze B payloads remain logical and provisional; storage strategy and runtime details stay with named packets |
| RE-EXPRESS | Flat compiled manifest and object-coverage records | Hierarchical release → projection manifest → chunk protocol with separate semantic and artifact roots |
| RE-EXPRESS | Runtime compiler and invariant tests | New bootstrap/vertical/negative fixtures assert complete projections, exact optional-field transition, invariant agreement, and no root on partial lowering |
| RE-EXPRESS | Provisional manifest/module SLO values | Separate SLO families plus a greenfield numeric 4,096-field cold-compile budget; quarry values remain references only |
| REJECT | Deployment-global active manifest and base-manifest identity | Tenant activation belongs to immutable release/approval records in G1-P3/G1-P4; shareable compiler output has no tenant identity |
| REJECT | Runtime customization overlay or inherited manifest lineage | Every release is one complete directly resolved snapshot; runtime overlay/parent-chain evaluation is forbidden |
| REJECT | Flat singleton artifact slots and physical storage shapes as protocol | Multi-instance families and versioned chunking preserve future sharding/partitioning choices |
| REJECT | Compiler/action files as runtime authority | Only the accepted greenfield release kernel and semantic gateways may activate or execute compiled definitions |

## Invariants retained

1. A supported construct is represented in every required projection or the
   compile fails with no publishable root.
2. Stable semantic identity is distinct from physical or chunk layout.
3. Canonical ordering, hashes, and diagnostics cannot depend on environment,
   prose, timing, path, locale, or task completion order.
4. Exact expected-active and candidate roots bind transition planning.
5. Timings are accepted only after correctness and completeness oracles pass.
6. Preview and production compilation cannot become separate semantic
   evaluators.

## Known defects not carried

- deployment-global package or activation authority;
- static metadata plus runtime overlay as dual lineage;
- one flat singleton manifest whose keys freeze physical architecture;
- tenant/coordinator identity inside reusable artifacts;
- model-authored SQL, routes, action files, or handler imports;
- compile latency being reported as approval, migration, or activation
  latency; and
- partial manifests surviving as activation candidates.

## Evidence and rollback

Required evidence is the compiler/architecture/unit suite, golden leaf/
projection/release/diff vectors, fresh-process and permutation battery,
numeric maximum-field budget, fail-closed transition/completeness negatives,
boundary checker, and the packet's two-review Critical chain. Before
integration, rollback is deletion of the G1-P2-owned compiler, fixture, test,
protocol, SLO, and salvage files plus restoration of its manifest/lock,
doctrine, packet, ledger, and language-note changes.

