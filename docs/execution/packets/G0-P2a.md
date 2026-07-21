# G0-P2a — Foundational constitutional ADR tranche

Status: accepted
Tier: Critical
Frozen candidate: `5a3f96c80ea931cfc39aa4af2648f45282bf279f`

## Goal and scope

Make the platform's foundational authorities explicit before runtime code can
create competing sources of truth. This tranche decides canonical
package/release authority, modular-monolith dependency direction, PostgreSQL
as the launch provider, trusted request context, and the formal
`@agent-native/core` disposition. It also provides a one-owner authority map.

Owned paths:

- `docs/decisions/ADR-0001-canonical-package-and-release-authority.md`
- `docs/decisions/ADR-0002-modular-monolith-and-dependency-direction.md`
- `docs/decisions/ADR-0003-postgresql-launch-provider.md`
- `docs/decisions/ADR-0004-trusted-request-context.md`
- `docs/decisions/ADR-0005-drop-agent-native-core.md`
- `docs/architecture/runtime-authority-map.md`
- `docs/execution/packets/G0-P2a.md`
- `docs/execution/ledger.md`

Out of scope: runtime or dependency changes; the boundary checker; PostgreSQL
harness; and the append-only inventory, semantic gateway, human activation,
agent tool, and lifecycle/trust ADRs reserved for G0-P2b.

## Outcome

Five accepted ADRs now assign the foundational application, release,
deployment, storage-provider, trusted-context, and authorization authorities.
The authority map makes their ownership boundaries inspectable and records
`@agent-native/core` as DROP with no replacement framework authority.

## Gates

| Gate | Command | Result |
|---|---|---|
| Typecheck | `corepack pnpm typecheck` | PASS |
| Format | `corepack pnpm format` | PASS; all matched files use Prettier style |
| Whitespace | `git diff --check main...5a3f96c` | PASS; no output |
| Owned paths | `git diff --name-only main...5a3f96c` | PASS; exactly the eight declared paths |
| Framework dependency absence | search manifests, lockfile, apps, and packages for `@agent-native/core` | PASS; no matches |
| Authority review | ADRs and map against plan sections 0-4 and 11.3 | PASS; one owner per P2a runtime concern and no duplicated authority |

## Test it yourself

Read the five ADRs and `docs/architecture/runtime-authority-map.md`. For each
row in the map, verify that the concern has exactly one named authority, its
owning ADR says that authority is exclusive, and no other ADR claims the same
authority. Verify especially that ADR-0005 says DROP and routes the former
framework responsibilities to existing or explicitly deferred authorities.

No command execution is required for this documentation checkpoint.

## Review evidence

Writer: Codex orchestrator, Critical-tier reasoning.

- Candidate `9522987` received REVISE from a fresh-naive Codex Critical
  reviewer: `RequestRuntimeView` was mislabeled as compiled-projection
  authority, and the framework row implied a replacement umbrella authority.
  Both findings were accepted; the map alone changed, invalidating that review.
- Final candidate `5a3f96c` received PASS with no findings from a new
  fresh-naive Codex Critical reviewer.
- Fable max independently returned PASS on the identical unchanged
  `5a3f96c`, confirming plan supremacy, disjoint authorities, request-context
  separation, the PostgreSQL boundary, the framework DROP, enforceability, and
  the G0-P2b scope reservation.
- The user reviewed all five ADRs and the authority map and accepted the packet
  on 2026-07-21.
