# UPGRADE-2 — platform upgrades for customized companies

**Design checkpoint, 2026-11-20.** Slice 0 merged at `0850ef0b`. Fable 5.2 independently read [ADR-0085](../../decisions/ADR-0085-platform-upgrades-for-customized-tenants.md) at `94b23300` and returned **ACCEPT WITH AMENDMENTS**. The full read is in `/home/rvham/2rain-missions/adr85-read.fable.result.txt`. B1 found an undefined workflow authority ceiling and stranded runs. B2 found a fleet-wide binary, a tip-only draft guard and a wave that one held member could stall.

The amended design is in force except for the policy rows, each **proposed, awaiting the owner's ruling**. The proposal changes ADR-0006's sole-human-authority line, ADR-0081 and plan §10.1. Manual governs all activations today. The next gate is a narrow Fable re-read before code. Build also depends on CUSTOMIZE-3 and WORKFLOW-1. The survival, deploy and legacy-fixture gates precede the first customer.

## Amendments and the slices they gate

| Amendment | Slice | Where to check the decision in ADR-0085 |
| --- | --- | --- |
| A1 (B1) | 2, 3 | **Workflow authority** requires Manual for every workflow and both impact counts. |
| A2 (B2) | 4 | **Rollout waves** targets the installed tip and tests each still-supported old base under the fleet-wide binary. |
| A3 (B2) | 2, 4 | **Rollout waves** admits ordinary drafts against the retained serving base while waiting. |
| A4 (B2) | 3, 4 | **Rollout waves** records exclude/proceed, supersedes unfinished attempts and skips directly from the verified source. |
| A5 | 6 | **Classify a clean upgrade** excludes Tier B/C changes, irreversible transitions, conversions, workflows and changed effective layout digests. |
| A6 | 6 | **Recheck and fall back** returns to Manual on all five triggers and requires fresh opt-in proof. |
| A7 | 6 | **Issue an approval** takes only the upgrade ID and requires isolated evidence, classification and provisioning-root authentication. |
| A8 | 6 | **Notify and roll back** records and notifies each policy activation and requires Manual rollback and re-upgrade. |
| A9 | 4 (limited waves), 6 (proposed principal) | **Authorize a platform rollout operator** binds proofs to start/pause/resume/exclude and limits the interim path to local demo or pilot owner CLI. |
| A10 | 1 | **Slice 1 replay admission** closes the present eight-kind allowlist gap, checks the entire vocabulary and classifies missing admission as a platform defect. |
| A11 | 1 | **Diagnostic codes v1** retires the catch-all and pins the closed code table by test. |
| A12 | 1 | **Diagnostic codes v1** requires all independent conflicts, dependent edits and rule-specific witness failures in one attempt. |
| A13 | 1 (same-surface optional field), 3 (full suite), 6 (policy fixture) | **Upgrade cases and controls** covers every R10 case, immutable patch rows, exact parent and five allowlist-removal controls. |
| A14 | 5 | **Binary admission and rollback window** defines the handshake and absolute floor, external register, required capabilities and rollback-window closure. |
| A15 | 5 | **Forward conversion and the first-tenant switch** covers stored re-read changes, parser retention, stable IDs/order/roots and both reset and CI checks. |
| A16 | 4 | **Rollout waves** limits each view and classifies the platform header and forced-RLS member rows. |
| A17 | 2, 4, 6 | **Human approval of a correction**, dashboard statuses and **Attribute approval** define the replacement key, four additional statuses and all three approval consumers. |
| A18 | 2, 3, 4, 6 | **Proposed approval policy** names the plan lines (N1). The CI gate sets the job/budget and separate fixture (N2–N3). Waves specify mid-wave provisioning (N4), correction caps and attributes AI cost (N5), and the status line reserves only the policy rows (N6). |

## Gates

The original design's 18 hosted jobs passed at `8427011a`. This amendment round is docs-only under the owner's no-rerun rule. The named survival job, admissions and fixtures are future build gates. [Original packet CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44676762151)

## Test it yourself

1. Read **Build order** and **Slice 1 replay admission**. A company with a custom record type must take a compatible upgrade. A base optional field on its re-laid-out surface requires Manual review and zero conflicts.
2. Trace **Workflow authority** and **Upgrade cases and controls**. Even the five-kind happy path requires a person. Find the separate workflow-free policy fixture and the pending status of the proposal.
3. Follow a paused tenant through **Rollout waves**. It can draft on its source, be excluded and skip straight to the next installed tip. Find what its dashboard and the operator may each see.
4. Compare the first-tenant reset and lineage checks with the binary admission check. Find the independent deployment register and the explicit end of the rollback window.
5. Run `scripts/check-records.sh` from the repository root. Expect exit status zero.
