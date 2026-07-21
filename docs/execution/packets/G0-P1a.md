# G0-P1a — Fresh toolchain and clean-install scaffold

Status: evidence ready
Tier: Mechanical
Frozen candidate: `856f90ca4a1bd1d4d099760dd2da6dc8ad51e4ae`

## Outcome

Established the greenfield-controlled pnpm 11.9.0 and Node 22.22.2 toolchain,
committed lockfile, and minimal TypeScript workspace topology: web, API/process
host, worker, canonical model, compiler, runtime, domain, test contracts, and
developer tooling. The root commands provide formatting, linting, typecheck,
build, unit, integration, and browser-runner coverage.

## Gates

All commands below passed from a separate clean detached checkout of the frozen
candidate after `corepack pnpm install --frozen-lockfile`:

| Gate | Command | Result |
|---|---|---|
| Clean install | `corepack pnpm install --frozen-lockfile --reporter=append-only` | PASS; 10 workspace projects, pnpm 11.9.0 |
| Format | `corepack pnpm format` | PASS |
| Lint | `corepack pnpm lint` | PASS |
| Typecheck | `corepack pnpm typecheck` | PASS |
| Build | `corepack pnpm build` | PASS |
| Tests | `corepack pnpm test` | PASS; unit and integration tests pass, one browser scaffold test is intentionally skipped |
| Scope/whitespace | `git diff --check 22aac79 856f90c` | PASS; all changed paths are owned scaffold paths |

The initial scaffold commit used a nested bare `pnpm` in its root test script,
which resolved the host pnpm 10.33.2 in a clean worktree. The follow-up commit
`856f90c` invokes `corepack pnpm` explicitly; it is the only frozen candidate.

## Test it yourself

```bash
cd /home/rvham/2rain-greenfield-wt/g0-p1a
corepack pnpm install --frozen-lockfile
corepack pnpm format && corepack pnpm lint && corepack pnpm typecheck
corepack pnpm build && corepack pnpm test && corepack pnpm clean
```

Expect every command to pass. The browser runner reports one skipped scaffold
test because product browser journeys are not part of G0-P1a.

## Review evidence

Writer: a Codex `gpt-5.6-sol` high seat was started but made no changes before
its inactive session was stopped; the orchestrator completed this bounded
Mechanical configuration diff directly.

Review: orchestrator self-verification, permitted for Mechanical work. The
clean-install gate, full command suite, final owned-path check, and whitespace
check all ran against `856f90c`.
