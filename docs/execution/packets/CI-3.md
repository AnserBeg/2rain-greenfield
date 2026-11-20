# CI-3 — tiered packet and main CI

Status: awaiting independent pre-merge read. The CI link tests the workflow at `b1fe527d`. The declared head also tests dispatch visibility.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44777281191

## Claims

1. Quick checks quality, security, architecture, unit, compiler and every selected test file. Shared, unknown and Critical changes promote to full.
2. Full requires every producer, the composed replay and every repository test in the same run attempt. Quick verifies the fixed and selected files and names each expected skip.
3. Main pushes queue. The merge-window command closes on red main and requires a full green on the exact proposed integration commit for Critical changes.

## Controls and timing

- The mapped billing change selects two additional files while a planted agent test is broken in the comparison base. [Quick](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44773229358) and [explicit full](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44773217257).
- The [migration-only diff and full reachability control](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44777294642) withholds the agent artifact after quality checks finish. The promotion summary links to the full attempt.
- The [unmapped root file](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44777295892) exercises automatic promotion. The dispatch summary links to the full run.
- [The Customize documentation replay](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44774127523) reproduces all seven paths and blobs in the change accepted at `31c79749`. Use run creation to the completion of reachability for elapsed time including queues.
- Two GitHub pushes three seconds apart use the main policy on an isolated ref, with only the branch matcher changed. [First](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44774534056) and [second](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44774541169).

- Locally, thirteen focused mutations each made its corresponding assertion fail, including removal of the red-main and missing-full refusals from the token command.

- GitHub returned a [404 on the first status read](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44773230084/job/136419749586) after creating the child. The transport check retries the same ID and propagates success, failure or sustained invisibility.

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
  "head": "7d5609c296b41956c8b403b9fcfd4bd41cc4af71",
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
    "test/architecture/ci-tiers.test.ts",
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
