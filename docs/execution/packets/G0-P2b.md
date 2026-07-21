# G0-P2b — Operational and trust constitutional ADR tranche

Status: active
Tier: Critical

## Goal and scope

Complete the constitutional ADR set by assigning the five concerns reserved by
G0-P2a: human release-activation governance, append-only inventory posting
truth, Semantic Query/Operation gateway ownership, in-app agent tool
prohibitions, and lifecycle/audit/correction/recovery doctrine. Extend the
runtime authority map so each concern has one named authority and clean
handoffs to the accepted P2a authorities.

Owned paths:

- `docs/decisions/ADR-0006-human-controlled-release-activation.md`
- `docs/decisions/ADR-0007-append-only-inventory-posting-truth.md`
- `docs/decisions/ADR-0008-semantic-query-and-operation-gateways.md`
- `docs/decisions/ADR-0009-in-app-agent-tool-boundary.md`
- `docs/decisions/ADR-0010-lifecycle-audit-correction-and-recovery.md`
- `docs/architecture/runtime-authority-map.md`
- `docs/execution/packets/G0-P2b.md`
- `docs/execution/ledger.md`

Out of scope: runtime code, dependencies, executable boundary tests,
PostgreSQL/provider work, physical-purge implementation, workflow approvals,
bounded autonomy, recovery infrastructure, and any G0 stage-gate claim.

## Required gates

- `corepack pnpm typecheck`
- `corepack pnpm format`
- `git diff --check main...HEAD`
- owned-path and authority-map review against the accepted P2a ADRs and plan
  sections 0-7, 9-10, 11.3, 14.1, and 15.3
- salvage-reference review confirming that prior trust/lifecycle material is
  REFERENCE only

## Test it yourself

Read ADR-0006 through ADR-0010 and the extended
`docs/architecture/runtime-authority-map.md`. For each new row, verify that it
has exactly one named authority and that the corresponding document-ownership
row excludes adjacent authorities. Walk the eight P2b checklist items, paying
special attention to human approval versus active-version truth, gateway
mediation versus domain truth, and shared audit evidence versus specialist
ledgers.

No command execution is required for this documentation checkpoint.
