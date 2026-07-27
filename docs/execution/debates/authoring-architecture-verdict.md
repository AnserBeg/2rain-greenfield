# Authoring architecture debate — round-2 record (2026-07-27)

Pipeline: `position-v1` -> two independent naive round-1 reviews (Codex `gpt-5.6-sol`
xhigh; Fable max) -> orchestrator adjudication with repository verification ->
`position-v2` -> two independent naive round-2 reviews (fresh spawns, no round-1 context).

**Status: NOT CONVERGED. Round 3 is required, and this record is not ratification.**
Both round-2 reviewers returned REVISE with substantive new findings, and a process defect
described below means several decisions in the current text have never been reviewed by
anyone. Packet writers may read this for context; they may not treat it as settled.

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
  documents still carried `R1-R4` and the retracted principles. All reconciled.

Verified implementation facts that bind the F7 packet: one business key emits **two**
physical unique indexes (`test/postgres/party-runtime.test.ts:104` asserts exactly two), so
a predicate on one leaves the other reserving archived keys; neither storage target carries
a predicate and drift expects `predicate: null`; uniqueness is a field property, not a named
key object; and the materializer folds every unique-key column outside the tenant/environment
scope set, so an unqualified `legal_entity_id` would be routed through folded-column lookup.

## Open for round 3

Not applied, and the reason each is deferred rather than decided:

1. **Every amendment in this round is itself unreviewed.** The naming change, CONNECTED, the
   family-enumeration fix, the narrowing-versus-producing rule, and the dependency-set
   obligation have had zero independent review.
2. **Exhaustive-by-construction dependency sets** are asserted; no mechanism is specified.
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
