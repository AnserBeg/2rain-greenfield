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

### From the publish-path budget

16. **The `publishPath` family gets its numeric objective**, both axes — publisher latency and
    platform exclusion imposed on other tenants — measured against the breadth envelope rather
    than the single-maximal-module point. The envelope itself is startable before G6 and should
    already be a curve by the time this cut runs.
    ([ADR-0020](../decisions/ADR-0020-publish-path-budget-and-verification-integrity.md);
    [audit G7](prior-art-failure-modes.md))
17. **Verification integrity is enforced, not asserted.** Scope narrows only by a sound impact
    analysis derived from the compiled diff, recorded with the candidate. Structural test plus
    a negative control for each of the five forbidden narrowings — sampling, time-boxing,
    author/tenant selection, a skip flag, deferral past activation. This is the same root as
    item 12 above, at the other end: verification that exists to be satisfied rather than to be
    true. (ADR-0020)
18. **Incremental compile, if it ships, is byte-identical to a cold compile**, proven by a
    negative control that perturbs the incremental path. A nearly-identical second path is a
    second compiler. (ADR-0020; doctrine #1; plan §5.7)

### From the primitive floor

19. **Floor items F2-F6 ship before the customization capabilities that depend on them** —
    field-to-field comparison, ordering completeness, to-one relation traversal, bounded
    aggregation over a declared to-many relation, and exact-decimal add/subtract/multiply.
    Plan §10.2's **validation**, **action guard**, and **derived display field** rows cannot
    be called supported without them, because the ordinary business rule is cross-record:
    "not more than ordered", "not before the start date", "not past the credit limit".
    Contract the full semantic space under plan §5.11 step 3 before shipping any slice.
    (Plan §5.12)
20. **Bounded aggregation in a write-time position uses the transaction-bound execution
    target with a *named concurrency protocol*.** "Re-read against locked state" is
    explicitly insufficient — locking the existing child rows does not prevent a concurrent
    insert, which is the phantom that changes the aggregate. The contract names either a
    shared parent/aggregate lock every child mutation must acquire, or serializable
    execution with declared retry behaviour. A preflight-only aggregate is a TOCTOU defect
    in the section 16 concurrency class. (Plan §5.12 F5; ADR-0012 execution targets)
21. **Division stays off the floor** and enters, if at all, through plan §5.11 with a
    declared rounding policy and a total answer for division by zero. Recorded here so it is
    not added as an obvious companion to F6. (Plan §5.12)

### From gap routing and authoring

22. **The realization cascade exists as a mechanism** — EXPRESSED / CAPABILITY / LANGUAGE /
    CONNECTED / EXTENSION / REMAINDER, **named rather than lettered** because ADR-0019 owns
    R1/R2/R3 for recovery tiers. Demand is decomposed into atomic obligations first, then
    each obligation is routed and the results composed; routing a whole request by its first
    matching property sends a composite like "tax through an external provider" wholly to one
    realization. Step 1 is the **family test** (plan §5.9.1's declared list) *before* the
    published-set lookup, and it outranks the network test — several families are themselves
    network-shaped, so a network-first order would fragment communication delivery into
    per-tenant adapters. Step 1's second clause obliges every Tier B contract to **publish
    its authoritative input/output set**. Demand in no listed family that is nonetheless
    specialized and reusable is a **new-family commissioning** outcome, never a fall-through.
    Every CONNECTED, EXTENSION and REMAINDER carries its provenance link.
    (Plan §5.13, §5.9.1; [ADR-0014](../decisions/ADR-0014-provenance-records.md))
23. **CAPABILITY and LANGUAGE latency are instrumented as the headline capability metric** —
    gap report to admitted, admitted to shipped-supported — superseding coverage percentage
    as the number the program steers by. Pairs with the Lever 4 cycle-time baseline. Note
    this file's §G7 uses R1/R2/R3 for ADR-0019 *recovery* tiers; the two namespaces are
    deliberately disjoint. (Plan §5.13 rule 5)
24. **Body density is recorded from the first escape body.** It is the only metric that
    distinguishes a floor-plus-escape system from an escape-only system, since both produce
    the same coverage number. ([Lever 5](coverage-strategy-levers.md))
25. **The evaluator and parity harness is built before the primitives that need it.** A node
    kind is ~20 lines across four files; the harness that proves the server evaluator and
    the SQL lowering agree is the one-time fixed cost, and it is what makes **LANGUAGE**
    additions cheap thereafter. Sequence it ahead of F2-F6 rather than alongside. (Lever 5;
    ADR-0012 parity corpus obligations)
26. **The parity corpus derives from human-decided semantics, never from the model's
    implementation.** A model authoring both its lowering and its own tests produces two
    artifacts that agree and are wrong together. Same spec/implementation/oracle separation
    as scenario approval, one level down. (Lever 5)
27. **The domain reference corpus exists, capability-attached and pinned**, with tiered
    considerations, recorded rationale, prior-art notes, and vocabulary mappings. Reference
    never authority: an entry raises a question and cannot create a requirement or confer
    support. Seed from the quarry's `docs/purchasing-inventory-plan.md` §10-11 under §1.2
    REFERENCE mode. (Plan §5.15)
28. **The authoring path performs no live retrieval**, and a missing corpus entry is
    recorded as a signal — distinguishing a corpus gap in a standard capability from a
    genuinely distinctive tenant requirement. (Plan §5.15)

### From the customization authority boundary

29. **A tenant-authored rule may not produce or mutate a stored fact declared as an
    authoritative input or output of a Tier B capability.** Narrowing whether an operation
    proceeds, and computing non-persisted display values, remain tenant territory — so
    validations and action guards stay tenant-owned even though they sit in a write path.
    This requires each capability version to **publish its dependency set**, which is what
    makes a tenant-authored field default compiler-decidable rather than a judgement call.
    The earlier "loud versus silent failure" formulation is rejected in place: tenant
    defaults fail silently and platform reservation fails loudly. (Plan §10.6)
30. **Every Tier B domain capability declares a typed configuration contract** — named,
    validated, compiler-checked settings with defaults, recorded with the release. A pack
    without dials meets its first legitimate variation as a request for a source change,
    which is §16's customer-fork row. **Owned earlier than G6:** the first Tier B capability
    is G3 inventory posting. (Plan §10.6)

## G3 — inventory truth alpha (dispositioned by G3-P0)

All ten inputs below are assigned to named packets, with first-posting deadline
classifications, in [`packets/G3-P0.md`](packets/G3-P0.md). This source list is
retained so the cut's completeness can be checked against the obligations as
received.

**These are hard-deadline obligations, not a backlog.** Each one closes permanently when the
first movement is posted, because ADR-0007 and plan §7.4 forbid rewriting a posted fact. A G3
packet that posts a movement without them does not create debt; it creates an unrecoverable
condition. Plan §11.6 now carries them as binding prerequisites and the G3 gate proves them.

1. **Every entity family is classified `entityOwned` or `tenantShared`, and `entityOwned`
   families carry a non-null compiler-derived `legalEntityId`.** **The cut rules the
   per-family assignment and the default** — a shared customer or item master across two
   entities is ordinary, so a blanket "every record" reading would force duplicated masters.
   The `legal_entity` master is authored declaratively in Party and every tenant is
   provisioned with exactly one entity. It is a business dimension, **not** a tenancy axis:
   it does not enter the provider ABI's leading key columns or the RLS predicate. Relations
   additionally declare `sameEntity` or `crossEntityAllowed`, because carrying the column on
   both rows does not by itself prevent a cross-entity reference. Requires a
   `northstar.storage-target-payload` version bump.
   ([ADR-0015](../decisions/ADR-0015-legal-entity-business-dimension.md); [audit G2](prior-art-failure-modes.md))
2. **The versioned stock-dimension set exists**, every movement stamps the version it was
   posted under, `unspecified` is a first-class member rather than a null, extension is a
   governed versioned event with a named re-baseline operation, and removal is unsupported.
   ([ADR-0016](../decisions/ADR-0016-stock-identity-dimension-set.md); [audit G1](prior-art-failure-modes.md))
3. **Base unit is immutable once any posted movement references the item**, enforced by
   compiler rule and provider constraint, with the diagnostic naming the binding movement.
   (ADR-0016)
4. **The temporal contract holds**: distinct `effectiveAt`/`recordedAt` with recorded time
   from trusted context and no update path; a tenant-declared IANA zone and business-day
   boundary with no silent UTC default; a per-entity `closedThrough` lock enforced inside the
   posting transaction; and advance and reopen as separate permissioned audited operations.
   ([ADR-0018](../decisions/ADR-0018-temporal-authority.md); [audit G6](prior-art-failure-modes.md))
5. **No read model, projection, index, export or reconciliation discards recorded time**, so
   the ledger stays bitemporally reconstructible. This binds every read-model author from G3
   onward, including projections written for performance. (ADR-0018)
6. **Movements carry no monetary amount**, and no compiled artifact derives one from a
   movement. G3 must not invent a costed movement ahead of G4's receipt-cost capture.
   ([ADR-0017](../decisions/ADR-0017-cost-capture-without-valuation.md); [audit G3](prior-art-failure-modes.md))
7. **Inventory posting publishes its authoritative input/output dependency set** — the
   artifact plan §5.13 step 3 looks up and §10.6's field-default carve-out resolves against.
   It is load-bearing for gap routing, the customization boundary, and §17 enforcement, and
   it has no other owner. Exhaustive by construction: the capability reads and writes only
   through its declared set. Retrofitting it after protocol v1 ships is a version event.
   (Plan §5.13, §10.6)
8. **Inventory posting declares a typed configuration contract** — the first Tier B domain
   capability, and therefore the first test of plan §10.6. Named, validated, compiler-checked
   settings with declared defaults, recorded with the release, covering at minimum
   negative-stock behaviour, reason requirements, approval thresholds, and same-instant
   tie-breaking. Configuration is data the platform validates, never a body and never a
   formula. A capability shipped without dials meets its first legitimate variation as a
   request for a source change. (Plan §10.6)
9. **The tenant completeness manifest exists** — every table in every plane classified
   exactly once as tenant-scoped, naming its tenant column, or tenant-independent with a
   recorded reason, with a verifier that fails closed on an unclassified table and reuses
   ADR-0011's accounted-additive-closure object enumeration. **Not a posting-deadline item**,
   but placed here because it is cheap at roughly ten tables and an archaeology project at a
   hundred, it turns §7.5's promised tenant export from a claim into a provable operation, and
   it is the hardest prerequisite for whichever answer the erasure decision reaches.
   ([ADR-0019](../decisions/ADR-0019-tenant-completeness-and-single-tenant-recovery.md);
   [audit G4](prior-art-failure-modes.md))
10. **Already routed here by earlier reviews, and re-stated so the cut sees one list:**
   movements table partitioned by `(tenant, period)` **from creation**; TigerBeetle-shaped
   two-phase reservation; anchor row as a *derived cache with a proof obligation*; natural-key
   idempotency `(source_type, source_id, source_line, revision, posting_role)`. Note that
   `period` in the partition key is now defined by ADR-0018's tenant business day rather than
   left implicit.

## G4 — purchasing and receiving alpha (not yet seeded)

1. **Goods receipt lines capture actual received unit cost and currency, or an explicit
   absence** — never zero, never null-as-unknown — so a coverage gap is an exact queryable row
   list and N3 valuation is a derivation rather than an archaeology project.
   ([ADR-0017](../decisions/ADR-0017-cost-capture-without-valuation.md); [audit G3](prior-art-failure-modes.md))
2. **`inventory.value` and costed-balance query IDs resolve to `unsupported`** with a named
   required capability, and the agent surfaces the gap as a first-class capability card rather
   than approximating an answer. (ADR-0017; plan §5.5)

## G7 — integrated pilot and release candidate (ledger row `G7-P0`, seeded `planned`)

1. **The three recovery tiers are rehearsed with measured times** — R1 in-band logical
   recovery, R2 governed point-in-time reconciliation, R3 reconstruction into a fresh
   environment — with R2 proven idempotent under interruption and resumption, and the tenant
   completeness manifest verified.
   ([ADR-0019](../decisions/ADR-0019-tenant-completeness-and-single-tenant-recovery.md);
   plan §7.5, §11.10 item 6)
2. **No recovery path writes business rows into a live tenant by direct DML**, proven
   structurally rather than by review, so the "except during recovery" reading of plan §17
   cannot be discovered under incident pressure. (ADR-0019)
3. **The commercial decision on single-tenant recovery**: a published product promise with an
   RTO/RPO, or an operator capability with a best-effort target. R2's tenant write freeze makes
   a hard RTO for it dishonest, so this is a real choice with a recommendation attached, not a
   formality. (ADR-0019)
4. **Agent cost per completed journey** joins §15.6's existing evidence artifact alongside tool
   round trips. Plan §11.10 item 3 already requires agent "latency/cost budgets"; this names the
   unit so the budget is about spend rather than only latency.
   ([audit G10](prior-art-failure-modes.md))
5. **Re-examine X-01's replay fidelity** before the G7 gate depends on it. G0-P6b was accepted
   "with red replay limitations," and the G7 gate requires a ≥50% reduction in median tool round
   trips *against that baseline*. ([audit F4](prior-art-failure-modes.md))

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
