# G0-P2b — Operational and trust constitutional ADR tranche

Status: accepted
Tier: Critical
Frozen candidate: `34f439c88f26d8efb98224d6b8ad9481250234f2`

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

## Outcome

Five accepted ADRs now cover every concern reserved by P2a. The extended map
assigns human release approval, inventory quantities, semantic gateway ingress,
the in-app agent tool surface, and shared trust/recovery contracts without
creating peers to the accepted P2a authorities.

## Gates

| Gate | Command | Result |
|---|---|---|
| Typecheck | `corepack pnpm typecheck` | PASS |
| Format | `corepack pnpm format` | PASS; all matched files use Prettier style |
| Whitespace | `git diff --check main...34f439c` | PASS; no output |
| Owned paths | `git diff --name-only main...34f439c` | PASS; exactly the eight declared paths |
| Salvage reference | inspect ADR-0006, ADR-0007, and ADR-0010 against `salvage-admission` | PASS; prior trust material is cited as REFERENCE only and no prior artifact lands |
| Authority review | ADRs and map against accepted ADR-0001 through ADR-0005 and the plan | PASS; all five reserved concerns have disjoint named authorities |

## Test it yourself

Read ADR-0006 through ADR-0010 and the extended
`docs/architecture/runtime-authority-map.md`. For each new row, verify that it
has exactly one named authority and that the corresponding document-ownership
row excludes adjacent authorities. Walk the eight P2b checklist items, paying
special attention to human approval versus active-version truth, gateway
mediation versus domain truth, and shared audit evidence versus specialist
ledgers.

No command execution is required for this documentation checkpoint.

## Review evidence

Writer: Codex orchestrator, Critical-tier reasoning.

- Candidate `046aa10` received REVISE from a fresh-naive Codex Critical
  reviewer: the operation gateway wording claimed current authorization,
  recovery could restore the active pointer without re-entering ADR-0006, and
  release approval lacked an atomic single-attempt claim. All findings were
  accepted; four owned documents changed, invalidating that review.
- Final candidate `34f439c` received PASS with no findings from a new
  fresh-naive Codex Critical reviewer.
- Fable max independently returned PASS on the identical unchanged
  `34f439c`, confirming complete coverage, disjoint authorities, approval and
  recovery closure, gateway and agent boundaries, inventory truth, trust
  separation, salvage compliance, and the document-only checkpoint.
- The orchestrator verified the cited prior reference directly at
  `/home/rvham/2rain_erp`, branch `chess`, SHA `668a60b`; no prior-repository
  file was modified or admitted.
- The user reviewed ADR-0006 through ADR-0010, the extended authority map, and
  all three corrected bypasses, then accepted the packet on 2026-07-21.
