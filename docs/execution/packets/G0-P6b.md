# G0-P6b — X-01 baseline replay in a disposable checkout

Status: accepted
Tier: Mechanical
Frozen candidate: `2bd1d232426a2b50afd7ea350ad29e2a08c1e11b`

## Goal and scope

Prove whether the frozen X-01 baseline can be resurrected and installed in a
disposable checkout, then record its reproducibility limits without modifying
the old stack.

Owned paths:

- `docs/execution/baselines/x01-v1-replay.md`
- `docs/execution/packets/G0-P6b.md`
- `docs/execution/ledger.md`
- `learnings.md`

Out of scope: changes to `/home/rvham/2rain_erp`, any baseline rewrite,
dependency or lockfile repair, model evaluation, and all G0-P1 toolchain work.

## Outcome

The frozen tag and source tree resurrect locally, but the old architecture
does not faithfully reproduce as a clean runnable baseline. The precise red
gates and their reproduction commands are in the
[replay characterization](../baselines/x01-v1-replay.md).

## Gates

| Gate | Result |
|---|---|
| Fresh-checkout artifact verifier | RED: one empty result directory is not represented in Git. |
| Source identity | PASS: all non-baseline paths match `668a60b`. |
| Frozen-lockfile installation | RED: pnpm 11.9 reports `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH`. |
| Typecheck after relaxed diagnostic installation | RED before TypeScript: pnpm requires explicit approval of native dependency builds. |

The red results are the deliverable, not failures hidden by this packet. A
relaxed install was run only to characterize the incompatibility; its generated
`pnpm-workspace.yaml` and lockfile mutation remained in the disposable
checkout and were not admitted anywhere.

## Test it yourself

The current disposable checkout is `/home/rvham/2rain_erp-wt/g0-p6b-replay`.
These commands take under ten minutes and intentionally reproduce the two
primary red gates:

```bash
cd /home/rvham/2rain_erp-wt/g0-p6b-replay
bash baselines/x01-v1/verify.sh --integrity
CI=1 corepack pnpm install --frozen-lockfile --reporter=append-only
```

Expect `result directory count mismatch` from the first command and
`ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` from the second. Neither result changes
the frozen source checkout.

## Review evidence

Writer: orchestrator (trivial Mechanical evidence record).

Review: orchestrator self-verification, permitted for Mechanical work. Owned
paths and Markdown whitespace passed on the frozen candidate; the replay
commands above were run against the frozen X-01 tag. The user accepted the
documented red gates as reproducibility findings on 2026-07-21.
