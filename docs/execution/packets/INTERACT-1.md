# INTERACT-1 — purchase, receive and sell with fewer clicks

Slice 0 touches zero Critical paths. [PR #88](https://github.com/AnserBeg/2rain-greenfield/pull/88)

## Claims

1. In-place, server-rendered task stages can reach the receiving and shipping scorecard while preserving deliberate confirmation and verified outcomes. [Spike](../evidence/interact-1-spike.md).

## Slices

0. Spike — [test it yourself](../evidence/interact-1-spike.md#test-it-yourself).
1–5. All implementation drafts are committed locally; combined typecheck, focused language tests, release baseline generation and coverage derivation pass. Integration is pending.

## Gates

- Spike `ce29b09e` and refreshed `776a714f` passed full CI, including the measured browser paths and reachability. [CI 44368685795](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44368685795), [CI 44379658761](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44379658761).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1", "packet": "INTERACT-1",
  "base": "c2c12e7f7395900967bfb4d45731d54ce28435a0", "head": "ce29b09e3c74356886ce8ac7d3959bd86d843150",
  "changedPaths": [
    "apps/web/test/browser/loop-scorecard.composed-application.spec.ts", "apps/web/test/browser/loop-scorecard.ts"
  ],
  "symbols": [{"path": "apps/web/test/browser/loop-scorecard.ts", "name": "installTaskStageSpike"}]
}
```

## Test it yourself

- Slice 0. Compare the `INTERACT_SPIKE` rows from the composed application browser job, and check for the tests' receipt and shipment results.
