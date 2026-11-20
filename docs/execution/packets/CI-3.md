# CI-3 — tiered packet and main CI

Status: independent read REVISE at `e07f0fc9` (B1 red-main deadlock, N1 serialized main, N2 decision records). All three are fixed; integration full run and controls pending.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44777281191

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
- Two GitHub pushes three seconds apart use the main policy on an isolated ref, with only the branch matcher changed. [First](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44774534056) and [second](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44774541169).

- Local controls made the assertions fail independently when the red-main or missing-full refusal, dispatch status retry, or doctrine-only token exemption was removed.

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
