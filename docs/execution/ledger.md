# Execution ledger

Statuses: `planned -> admitted -> active -> evidence_ready -> accepted`;
`blocked` only for an explicit dependency or user decision. One row per
packet; the accepted SHA is immutable once recorded.

The G0 rows below are a seed breakdown. The orchestrator's first job is to
refine them (plan section 11.3) and present the refined table for user
selection — packets may be split, merged, or resequenced with user approval
before any become `admitted`.

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
| G1-P5 | RequestRuntimeView + single-release request pinning | G1 | Critical | active | - | [packet](packets/G1-P5.md); [cut](packets/G1-P0.md) |
| G1-P6 | Empty fail-closed Semantic Query/Operation gateways | G1 | Critical | planned | - | [cut](packets/G1-P0.md) |
| G1-P7 | Compiled SurfaceRuntime shell + component registry | G1 | Behavioral | planned | - | [cut](packets/G1-P0.md) |
| G1-P8 | UX grammar skill-pin + compiled SurfaceRuntime seam | G1 | Mechanical | planned | - | [cut](packets/G1-P0.md) |
| G1-P9 | Consolidated G1 stage-gate evidence | G1 | Mechanical | planned | - | [cut](packets/G1-P0.md) |
