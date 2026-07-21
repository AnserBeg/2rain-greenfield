---
name: salvage-admission
description: How code, tests, and designs from the prior repository enter
  this one. Read before porting, re-expressing, or referencing anything from
  /home/rvham/2rain_erp. Nothing crosses over unaudited.
---

# Salvage admission

The prior repository (`/home/rvham/2rain_erp`, branch `chess`) is a
design-and-evidence quarry, never a runtime dependency. Plan section 1.2 is
the binding contract; this skill is its procedure.

## Three modes

- **PORT** — code adapted into this repo. Requires an admission record
  (below) at the stage that consumes it. A port that fails its admission
  conditions is rejected, not patched silently.
- **RE-EXPRESS** — a prior test suite used as the behavioral specification,
  rewritten against new contracts. Assertions may be strengthened or
  consciously retired with a recorded reason; never silently weakened.
- **REFERENCE** — designs, spike reports, and rulings consulted and cited in
  ADRs; the artifact never lands here. "The v1 corpus" = the prior repo's
  `docs/canonical-erp-platform-replatform-plan.md`, cited by section number.

## The admission record (required for every PORT)

Exemplar: prior repo
`docs/replatform/d01-p02-current-base-admission-final-2026-07-20.md`.
Write one per port into `docs/decisions/salvage/`, containing:

1. source (exact path/branch/SHA in the prior repo) and target stage/packet;
2. verified evidence (what was tested there, what was not — be honest about
   gaps like typecheck failures or unexercised paths);
3. KEEP / REWRITE / REJECT tables with a reason per row;
4. invariants that must survive the port, numbered;
5. known defects that must NOT carry (named exactly);
6. gates the ported result must pass here;
7. rollback: what removal looks like before integration.

## Never transfer, in any mode

- the static-metadata + overlay dual lineage;
- the deployment-global activation pointer;
- one-physical-action-file-per-tool architecture;
- typed EAV as a universal storage answer;
- the multi-framework agent stack;
- mission reports, probe scripts, dev databases, generated analysis output.

## Where the per-stage salvage map lives

The plan's "Salvage inputs" blocks (per stage) and section 9.6 name the
exact prior-repo assets each stage consults. Do not invent new salvage
outside those blocks without adding it there first.
