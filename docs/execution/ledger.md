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
| G0-P1b | CI jobs and repository hygiene gates for the scaffold | G0 | Mechanical | planned | - | - |
| G0-P2a | Foundational constitution ADRs + authority map + framework decision | G0 | Critical | accepted | `5a3f96c80ea931cfc39aa4af2648f45282bf279f` | [packet](packets/G0-P2a.md) |
| G0-P2b | Operational and trust constitution ADRs | G0 | Critical | accepted | `34f439c88f26d8efb98224d6b8ad9481250234f2` | [packet](packets/G0-P2b.md) |
| G0-P3 | Dependency-boundary checker + architecture tests | G0 | Behavioral | active | - | [packet](packets/G0-P3.md) |
| G0-P4 | Ephemeral PostgreSQL test harness + two-tenant smoke fixture | G0 | Behavioral | planned | - | - |
| G0-P5 | Observability baseline + evidence/ledger wiring in CI | G0 | Mechanical | planned | - | - |
| G0-P6a | X-01 baseline input freeze in an isolated quarry worktree | G0 | Mechanical | accepted | `68f748cde06ecc795b159be5ae507a9d973106ac` | [packet](packets/G0-P6a.md); [baseline](baselines/x01-v1.md) |
| G0-P6b | X-01 baseline replay in a disposable checkout | G0 | Mechanical | accepted | `2bd1d232426a2b50afd7ea350ad29e2a08c1e11b` | [packet](packets/G0-P6b.md); [replay](baselines/x01-v1-replay.md) — accepted with red replay limitations |
