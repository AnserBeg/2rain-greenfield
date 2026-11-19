# WORKFLOW-1 — goods receipt inspection workflow

Status — N2-00 docs-only checkpoint over `8b61740a`. Fable 5.2 approved the direction with changes. The orchestrator returns the amended ADR to Fable before implementation.

## Claims

1. A receipt occurrence binds the verified active release when consumed. An activation watermark excludes old receipts. Rollback preserves existing run history and prevents pending old receipts from starting new runs.
2. Each run pins its release, body, engine, host and SDK. Stale runs suspend for a human retry or cancellation. Divergent replay quarantines the run.
3. Every committed effect has a stable idempotency key and a recoverable receipt. Timers and event waits are durable. Stale approval plans cannot dispatch or revive after rollback.
4. The candidate verifier requires lint and run-twice evidence for workflow-bearing releases. No-workflow package, release and verification evidence bytes stay identical.
5. For a receipt of item X, generated Tier A create links a pending inspection to the receipt. If it has not passed after two days, the run requests approval to escalate. Use a simpler tenant record type until CUSTOMIZE-4 lands.

## Decisions

- [ADR-0073](../../decisions/ADR-0073-workflow-isolate-and-authority.md) selects `quickjs-emscripten@0.32.0` with fixed host-owned WASM memory and a worker-thread watchdog.
- Every Tier B operation, reachable intersection with a published Tier B dependency, or unknown input/effect intersection requires exact human confirmation.
- The consumer enumerates provisioned tenant/environments, claims outbox IDs once under scoped RLS and takes its activation watermark in the successful verification transaction.
- A stale-pin posting refusal is suspension evidence outside the replay results. Gate N2 checks a same-pin finish after the original release is restored and a human retries.
- Current-release retry on a different release creates a linked successor and checks the committed effect prefix. Uncommitted approvals expire with their fence and require fresh confirmation.
- An immutable body blob carries code and fixtures by digest. `saveWorkflow` stays below the 64 KiB patch limit and replays through UPGRADE-1. The 1 MiB source-bundle limit covers code and fixtures.
- The single forward migration follows CUSTOMIZE-4 (expected 0035). Its number and reader floor are assigned at merge. Code rollback must honor every tenant's newest used parser or reader floor.

## Gates

- The 2026-11-18 bakeoff observed ambient isolation, one dispatch, heap limits and cooperative interruption in both guests. Emscripten additionally exposed fixed imported linear memory. The temporary npm audit reported zero vulnerabilities. The supervising watchdog and repository security scans are implementation gates.
- Implementation requires the exact verifier scope ruling in the ADR. This checkpoint changes docs only. No Critical paths changed.
- Future gates exercise crashes at effect boundaries, timer and event-wait restart, deduplicated retry, stale approval and active-release refusal, worker pre-emption, refused grants and ambient APIs, and one receipt-to-approval browser journey.
- The full N2 proof still needs documents and templates, business-object-linked communication and consent, and email with connector delivery and reconciliation.

## Test it yourself

Run `scripts/check-records.sh`. Follow the [bakeoff reproduction](../../decisions/ADR-0073-workflow-isolate-and-authority.md#reproduce-the-bakeoff) in a temporary directory and expect both probes to pass, with the imported memory cap available in Emscripten. In the ADR, follow one receipt that commits before a rollback but is consumed after it and one run that already started before rollback. The first has a pre-activation disposition. The second retains its pin and waits for a person to retry or cancel.
