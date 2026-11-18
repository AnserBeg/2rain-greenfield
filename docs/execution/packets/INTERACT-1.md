# INTERACT-1 — purchase, receive and sell with fewer clicks

Slice 0 touches zero Critical paths. [PR #88](https://github.com/AnserBeg/2rain-greenfield/pull/88)

## Claims

1. In-place, server-rendered task stages can reach the receiving and shipping scorecard while preserving deliberate confirmation and verified outcomes. [Spike](../evidence/interact-1-spike.md).

## Decisions

- A CI browser failure at zero seconds is fixed by canonicalizing the test fill, preserving the instant and assertions; one-browser reproduction passed under the exclusive lock.
- Normal worktree git metadata is still read-only; isolated metadata in `/tmp` tracks work in the chartered source directory.

## Slices

0. Spike — merged `b218bf03`, PR #88, CI 44393050211; [test it yourself](../evidence/interact-1-spike.md#test-it-yourself).
1–5. All implementation drafts are committed locally; combined typecheck, focused language tests, release baseline generation and coverage derivation pass. Integration is pending.

## Gates

- Spike `ce29b09e` and refreshed `776a714f` passed full CI, including the measured browser paths and reachability. [CI 44368685795](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44368685795), [CI 44379658761](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44379658761).

- Integrated candidate includes the browser test bridge. [CI 44386300951](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44386300951) was red only on that exact-minute fill and its dependent final gate; [CI 44393050211](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44393050211) passed all 16 jobs.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "INTERACT-1",
  "base": "d33ca17fa3b21034075ab838fb37847fa166ef8f",
  "head": "b8e7aa5e9c0fc0a77bdece703af673c3ca5850b6",
  "changedPaths": [
    "apps/web/test/browser/loop-scorecard.composed-application.spec.ts",
    "apps/web/test/browser/loop-scorecard.ts",
    "apps/web/test/browser/sale-fulfillment.composed-application.spec.ts"
  ],
  "symbols": [
    {
      "path": "apps/web/test/browser/loop-scorecard.ts",
      "name": "installTaskStageSpike"
    }
  ]
}
```

## Test it yourself

- Slice 0. Compare the `INTERACT_SPIKE` rows from the composed application browser job, and check for the tests' receipt and shipment results.
