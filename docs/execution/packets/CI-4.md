# CI-4 — full CI at the merge tip, quick CI on docs-only main pushes

Integrated at `34bb574f405794ba3b824af2ada21a4434159abf` from packet tip `fe4ffadbc3bc68fe1fa14665441c154b4a53a206`. Fable requested one fix at `b0d6b947`, and `6ca36211` closes B1 and adopts R1. The targeted check’s two packet-tier findings were ruled ride-alongs on 2026-11-21.

CI tier: full https://github.com/AnserBeg/2rain-greenfield/actions/runs/44911908275

## Claims

1. Main runs quick only for a non-executable, non-Critical push range. Missing push evidence, changes to the Critical definition and intervening executable edits require full.
2. A green quick record cannot clear an earlier failed or pending full run. The merge window reads the reachability job at the push SHA in that run attempt.
3. Packet refs retain selected tests for mapped Critical changes. Shared and unknown changes still promote. Migrations match the shared db/ rule and supply no PostgreSQL test to quick by themselves.
4. Up to three consecutive two-parent merges from current main share the exact full on their final tip. Each second parent needs a keyed review-log row.

## Evidence

- Candidate full run 44911908275 passed on attempt 1 with full reachability for `34bb574f405794ba3b824af2ada21a4434159abf`. The pre-CI-4 merge-window check passed from a clean checkout of main at `6787792c4564dc0757583c043738f8daa59ca76b`.
- The [packet-tip full run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44897474713) also passed on attempt 1.
- `test-results/CI-4/MIGRATION-RULE.patch` passed a dry run against the external `charters/MIGRATION-RULE.md`. The orchestrator owns applying the patch.
- The 2026-11-21 selectors promoted [UPGRADE-2-fixes](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44880635235/job/136775007517) on `.gitleaksignore` and [CUSTOMIZE-5-slice1](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44881203941/job/136776671897) on `apps/web/src/component-registry.ts`. Both came from the fallback.
- At the reviewed tip the ten original CI-4 expected-red controls failed as declared and passed after restoring the implementation. The focused CI tests, TypeScript, lint, record validation and test-inventory check passed locally.
- The broader local hygiene run encountered another lane's PostgreSQL container before the lock fixture's intended refusal. GitHub runs this suite on a fresh runner.
- On train failure, remove the packet owning the failing job, rebuild the remaining merges from current main and test the new tip.

## Fable findings

- B1. Both gates read the docs pathspec from the base commit. Any edit to the pathspec requires full. The regression changes the list and `packages/x.ts` in one commit and checks both decisions.
- R1. Only regular, non-executable Markdown qualifies in the exempt paths. Tests cover TypeScript, shell, JSON, and adding or deleting a Markdown symlink.
- R2. After a red quick on main, each docs-only candidate needs an exact full until a full main push goes green or the original quick passes on rerun.
- R3 (known limit). The health check skips an identifiable pending quick. A later failure affects the next window check.
- R4 (known limit). The cap counts first-parent merges. A merged second parent can bundle packets, and review keyed to that parent omits the integration resolution. Exact full CI covers the resolution.
- R5 (known limit). CI and `check-records.sh` omit `check-review-record.sh`. Enforcing a row per second parent depends on running that script.
- R6 (known limit). Main health sees only listed workflow runs. A skipped or not-yet-listed push is invisible to that check.
- R7 (cost). A single non-Critical executable landing costs two full runs on the same SHA, one on the candidate and one on the main push. Up to three packets share that pair in a train.
- R8 (known limit). GitHub runs the selector and workflow from the pushed commit. A change to either can alter its own classification.

## Filed for the next CI change

- Packet pushes can select quick for Markdown under `docs/` outside the base allowlist. Read the docs allowlist from the base commit in the packet selector.
- Packet pushes can select quick for a Markdown mode change from `100644` to `100755`. Apply the non-executable file-mode check in the packet selector.

## Test it yourself

`node --import tsx --test test/architecture/ci-tiers.test.ts test/architecture/ci-main-push.test.ts` exercises both gates. Run `node test/helpers/expected-red.mjs run --manifest test/evidence/CI-4.expected-red.json` on the clean committed tip for all eleven controls, or append `ci4-docs-policy-self-exemption` for B1 alone.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "CI-4",
  "base": "630e2aa690906af9256c5964c398ba90585515d2",
  "head": "6ca36211504a23148bcf6eaf1924f6826dd7df8f",
  "changedPaths": [
    ".github/scripts/ci-selection.mjs",
    ".github/workflows/ci.yml",
    "AGENTS.md",
    "docs/execution/evidence-on-demand.md",
    "scripts/check-merge-window.mjs",
    "scripts/check-review-record.sh",
    "test/architecture/ci-main-push.test.ts",
    "test/architecture/ci-tiers.test.ts",
    "test/architecture/repository-hygiene.test.ts",
    "test/evidence/CI-4.expected-red.json"
  ],
  "symbols": [
    {
      "path": ".github/scripts/ci-selection.mjs",
      "name": "requiresFull"
    },
    {
      "path": "scripts/check-merge-window.mjs",
      "name": "lastMainConclusion"
    }
  ]
}
```
