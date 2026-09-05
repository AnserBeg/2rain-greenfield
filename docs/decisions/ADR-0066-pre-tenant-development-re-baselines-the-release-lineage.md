# ADR-0066: Pre-tenant development re-baselines the release lineage instead of building transitions

Date: 2026-09-04
Status: accepted (user ruling 2026-09-04; the orchestrator wrote it)
Tier: Critical — it changes how a released storage contract may change during development

## Context

The kernel treats every compiled application release as immutable and every
storage change on a released entity as a planned transition (ADR-0011,
ADR-0047 §5). That is the right contract for a production tenant whose data
the next release must carry. **No production tenant exists.** Every tenant in
this repository is a development or test tenant re-created by `dev:reset` or by
a test fixture.

Measured cost, 2026-08-22 to 2026-09-04: of the eight packets between the
purchase order and the goods receipt, four — `relation-requiredness-relaxation`,
`PUR-2b` (digest versioning), `enum-widen` and the capability-version half of
`posting-kernel-admission` — existed only because the planner refused to change
a released schema and the data it protected was test data. Each cost a Critical
review chain, a migration and Band A evidence. The goods receipt still has no
code. The plan's own §0 forbids exactly this: *"do not create compatibility
projections … provider-transition machinery, or legacy retirement gates when
there is no live authority to protect."*

## Decision

**Until the first production tenant, a storage change on the first-party
application that the planner refuses as a transition is resolved by
re-baselining the release lineage.**

- **Re-baseline** means: reset the development database (`dev:reset`), delete
  `apps/web/release/app.compiled.json`, rebuild it from the authored package so
  the lineage has one entry, and commit that with the change that needed it
  (`git-workflow`, "Pre-tenant re-baseline"). The demo release is treated the
  same way.
- Tests that pin historical lineage entries by count or position
  (`composed-application.test.ts` asserts `applications.length >= 6` and
  `> 3`; the profile and field-kind tests speak of "entries 0-8") are updated
  in the same commit: history-reproduction claims move to synthetic lineage
  fixtures, or are retired until a real lineage exists. A count of history is
  what a re-baseline discards, so it cannot remain a gate.
- **Nothing in the kernel changes.** The planner's refusals stay in code; they
  are correct for a production tenant. The transition elements already built
  (`relaxNotNull`, `widenEnumDomain`) and their tests stay; they are the
  proof the mechanism exists when it is needed. Platform migrations under
  `db/migrations/**` remain an append-only chain, because they hold the
  kernel's own tables and the snapshot regenerator already covers them.
- **The first production tenant** is the first tenant whose data anyone outside
  the team depends on, or the first login issued outside the team, whichever
  comes first. It is declared by a ruling at `docs/execution/rulings/first-tenant.md`.
  From that commit the lineage is append-only again and this ADR's permission
  ends; nothing else in it changes.

## Consequences

- Schema evolution during development costs what it costs in an ordinary
  application: edit the definition, rebuild, reset the dev database.
- A whole class of enabler packets disappears from the critical path. The
  goods receipt widens two enums and moves a version by editing them.
- The transition machinery is exercised only by its own tests until the first
  tenant; a defect in it would surface at the first real transition rather than
  in development. Accepted: the alternative was measured at four Critical
  packets per feature.
- `ADR-0064` (`widenEnumDomain`) remains the transition for post-tenant enum
  widening; this ADR does not supersede it, it defers its use.

## References

- Plan §0 (the decision), §5.11 (kernel evolution rule), §11.6.
- ADR-0011, ADR-0043, ADR-0047 §5, ADR-0061, ADR-0064.
- `docs/execution/program-reviews/2026-09-01-inventory-ledger.md` §C.3.
