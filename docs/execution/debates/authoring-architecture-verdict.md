# Authoring architecture debate — three-round record (2026-07-27)

Pipeline: `position-v1` -> two independent naive round-1 reviews (Codex `gpt-5.6-sol`
xhigh; Fable max) -> orchestrator adjudication with repository verification ->
`position-v2` -> two independent naive round-2 reviews -> amendment and freeze at
`62470c7` -> `position-v3` -> two independent naive round-3 reviews against that blob.
Every round used fresh spawns with no prior-round context.

**Status after round 3: CONVERGED ON SUBSTANCE, NOT RATIFIED.** Three rounds ran. Round 3's
two independent reviewers both returned REVISE while stating that **no round-2 concept was
reopened** — the remaining work was a reconciliation sweep plus named fixes, all applied in
the follow-up commit. What is outstanding is a **short confirm on that amendment diff**, not
another full round. Ratification is the user's, and has not been given.

Working files: `/home/rvham/debate-authoring-architecture/`.

## The process defect, recorded first because it invalidates part of the evidence

**The documents were amended while round 2 was reviewing them.** The orchestrator applied
Codex's round-2 findings to the working tree while Fable's round-2 review was still running.
Fable observed the diff growing 720 -> 780 -> 804 insertions with the plan checksum changing
three times, and directly observed rules flipping mid-review: the retracted "floor never
ships" claim, §5.13 step 2's trigger, §10.6's headline rule, the F5 obligation count, and
ADR-0015's consequences block.

Consequences: four of Fable's seven questions targeted text that no longer existed;
**third-generation decisions shipped with zero review**; and no acceptance decision has a
fixed referent.

AGENTS.md §4 already binds this for code — "any code change after a review invalidates it:
new SHA, fresh review" — and the orchestrator applied it to code while ignoring it for
governing documents. The gap is real and general: **code packets freeze at an integrated
SHA; plan and ADR amendments freeze at nothing.**

**Standing rule adopted from this debate:** amendments to the plan, ADRs, or execution
authority are committed *before* review is requested, and the review cites the committed
blob. A documentation review against a live working tree is not evidence.

## What round 1 established (both reviewers, independently)

The origin claim verified: `PredicateExpression` admits a boolean literal,
`field OPERATOR literal-scalar` over four operators, and Boolean combinators — no
field-to-field comparison, no arithmetic, no traversal, no aggregation. The runtime fence
is narrower still, admitting only literal `true`.

Defects found and fixed:

| Defect | Resolution |
|---|---|
| F5's admissibility cited ADR-0012's "own dormant checklist" | **Misattribution.** That checklist is the quarry's, quoted in ADR-0012's Evidence with the note that profiles account for the category *without building it*. Citation removed; F5 demoted to a candidate with a contract |
| F5 claimed totality via identity elements | False for `min`/`max`. Per-operator empty semantics now required |
| "declared relation" treated as a cardinality bound | It is not; by that logic every traversal satisfies the ceiling. Declared write-enforced maximum now required |
| §5.13 collapsed §5.11's three-way routing to two | Tier B disposition restored |
| §10.6's loud/silent principle | Fails both directions — tenant defaults fail silently, platform reservation fails loudly. Replaced |
| §10.6 self-contradiction | Forbade tenants owning accumulating figures while permitting tenant configuration to steer them |
| "The floor never ships" | Retracted as unfalsifiable; audit B4 documents escape-first vendors extending declarative layers for a decade after |
| F7 undercounted at two modules | Three: Party, Catalog, Location |

## What round 2 established

Codex and Fable again converged. Findings accepted and applied:

- **The cascade could not reach Tier B for unbuilt capability families.** A published-set
  lookup matches only existing capabilities, so a novel tax requirement found no set, fell
  through, and was admitted into the language — the outcome the section's own preamble
  forbids. Fixed by keying step 3 on §5.9's **family enumeration** first, which exists
  independently of any shipped capability.
- **No realization could perform network work.** Step 1 routed external I/O to a position
  body, which "receives values and cannot fetch." **CONNECTED** added for §12.10's isolated
  services and signed connectors; carrier rating, EDI and e-invoicing are head-sized demand.
- **R1-R5 collided with ADR-0019's recovery tiers.** "R2 latency" was ambiguous between a
  capability metric and a disaster-recovery tier. Realizations are now **named**:
  EXPRESSED / CAPABILITY / LANGUAGE / CONNECTED / EXTENSION / REMAINDER.
- **"Not in the write path" was itself wrong** — validations and guards sit in a write path
  by definition and are legitimately tenant-owned. The operative distinction is **narrowing
  versus producing**, resolved against a published dependency set.
- **"Re-read against locked state" is not a concurrency protocol.** Locking existing child
  rows does not prevent the insert-phantom that changes an aggregate. A named lock authority
  or serializable execution is now required.
- **§5.15's mechanism was a promise, not a structure.** Replaced with a projection: full
  records feed a completeness projector emitting a coverage certificate carrying no
  disposition values, so value-branching is unrepresentable rather than forbidden. Deciding
  actor now required, without which a model auto-fills `deferred` vacuously.
- **ADR-0015's Decision contradicted its own new Consequence** — "every business record
  carries a non-null entity" cannot survive a `tenantShared` ruling. Decision now explicitly
  yields.
- **The published dependency set had no owner.** Invented mid-amendment and load-bearing for
  §5.13, §10.6, §17 and two stage-cut items. Now a G3 obligation.
- **Enforcement text lagged the doctrine it enforces** — §17 encoded two rejected rules,
  stage-cut item 20 taught the insufficient concurrency formulation, and three execution
  documents still carried `R1-R4` and the retracted principles.

  **Correction (round 3): the claim "all reconciled" that stood here was false.** Round 3
  found seven stale sites surviving in the very commit that claimed the sweep, including the
  round-1 misattribution still live in `doctrine-coverage.md`, `R1-R5` and the pre-fix
  lookup-only trigger in the binding G6 stage-cut input, and a §17 stop rule encoding the
  *third* rejected §10.6 formulation. A G6 writer following the stage-cut input would have
  built the round-1 cascade. This is the same propagation failure round 2 identified,
  recurring in the fix for it.

Verified implementation facts that bind the F7 packet: one business key emits **two**
physical unique indexes (`test/postgres/party-runtime.test.ts:104` asserts exactly two), so
a predicate on one leaves the other reserving archived keys; neither storage target carries
a predicate and drift expects `predicate: null`; uniqueness is a field property, not a named
key object; and the materializer folds every unique-key column outside the tenant/environment
scope set, so an unqualified `legal_entity_id` would be routed through folded-column lookup.

## Round 3 (2026-07-27, against frozen `62470c7`)

Both reviewers: **REVISE**, and both stated explicitly that **no round-2 concept was
reopened**. Fable's summary: "the required work is one amendment commit." What was checked
and found sound: the rename decision, CONNECTED's legitimacy under §12.10 and program rule
#5, the family-first fix against a novel-tax probe, narrowing-versus-producing against all
three probes, the §5.15 projection against every constructible content-leak path, the F7
composed target against the real emitter/materializer/tests, and ADR-0015's yield as a
deferral pattern.

Findings applied in the follow-up commit:

| Finding | Fix |
|---|---|
| **The mirror sweep never reached the documents packet writers grep** — seven stale sites inside the commit claiming reconciliation | Swept and verified by grep for each rejected formulation's distinctive phrase |
| **Step 1 preempted the family test for network-shaped demand** — communication delivery is itself a family, so "email on shipment" routed to a one-tenant mechanism, violating §5.12's head/tail rule | Family test now outranks the network test; the two round-2 fixes no longer fight |
| **Composite requirements routed wholly by first match** — "tax via an external provider" is two obligations | Cascade now routes *obligations*, after decomposition |
| **Step 2 routed ambient state and unknown-depth recursion to EXTENSION**, which §5.14 and §12.10 both say it cannot serve | Retargeted to CONNECTED, workflow, or declared gap |
| **§5.9 declares nothing** — both its lists are "such as" and they differ | New **§5.9.1** declares a closed, versioned, §5.11-amendable family list, plus a new-family commissioning outcome and substrate-family recording so demand cannot fall through the list's edge |
| **`legalEntityId` on "every business record" contradicted `tenantShared`** — and "the Decision yields" does not amend the Decision | Decision text, column source, and enforcement bullets all rewritten; stage-cut mirror updated |
| **"reads mandatorily exclude archived records" is refuted by code** — `includeArchived` is caller-reachable, and the F7 contract presupposes it two paragraphs later | Corrected to "by default" |
| **F7's named key object is an authored-surface canonical event**, unstated; and the transition grammar has **no drop/replace index operation**, so a partial index under an existing name is a no-op | Both added to the F7 contract |
| **"Exhaustive by construction" guards only under-declaration** — over-declaration silently annexes tenant territory and nothing requires minimality | Mechanism specified (facade, structural import ban, versioned artifact, traversal validation); minimality recorded as a per-version review obligation |
| **§10.6's recovery carve-out was undefined on membership, trigger, and scope** | Defined on all three; scope covers validations and permission narrowing, not only guards |
| **F5 missing trigger topology and position admission** | Both added |
| **Deciding-actor rationale overclaimed; `deferred` re-offer could itself branch on content** | Actor constrained to a named authority distinct from the authoring system; re-offer declared non-blocking with re-deferral valid |

## Still open

Carried forward after round 3:

1. **Round 3's amendments are themselves unreviewed** — the §5.9.1 family list, the cascade
   reorder and decomposition rule, the recovery-class three-axis definition, and ADR-0015's
   rewritten Decision have had no independent review. A short confirm on the amendment diff
   closes this; a full fourth round is not warranted, because no concept was reopened.
2. **Dependency-set minimality** is unenforceable — the mechanism guards under-declaration only, so over-declaration remains a per-version review obligation.
3. **Entity-grained divestiture** — ADR-0019's manifest and recovery tiers are tenant-grained,
   so carving one legal entity out of a shared tenant, the canonical M&A event, has no
   completeness story.
4. **Per-entity gapless document numbering** — a statutory obligation in many jurisdictions,
   which makes number series entity-scoped keys and connects ADR-0015 to F7's archive scope.
   Nothing links the two decisions.
5. **Mid-history "freely changeable"** blurs into "fixed after first use" unless the text
   says a posted fact *can* depend on it rather than *does*.

## Instruction to packet writers

Read this record for context. Do **not** cite it as ratification, and do not treat §5.12-§5.15,
§10.6, or ADR-0015's amended consequences as settled. The user has not ratified this debate.
