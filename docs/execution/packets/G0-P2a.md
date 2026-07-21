# G0-P2a — Foundational constitutional ADR tranche

Status: active
Tier: Critical

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

## Required gates

- `corepack pnpm typecheck`
- `corepack pnpm format`
- `git diff --check main...HEAD`
- owned-path and authority-map review against plan sections 0-4 and 11.3

## Test it yourself

Read the five ADRs and `docs/architecture/runtime-authority-map.md`. For each
row in the map, verify that the concern has exactly one named authority, its
owning ADR says that authority is exclusive, and no other ADR claims the same
authority. Verify especially that ADR-0005 says DROP and routes the former
framework responsibilities to existing or explicitly deferred authorities.

No command execution is required for this documentation checkpoint.
