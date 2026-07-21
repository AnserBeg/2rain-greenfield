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
| G0-P1 | Repo scaffold: toolchain, monorepo layout, CI, test runners | G0 | Mechanical | planned | - | - |
| G0-P2 | Constitution ADRs (the nine from plan 11.3) | G0 | Critical | planned | - | - |
| G0-P3 | Dependency-boundary checker + architecture tests | G0 | Behavioral | planned | - | - |
| G0-P4 | Ephemeral PostgreSQL test harness + two-tenant smoke fixture | G0 | Behavioral | planned | - | - |
| G0-P5 | Observability baseline + evidence/ledger wiring in CI | G0 | Mechanical | planned | - | - |
| G0-P6a | X-01 baseline input freeze in an isolated quarry worktree | G0 | Mechanical | accepted | `68f748cde06ecc795b159be5ae507a9d973106ac` | [packet](packets/G0-P6a.md); [baseline](baselines/x01-v1.md) |
| G0-P6b | X-01 baseline replay in a disposable checkout | G0 | Mechanical | evidence_ready | - | [packet](packets/G0-P6b.md); [replay](baselines/x01-v1-replay.md) — red replay gates recorded |
