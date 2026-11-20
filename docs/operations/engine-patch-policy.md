# Workflow engine patch policy

Status: proposed 2026-11-20 with the WORKFLOW-2 amendments to
[ADR-0073](../decisions/ADR-0073-workflow-isolate-and-authority.md#a5-engine-patch-policy).
It takes effect when the ADR amendment is accepted.

Tenant workflow scripts run in QuickJS compiled to WASM, through
`quickjs-emscripten`, pinned exactly in `packages/postgres-provider/package.json`
(0.32.0 at this writing). A flaw in either could let a script reach the process
that runs it. This note says who watches, how fast we patch, and how unfinished
runs move. It names no vulnerability identifiers; each advisory is read from its
source when it arrives.

## Owner

The **workflow platform owner** is the accountable person. It is a named role,
not a team alias. The name is written in the owner line below when the policy is
accepted, and a change of owner is a one-line edit with a date. A deputy covers
absences. If the owner line is empty, the first engine advisory stops new
workflow activations until it is filled.

Owner: _(to be named at acceptance)_ · Deputy: _(to be named at acceptance)_

## Watch

- Subscribe the owner and deputy to security advisories for the upstream QuickJS
  project and for `quickjs-emscripten`, through GitHub security advisories and
  the package's release feed.
- Keep the repository's dependency audit (`.github/scripts/run-security-scans.sh`)
  as the automatic second net. Add a scheduled weekly run, so a new advisory
  against the pinned versions turns CI red even when nobody changes code.
- Read the upstream changelog at every minor release even without an advisory.

## Deadlines

Count from the day the owner or the audit first sees the advisory.

| Severity (our reading) | Triage | New runs | Patched build merged |
| --- | --- | --- | --- |
| A script can escape the sandbox, corrupt memory, or reach host data | same day | Stop starting new workflow runs within 24 hours until patched or a mitigation is recorded | 7 days |
| A script can exhaust memory or time past our limits, or crash the host | 2 business days | Keep running unless the limit bypass is exploitable by a tenant | 14 days |
| Other defect with a plausible effect on determinism or replay | 2 business days | Keep running | 30 days |
| No effect on our use (feature we do not expose) | 5 business days | Keep running | Next scheduled engine review; record why |

A missed deadline is escalated to the orchestrator and recorded in the ledger.
Stopping new runs means turning off the workflow scheduler and refusing new
workflow activations, not deleting anything.

## A patched build

1. Bump the pin exactly. Treat a change of engine bytes as a change of the
   engine build in every new run's pin.
2. Re-verify every workflow in every active release under the new engine:
   type-check, lint, and the run-twice replay of each fixture. A failure names
   the workflow and fixture and holds the engine bump for that tenant.
3. Ship it through the normal merge and CI path. Never roll the deployed code
   below the patched build once any run has pinned it (the deploy rule).

## Unfinished runs

A run is pinned to the exact engine build it started on, and the host never
silently picks a newer one. When a build is retired for a security reason:

1. Runs pinned to it stop taking steps at once and suspend with the reason
   `engine-retired`. Their evidence and journals stay.
2. **The worker never re-pins a run.** A person moves a run onto the patched
   build through the recorded human Retry that migration 0054 already requires.
   The Retry decision records the old and new build. Before the run resumes, the
   host replays its journal on the patched engine. The same ordered requests must
   come back, with no skipped cursor and no new effect. Any difference
   quarantines the run for inspection, as a divergence does today.
3. An operator may retry or cancel many runs in one action. Each run is judged
   on its own and each result is audited, as for any bulk action.
4. Outstanding approvals follow the existing rule: one not yet committed needs a
   fresh plan and a fresh human decision.
5. A cancelled run keeps its completed effects and evidence.

For a non-security engine update the same steps apply, without the stop and the
deadline. Until every unfinished run has moved or been cancelled, the old build
stays in the retained runtime set only to read journals and reproduce history,
and the fleet's rollback floor includes it
([ADR-0085](../decisions/ADR-0085-platform-upgrades-for-customized-tenants.md),
fleet maxima). A retired build never executes a step.

## Evidence kept

For each advisory: date seen, severity reading, owner, decision, the merged
patch or the recorded reason for none, the date new runs resumed, and the count
of runs moved, cancelled and quarantined. Keep it in the ledger row of the bump.
