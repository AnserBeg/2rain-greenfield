# CI-3 — tiered packet and main CI

Status: merged at `2e9942b8` after the independent read's REVISE at `e07f0fc9` (B1 red-main deadlock, N1 serialized main, N2 decision records); all three are fixed and the GitHub controls are complete. The full run below tested integration `4afa17dd`, which differs from the merged commit only by main's docs-only WORKFLOW-2 commits `fdffb89d` and `1f6c5ee7`.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44817252075

## Claims

1. Quick checks quality, security, architecture, unit, compiler and every selected test file. Shared, unknown and Critical changes promote to full.
2. Full requires every producer, the composed replay and every repository test in the same run attempt. Quick verifies the fixed and selected files and names each expected skip.
3. Every main push runs full in its own concurrency group, in parallel; none is cancelled or held behind another. The merge-window command requires a full green on the exact proposed integration commit for Critical changes and whenever the latest completed main run is red or cancelled, so a fix or revert can still land.
4. A decision record edit selects `test/integration/trust-substrate.test.ts`, which reads ADR-0010.

## Controls and timing

- The mapped billing change selects two additional files while a planted agent test is broken in the comparison base. [Quick](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44773229358) and [explicit full](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44773217257).
- The [migration-only diff and full reachability control](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44777294642) withholds the agent artifact after quality checks finish. The promotion summary links to the full attempt.
- The [unmapped root file](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44777295892) exercises automatic promotion. The dispatch summary links to the full run.
- [The Customize documentation replay](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44774127523) reproduces all seven paths and blobs in the change accepted at `31c79749`. Use run creation to the completion of reachability for elapsed time including queues.
- Three GitHub pushes two seconds apart use the main policy on an isolated ref, with only the branch matcher changed: [first](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44788711857), [second](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44788716685) and [third](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44788722149). They were created at 18:00:48, 18:00:50 and 18:00:52Z and their first jobs started at 18:21:30, 18:23:38 and 18:24:06Z. Their last jobs finished at 19:23:04, 19:23:08 and 19:33:29Z, so all three were executing jobs together from 18:24:06Z to 19:23:04Z. Each is attempt 1 and concluded success, with 25 successful jobs and the promotion job skipped. None was cancelled or held.

- Local controls made the assertions fail independently when the red-main or missing-full refusal, dispatch status retry, or doctrine-only token exemption was removed.

- GitHub returned a [404 on the first status read](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44773230084/job/136419749586) after creating the child. The transport check retries the same ID and propagates success, failure or sustained invisibility.

- The integration full run 44788639976 on `4b13bf2e` was green except the Customization rules browser runner. That job hit its 20-minute limit after Chromium took 12.0 minutes to install. Its green durations on main on 2026-11-20 were 7.2 to 17.9 minutes, with a median of 9.1 (runs 44695527059 to 44792438982 plus 44772964755 and 44784440585). The slowest was 17.9 minutes in 44710878757, including 7.5 minutes of Chromium install against the usual 0.3 to 0.7. The slow install is a recurring tail, so this job's limit is raised to 30 minutes, the observed maximum plus about half. No other limit changes.

## Decisions

- The run title is fixed when GitHub receives the event. A promoted quick request dispatches a named full run on the original tree and propagates its conclusion.
- The Critical pathspecs live in AGENTS.md. CI and the merge token read the accepted base version. Embedded RLS/grant SQL is checked on both sides of a change.
- The token command replaces the lane's manual token read. The orchestrator owns the external MIGRATION-RULE.md edit. Stop before integration for the independent sol read.

## Test it yourself

Run `node --import tsx --test test/architecture/ci-tiers.test.ts test/architecture/test-reachability.test.ts`. Expect the path mapping, exact-SHA token, missing-file and stale-attempt controls to pass. [Commands and record format](../evidence-on-demand.md#packet-and-main-ci).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CI-3",
  "base": "032b87c00df3ee22184685050b9cecc01c62cc59",
  "head": "811820bf392ec6865fe734f03c6990656c5fd061",
  "changedPaths": [
    ".github/scripts/check-ci-results.mjs",
    ".github/scripts/ci-selection.mjs",
    ".github/scripts/report-ci-timings.mjs",
    ".github/scripts/run-quick-node.mjs",
    ".github/workflows/ci.yml",
    "AGENTS.md",
    "apps/web/playwright.quick.config.ts",
    "docs/execution/evidence-on-demand.md",
    "docs/execution/packets/CI-2.md",
    "scripts/check-merge-window.mjs",
    "scripts/check-record-ci-tier.mjs",
    "scripts/check-records.sh",
    "scripts/non-executable-pathspec.json",
    "test/architecture/ci-tiers.test.ts",
    "test/architecture/record-claim-fidelity.ts",
    "test/architecture/repository-hygiene.test.ts",
    "test/architecture/test-reachability.test.ts",
    "test/helpers/check-reachability.ts",
    "test/helpers/quick-ci.ts",
    "test/helpers/quick-files.ts",
    "test/helpers/reachability-evidence.ts",
    "test/helpers/reachability-producers.ts",
    "test/integration/observability-ci-contract.test.ts"
  ],
  "symbols": [
    {
      "path": ".github/scripts/ci-selection.mjs",
      "name": "selectRange"
    },
    {
      "path": "scripts/check-merge-window.mjs",
      "name": "exactFull"
    }
  ]
}
```
