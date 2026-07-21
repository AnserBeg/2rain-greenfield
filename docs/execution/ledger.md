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
| G0-P6 | X-01 baseline freeze in the prior repository | G0 | Mechanical | planned | - | - |
