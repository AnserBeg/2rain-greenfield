# Execution ledger

Statuses: `planned -> admitted -> active -> evidence_ready -> accepted`;
`blocked` only for an explicit dependency or user decision. One row per
packet; the accepted SHA is immutable once recorded.

The G0 rows below are a seed breakdown. The orchestrator's first job is to
refine them (plan section 11.3) and present the refined table for user
selection — packets may be split, merged, or resequenced with user approval
before any become `admitted`.

## Stage completion

| Stage | Status | Completion packet | Evidence |
|---|---|---|---|
| G1 | **COMPLETE** | G1-P9 — reviewed SHA `1e69199078bf0c455d45bfccfd4b3ef631923afd` | [G1 stage-gate evidence](stage-gates/G1.md) |

| ID | Packet | Stage | Tier | Status | SHA | Evidence |
|---|---|---|---|---|---|---|
| G0-P1a | Fresh pnpm/TypeScript workspace and clean-install scaffold | G0 | Mechanical | accepted | `856f90ca4a1bd1d4d099760dd2da6dc8ad51e4ae` | [packet](packets/G0-P1a.md) |
| G0-P1b | CI jobs and repository hygiene gates for the scaffold | G0 | Mechanical | accepted | `2b516125f972296481c2cc6fd557db74d37c7386` | [packet](packets/G0-P1b.md) |
| G0-P2a | Foundational constitution ADRs + authority map + framework decision | G0 | Critical | accepted | `5a3f96c80ea931cfc39aa4af2648f45282bf279f` | [packet](packets/G0-P2a.md) |
| G0-P2b | Operational and trust constitution ADRs | G0 | Critical | accepted | `34f439c88f26d8efb98224d6b8ad9481250234f2` | [packet](packets/G0-P2b.md) |
| G0-P3 | Dependency-boundary checker + architecture tests | G0 | Behavioral | accepted | `c69fac3b6b1b84bfa56e30fce458338ca0bb2106` | [packet](packets/G0-P3.md) |
| G0-P4a | Ephemeral PostgreSQL + migration runner + schema-drift tests | G0 | Critical | accepted | `399e6098e1b06dd68d20b7280f904b6baa131858` | [packet](packets/G0-P4a.md) |
| G0-P4b | Trusted request context + two-tenant and pool-reuse isolation | G0 | Critical | accepted | `64458dc55199bc3c5277b62dd22d7cc666823c6a` | [packet](packets/G0-P4b.md) |
| G0-P5 | Observability baseline + evidence/ledger wiring in CI | G0 | Behavioral | accepted | `d7d21fc021765ab0fcbb8a8c5627d3501eff44a0` | [packet](packets/G0-P5.md) |
| G0-P5c | Dependency and secret scans in CI | G0 | Mechanical | accepted | `b48cfc64d653d28b8fe7d13ef4f745869e588e68` | [packet](packets/G0-P5c.md) |
| G0-P6a | X-01 baseline input freeze in an isolated quarry worktree | G0 | Mechanical | accepted | `68f748cde06ecc795b159be5ae507a9d973106ac` | [packet](packets/G0-P6a.md); [baseline](baselines/x01-v1.md) |
| G0-P6b | X-01 baseline replay in a disposable checkout | G0 | Mechanical | accepted | `2bd1d232426a2b50afd7ea350ad29e2a08c1e11b` | [packet](packets/G0-P6b.md); [replay](baselines/x01-v1-replay.md) — accepted with red replay limitations |
| G1-P0 | G1 stage cut and parallelization map | G1 | Mechanical | accepted | `69b6ff87c28ca3638ac7958efce7acfa011b43a0` | [packet](packets/G1-P0.md) |
| G1-P1 | Canonical identifiers and minimal object schemas | G1 | Critical | accepted | `18a6b5d62fda9a073450ee47a0acd6d511d557fd` | [packet](packets/G1-P1.md); [cut](packets/G1-P0.md) |
| G1-P2 | Deterministic compiler + bootstrap package + golden artifacts | G1 | Critical | accepted | `433a382d6244129dde19dc2335b219c3defbbdce` | [packet](packets/G1-P2.md); [cut](packets/G1-P0.md) |
| G1-P3 | Immutable AppPackageRevision/TenantRelease persistence | G1 | Critical | accepted | `925ec8a7d56dcca120b0cdf192e7d74a568c0ba6` | [packet](packets/G1-P3.md); [cut](packets/G1-P0.md) |
| G1-P4a | Release activation contracts + real approval substrate, no callable activation | G1 | Critical | accepted | `c3769eba9ee21b3e2121a59c660e8d648037c73f` | [packet](packets/G1-P4a.md); [cut](packets/G1-P0.md) |
| G1-P4b | Human-approved CAS activation + crash reconciliation + rollback | G1 | Critical | accepted | `1bb946f9a5668512a6d4cab6876dd66ec0d3753d` | [packet](packets/G1-P4b.md); [cut](packets/G1-P0.md) |
| G1-P5 | RequestRuntimeView + single-release request pinning | G1 | Critical | accepted | `edef3db9940ba479cef7736238008c2e0321858b` | [packet](packets/G1-P5.md); [cut](packets/G1-P0.md) |
| G1-P6 | Empty fail-closed Semantic Query/Operation gateways | G1 | Critical | accepted | `cfeb19c211a4678a9623817c82d859167339a1c3` | [packet](packets/G1-P6.md); [cut](packets/G1-P0.md) |
| G1-P7 | Compiled SurfaceRuntime shell + component registry | G1 | Behavioral | accepted | `e647968` | [packet](packets/G1-P7.md); [cut](packets/G1-P0.md) |
| G1-P8 | UX grammar skill-pin + compiled SurfaceRuntime seam | G1 | Mechanical | accepted | `4ea66868d823472fd135a8dc0b71137ff9c4a990` | [packet](packets/G1-P8.md); [cut](packets/G1-P0.md) |
| G1-P9 | Consolidated G1 stage-gate evidence | G1 | Mechanical | accepted | `1e69199078bf0c455d45bfccfd4b3ef631923afd` | [packet](packets/G1-P9.md); [evidence](stage-gates/G1.md); [cut](packets/G1-P0.md) |
| G2-P0 | G2 stage cut and parallelization map | G2 | Mechanical | accepted | `ce6649d7951802cbb95366809f31d39412d77b9a` | [packet](packets/G2-P0.md) |
| G2-P1 | Transactional trust/audit/change/outbox substrate | G2 | Critical | accepted | `a71aa33157ac35f54dd3c9e4f36bd65b5c5e0861` | [packet](packets/G2-P1.md); [cut](packets/G2-P0.md) |
| G2-P1a | Mechanical bridge: architecture migration-list for 0006 | G2 | Mechanical | accepted | _this commit_ | [packet](packets/G2-P1.md) |
| G2-P2a | Freeze F contract candidate and compiler lowering | G2 | Critical | accepted | `b494609e7c2442e05ed29682d1711ce1898d787a` | [packet](packets/G2-P2.md); reviewed by fresh Codex xhigh and Fable max on the identical SHA. Subpacket acceptance does not ratify Freeze F; G2-P2 remains active pending P2b/P2c. |
| G2-P2a-manifest-version | ReleaseManifest canonical-version corrective bridge | G2 | Critical | accepted | `eaba9772477b9888b345a4ccb10e88be02f96e27` | [packet](packets/G2-P2a-manifest-version.md); fresh Codex `gpt-5.6-sol` xhigh PASS and Fable max PASS on the identical reviewed SHA. Corrective acceptance does not ratify Freeze F; G2-P2 remains active. |
| G2-P2b | PostgreSQL materializer/provider and storage-transition evidence | G2 | Critical | accepted | `09b84b8996b5516a8443362da7efaefa7b9e605e` | [packet](packets/G2-P2.md); round 1 REVISE on `71aea06bb4e6091f5738f7c90e45b3a5c2fc5a4b`, then round 2 REVISE on `d8b77fbe4cfe10379472a1d95c17003ec692dbb1`. The adjudicated one-pass exception (not a reset) fixes exact any-live/all-retired approval-sibling root validity and stale reference counts, and adds the named A6 object-class snapshot bridge. All gates are green at 7/7 focused and 55/55 full; fresh Codex `gpt-5.6-sol` xhigh PASS and Fable max PASS reviewed the identical recorded SHA with no `NEW_MATERIAL` finding. G2-P2 remains active pending P2c; Freeze F is not ratified. |
| G2-P2 | Consolidated projections, typed-storage transition safety, and module conformance | G2 | Critical | active | - | [packet](packets/G2-P2.md); [cut](packets/G2-P0.md); G2-P2a supersedes the G1-P2 v0-provisional storageTransitionPayload; G1 vertical release-root + v1->v2 diff goldens regenerated; Freeze-B determinism gates green. Deliberate forward migration of provisional G1 evidence under verdict A7, not a G1 reopen. P2a reviewed candidate `b494609e7c2442e05ed29682d1711ce1898d787a`: fresh Codex xhigh PASS and Fable max PASS on the identical SHA; G2-P2 remains active pending P2b/P2c and Freeze F is not ratified. |
| G2-P3 | Party walking slice, resolver, and reusable module template | G2 | Critical | planned | - | [cut](packets/G2-P0.md) |
| G2-P4 | Full surface-grammar, compact/mobile, and accessibility conformance | G2 | Behavioral | planned | - | [cut](packets/G2-P0.md) |
| G2-P5 | Shared master-data table behavior and saved filters | G2 | Critical | planned | - | [cut](packets/G2-P0.md) |
| G2-P6 | Catalog/item walking slice | G2 | Critical | planned | - | [cut](packets/G2-P0.md) |
| G2-P7 | Location walking slice | G2 | Critical | planned | - | [cut](packets/G2-P0.md) |
| G2-P8 | Server-validated durable item/location import | G2 | Critical | planned | - | [cut](packets/G2-P0.md) |
| G2-P9 | Consolidated G2 stage-gate evidence | G2 | Mechanical | planned | - | [cut](packets/G2-P0.md) |
