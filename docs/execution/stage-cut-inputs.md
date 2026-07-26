# Stage-cut inputs — obligations accumulated before a stage is cut

Purpose: hold obligations that are **binding but not yet ownable**, because the stage that
owns them has not been cut. `current-plan.md` is a churning queue and deletes rows as they
are accepted; this file does not churn. A stage-cut packet (`G6-P0`, `N1-P0`, …) reads its
section here and turns every line into a tracked packet or an explicit deferral with a
reason.

This is what lets [`doctrine-coverage.md`](doctrine-coverage.md) rows move from
`prose-only` to `scheduled`: the legend requires "a named packet/stage will make it so and
that packet is tracked (or seeded) in the ledger." The stage-cut rows are seeded in
`ledger.md`, and their input list is here.

Rule: **nothing is removed from a section until that stage's cut packet has dispositioned
it.** Deferral is recorded, not silent.

---

## G6 — launch customization (ledger row `G6-P0`, seeded `planned`)

Plan §11.9 defines G6's build list. These are additional obligations derived after the plan
was written, each with its source.

### From the expression-kernel work

1. **Position-scoped typed escapes.** The escape is a *body* inside an existing ADR-0012
   position profile, never a new contract. First implementation at the lowest blast radius
   only — derived display field and validation, both pure and scalar-returning.
   ([Lever 2](coverage-strategy-levers.md))
2. **Escape bodies carry declarative provenance** — the formula attempted and the missing
   primitive — enabling the differential check and retirement back to declarative.
   (Lever 2; [ADR-0014](../decisions/ADR-0014-provenance-records.md) kind `substitution`)
3. **Boolean binding positions carry a reason channel**, so guards and visibility can
   explain themselves and a future escape body must supply a reason. *Owned earlier by queue
   row 4*, which builds the family carrying binding-position profiles — listed here only so
   G6 confirms it landed.

### From the realization ladder

4. **Rungs 2, 3 and 4 exist**, not just "compiles" and "blocked". Rung 3 —
   agent-assisted manual step — is the cheapest and needs no sandbox: the step stays a
   compiled confirmation operation while the agent surfaces, pre-fills, routes and batches.
   ([Lever 3](coverage-strategy-levers.md))
5. **Downgrade boundaries**, exactly: the platform's capability claim never moves, and the
   floor holds — never degrade inventory truth, tenant isolation, authorization, or audit
   completeness. (Lever 3; plan §10.2; doctrine #4)
6. **The agent may evaluate what has no authority, never what IS the decision.** The
   tempting shortcut — letting the agent evaluate an uncompilable rule at request time —
   breaks determinism, auditability, release pinning and §15.5.
   ([expression-kernel verdict](debates/expression-kernel-verdict.md))

### From the customization architecture work

7. **Persist the semantic patch lineage**, not only the normalized revision, so a base
   upgrade re-applies declared intent instead of merging outcomes.
   ([ADR-0013](../decisions/ADR-0013-semantic-patch-lineage.md))
8. **One provenance substrate, two kinds** (`intent`, `substitution`) — one store, one
   upgrade scan, one tenant-facing "what is your app working around" surface.
   ([ADR-0014](../decisions/ADR-0014-provenance-records.md))
9. **The merge/rebase packet is framed as patch re-application**, with three-way rebase as
   the fallback for patches that no longer resolve — not the reverse. Extension-points-only
   is rejected for this platform. ([prior-art audit B7](prior-art-failure-modes.md))
10. **LLM-assisted upgrade migration is a proposer only** — usage telemetry and metadata,
    never tenant business records; gated by compile, the tenant's approved scenarios, and
    human approval; never auto-activation.
11. **The builder negotiates the requirement** against existing vocabulary before declaring
    a gap, presenting the alternative *together with its difference*. Extends plan §12.13,
    which covers discovery and disambiguation only.

### From verification

12. **Compiler-derived assertions gate customization candidates**; author-supplied scenarios
    are additive only, never the whole gate. ([audit E1](prior-art-failure-modes.md) — the
    Salesforce 75%-coverage failure shape.)
13. **Shadow candidate rules over historical data** before activation and report the delta
    in business terms. Plan §10.1 already promises shadow verification; this points it at
    the "would this rule have blocked things you did not expect" question.
14. **"Explain this outcome" as a registered diagnostic query**, designed while the rule set
    is still small. ([audit D2](prior-art-failure-modes.md))

### From customization lifecycle

15. **Customization retirement path** — per-field and per-surface usage telemetry, and a
    `deprecated` state in the customization capability set, so accumulated customization can
    be retired safely. ([audit B6](prior-art-failure-modes.md))

---

## N1 — prove whole-module generation (not yet seeded)

1. **Platform-side kernel proliferation tripwire generalised** beyond expressions to query,
   effect, surface, policy and storage. Today's scan points at `packages/domain` and stops a
   *module* growing an engine; the quarry's actual fork was platform code.
2. **§12.14 breadth proofs** — zero query/operation/surface/policy/storage kernel branches
   across four structurally different modules plus a fifth from a different domain.
3. **Self-hosting the capability compiler is earned, never anticipated.** Trigger: the same
   projection hand-written three times identically.
   ([Lever 4](coverage-strategy-levers.md))

---

## N2 — workflow, documents, communication (not yet seeded)

1. **The Tier C runtime envelope exists before the pressure arrives** — grants, resource
   limits, review path, release pinning, rollback, kill switch, revocation. Plan schedules
   Tier C at N7; history puts the first blocked customer nearer here.
   ([audit B5](prior-art-failure-modes.md))
2. **Workflow mutation steps invoke whole Semantic Operations**, never `EffectGraph` nodes;
   compensation is a named correcting operation.
   ([expression-kernel verdict](debates/expression-kernel-verdict.md) V7)

---

## N5 / N7 (not yet seeded)

1. **Per-tenant resource budget.** Query-level limits exist; no per-tenant budget does.
   Add it as an explicit dependency so it is designed rather than discovered during an
   incident. ([audit D4](prior-art-failure-modes.md))
