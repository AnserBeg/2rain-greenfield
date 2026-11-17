# 2026-11-17 — CUSTOMIZE week-6 rehearsal, re-run after review fixes 1-4

Packet: [CUSTOMIZE](../packets/CUSTOMIZE.md). The first result, from before the review fixes, is kept: [2026-11-17-customize-week6-rehearsal](2026-11-17-customize-week6-rehearsal.md). Source: CI run 44145709291 (PR #50, `packet/CUSTOMIZE-s5` at `0c50d6c8`, which contains main `65b91a50` with fixes 1-3 plus fix 4), job "PostgreSQL schema and isolation", `test/postgres/customization-world.test.ts`. Every CI job in that run is green. Merged to main at `19985460`.

## What ran

The same steps as the first result, on the `distributor` seed, with one runtime that is never restarted:

1. Plain-English request for an Equipment record type. CI has no model key, so the drafting model is scripted.
2. Draft, then approve, then activate. Each runs under the release-scope lock and starts by checking that the live activation verified.
3. A first Equipment record is created with no restart.
4. Two AGENT harness tasks pass while the change is live ("Reserve and ship from stock", "Receive a placed purchase order in full").
5. One-step rollback. Two more tasks pass afterwards ("Create and confirm a sales order", "Invoice a shipped order and record full payment").

The same test then runs each review scenario: F1 (a racing rollback; a failed reconcile repaired by a retry), R1 (two concurrent rollbacks on one service whose admin pool has two connections; both finish within a 300 s bound), B1 (a cut-off rollback to first-party followed by a restart: the scopes keep the last verified root and a posting is refused until the kernel verifies), R3 (an interrupted B -> A rollback is repaired before it is refused, and posting works) and R2 (a cut between swap and verification is refused, not reported as activated, until the kernel verifies). B1b is shown by a unit test that pins boot's scope read and write to the lock's connection.

## Result (CI runner)

| step | ms |
|---|---|
| draft (request to plain diff) | 5,000 |
| approve | 38,319 |
| activate | 1,102 |
| first record on the live record type | 799 |
| **request to live record** | **45,220** (bound 600,000) |
| roll back | 2,857 |

Earlier runs of the same measurement, all on CI: before the fixes (run 44077868142), 46,599 / 3,021 ms; after fix 1 (run 44123956334), 46,829 / 3,003 ms; after fix 2 (run 44136022261), 46,959 / 3,009 ms (request to live / roll back).

## Not shown here

- The Customize screen (slice 3) has its own browser journey on `packet/CUSTOMIZE-s3`, integrating next.
- A real-model drafting run in CI (no key in CI by charter).
