# AGENT-SPEED-1 — assistant speed in user-built modules

The host executes personally approved plans and verifies them through the session gateways before the next model turn. [Host PR 116](https://github.com/AnserBeg/2rain-greenfield/pull/116) merged at `54023865` after [CI 44612076361](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44612076361). The false-write test observes a read-back mismatch on two acknowledged edits. The existing CRITFIX-A auto-run snapshot passed.

## Isolated first-party trials

Each row uses the host split with exactly one change. Six first-party tasks (4, 16, 200, 202, 204, 206) ran three times per configuration on the same activated release. The host control was `f4488309` with the isolated source changes from `38ade449`, `8b170ae1` or `333e9a6c`. Configurations rotated within each task and round. Spread is the median within-task median absolute deviation (MAD). Paired changes compare the same task and round against host execution alone.

| Configuration | Card median (s) | Yes to verified (s) | Spread (s) | Paired change / MAD (s) | Pass | USD/task | Decision |
|---|---:|---:|---:|---:|---:|---:|---|
| Host alone | 4.86 | 0.202 | 0.07 | — | 18/18 | 0.0412 | Comparison |
| Model and effort routing | 4.57 | 0.189 | 0.35 | -0.36 / 0.60 | 18/18 | 0.0366 | Keep |
| Parallel reads | 5.32 | 0.191 | 0.28 | +0.04 / 0.44 | 18/18 | 0.0377 | Drop |
| Two-tier map | 5.83 | 0.190 | 0.27 | +1.65 / 0.98 | 18/18 | 0.0416 | Drop |

Routing switched six attempts on two short creates to Sonnet low. Their median paired improvement was 0.86 s (MAD 0.38 s). On the earlier read/create trials Opus high, Opus low and Sonnet low each passed 12/12. Median read seconds were 5.80, 5.83 and 6.89 respectively. Reads and compound requests keep Opus high. An explicit model override keeps high effort.
Parallel reads overlapped on five of 18 attempts. The six-task median rose. The summary map raised median discovery calls before approval from 0.5 to 1.5. It saved characters on 50 custom types (55,482 to 21,863, with 409 for one detail), but cost an extra model turn on simple requests. The release-wide structure cache and per-person filtering stay in use.

## Matched first-party and generated tasks

Each set has four declared shapes (record, link, lines, status), one task per shape and three attempts each. The proof used seed `333e9a6c03ca69c3ab1942ef9defc1817f2b7bee`. The generated prompts stayed outside the tuning set. Each pass requires one approved and verified operation and an independently observed state change. Activation checks declared operations, inputs, discovery and read-back contracts structurally.

| Cohort and version | Card (s) | Yes to verified (s) | Tool calls | Pass | USD/task | Elapsed (s) |
|---|---:|---:|---:|---:|---:|---:|
| First-party, before | 6.23 | 3.28 | 4 | 12/12 | 0.0565 | 10.72 |
| First-party, after | 5.78 | 0.25 | 3.5 | 12/12 | 0.0409 | 7.04 |
| Generated, before | 4.83 | 3.43 | 3 | 12/12 | 0.0432 | 10.46 |
| Generated, after | 4.84 | 0.22 | 3 | 12/12 | 0.0247 | 6.42 |

Times and calls are medians of task medians. The first card includes the screen preamble. Approval ends at the first successful read-back. USD/task includes every attempt. The former pooled card baselines were 4.05 s and 2.89 s. On the original ten the fresh baseline was 14.17 s to card, 3.45 s to verified, 5.5 tools, 10/10 and USD 0.0805/task.

Parity passed. Generated minus first-party was -1.35 s to card and -1.62 s end-to-end. The registered allowances were 0.86 s and 1.45 s, the pooled medians of the eight within-task MADs.
The held-out first-party/generated medians were 7.80/6.45 s to card and 10.02/8.40 s end-to-end. Both cohorts passed 12/12.
The counterbalanced parity repeat passed. Generated minus first-party was -0.93 s to card and -0.62 s end-to-end, with allowances of 0.40 s and 0.50 s.
The table uses a second, counterbalanced comparison on the integrated runtime. Before uses the original model-driven execution and Opus high, after uses host execution and deployed routing. Each attempt starts from a fresh copy of the same release.
The paid trials used the workflow runtime at `6ad7d9fc` and preceded subsequent upstream calculated display, stored-owner authorization and workflow changes. The combined tree ran the scripted acceptance matrix.

The reruling used USD 5.4214 of USD 25. The original investigation used USD 4.4856. [Per-attempt evidence](../evidence/AGENT-SPEED-1.csv). [Provider prices](https://platform.claude.com/docs/en/about-claude/pricing).

Parity split executable changes are covered by [CI 44657855859](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44657855859) at `db0c6f48`.

## Test it yourself

1. Approve an archive in the panel and observe the verified result. Decline another and check the record remains active.
2. Run `node --import tsx --test --test-name-pattern='module parity|measured create route|switching model prices' test/agent/operations-agent.test.ts` for routing, the shared cap and the timing gate.
3. Run `node --import tsx --test --test-name-pattern='an active action must be exposed' test/unit/customization.test.ts`. Removing Item create from discovery must refuse activation.

## Filed

Atomic parent-and-lines creation needs CUSTOMIZE-4 Option A. Recipes depend on WORKFLOW-1 bodies. Habit shortcuts need durable run records. [Freeze filings](../current-plan-archive.md#filed-during-the-freeze).

```record-claim
{"schemaVersion": "northstar.record-claim/v1", "packet": "AGENT-SPEED-1", "base": "5402386557abd00c633b1930724e91e1fe586762", "head": "36b53ff05c634ff124143cf4f298add89a6c3f50", "changedPaths": ["apps/api/src/agent-cli.ts", "apps/api/src/assistant-endpoint.ts", "apps/api/src/composition-root.ts", "packages/operations-agent/src/anthropic-model.ts", "packages/operations-agent/src/index.ts", "packages/operations-agent/src/loop.ts", "packages/postgres-provider/src/composed-application-runtime.ts", "packages/postgres-provider/src/customization-service.ts", "test/agent/agent-world.ts", "test/agent/assistant-endpoint.test.ts", "test/agent/dev-tasks.ts", "test/agent/eval-harness.ts", "test/agent/generated-modules.ts", "test/agent/operations-agent.test.ts", "test/agent/proof-metrics.ts", "test/unit/customization.test.ts"], "symbols": [{"path": "packages/operations-agent/src/anthropic-model.ts", "name": "assistantRoute"}, {"path": "packages/postgres-provider/src/composed-application-runtime.ts", "name": "assertAgentOperationsPlannable"}, {"path": "test/agent/proof-metrics.ts", "name": "measureParity"}]}
```
