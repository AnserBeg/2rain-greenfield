# Prior-art failure modes and our controls

Status: analysis, not authority. Nothing here overrides the plan or an accepted ADR.
Date: 2026-07-25; **section G added 2026-07-26**
Position in program: G2 active (Party/Catalog/Location accepted, PR-1..PR-6b correctives
accepted, G2-EK1 accepted)
Purpose: enumerate every recurring failure mode of prior metadata-driven / model-driven
ERP platforms, and state honestly whether this program addresses it, how, or what to do.

Verdict vocabulary:

| Verdict | Meaning |
|---|---|
| **ADDRESSED** | A named mechanism exists in the plan/ADRs/code and is enforced |
| **PARTIAL** | A mechanism exists but has a known hole, or is designed and not yet proven |
| **NAMED-NOT-DESIGNED** | The plan acknowledges the risk, but the control is a process or a future proof, not a mechanism |
| **GAP** | Not addressed anywhere |
| **NOT-DIRECTLY-ADDRESSABLE** | No mechanism can close it; only indirect mitigation and a watched signal (E4 only) |

Qualifiers on a verdict — `IN DESIGN, UNPROVEN`, `BY CONSTRUCTION`, `AT THE META LEVEL`,
`UNPROVEN AT BREADTH` — narrow the claim and are part of it. `ADDRESSED IN DESIGN, UNPROVEN`
in particular means a named mechanism exists on paper and no gate executes it yet.

Summary over **45 failure modes**: 27 ADDRESSED, 8 PARTIAL, 5 NAMED-NOT-DESIGNED, 4 GAP,
1 NOT-DIRECTLY-ADDRESSABLE. The highest-value actions are listed at the end.

**Read the ADDRESSED column carefully: 7 of the 27 are `ADDRESSED IN DESIGN, UNPROVEN`** —
a mechanism is decided and written down, and nothing executes yet. Those are ADR-0015 through
ADR-0020 plus C5, all of which get their first real test at G3 or later. Collapsing them into
the same bucket as B1 (banned in five places, enforced today) would overstate the position.

*Count corrected 2026-07-26.* The previous header read "15 ADDRESSED, 8 PARTIAL, 3
NAMED-NOT-DESIGNED, 2 GAP" — 28 items against 34 sections in A-F alone, so it had never
reconciled. The tally above is derived from the verdict line of every section. No verdict
changed as a result; only the arithmetic did.

**Section G was added 2026-07-26** after an independent re-derivation of the prior art found
eleven failure modes sections A-F do not cover. Sections A-F are almost entirely about
*customization architecture*, which is where this program's thinking has been concentrated;
section G is about the **domain model, the operational envelope, and the business**, and
that is where the remaining exposure now sits. Six of the eleven are closed by ADR-0015
through ADR-0020, all ruled the same day: G1, G2, G3 and G6 (the domain-model one-way doors),
then G4 (single-tenant recovery) and G7 (publish-path latency).

**B7 is RESOLVED (2026-07-26)** and no longer the top open item. Its mechanism is decided
by [ADR-0013](../decisions/ADR-0013-semantic-patch-lineage.md): persist the semantic patch
lineage as data-plane, so upgrade is patch re-application rather than outcome merge. The
earlier extension-points-only recommendation in B7 is retracted in place — see the
correction note there. E1's status is also now partly scheduled, via L6 in
`current-plan.md`.

---

## A. Program and sequencing

### A1. Platform before product

**What happened.** The most common death. IBM San Francisco (1997–2000), a reusable
business-object framework, was too abstract and was abandoned. Microsoft LightSwitch
(2011–2016) was discontinued. Countless internal "generic business platform" efforts
produced a framework and no product. The framework is always more interesting than the
product, and the product never ships.

**Verdict: ADDRESSED.** §0 fixes the product path, §2.3 lists launch exclusions, §16's
first risk row names it, G2/G3 walking-slice gates force observable business behavior, and
the packet cadence (AGENTS.md §3) requires every packet to leave the repository runnable
with a "Test it yourself" checkpoint.

**Honest note.** Thirty accepted packets in, the first business entity (Party, G2-P3b)
landed only recently; everything before it was kernel. That is defensible — A2 below is the
symmetric failure and it is worse — but the clock is real. Treat repeated G3 slippage as
the A1 signal, not as a scheduling problem.

### A2. Product before authority

**What happened.** The mirror image: hardcode modules, ship, then try to retrofit a
platform underneath. NetSuite retrofitted SuiteScript; Salesforce retrofitted SFDX and
unlocked packages onto a mutable org-metadata store; ServiceNow retrofitted update sets and
the app repository. All three retrofits are still visibly awkward decades later, because
the hardcoded modules were already the real runtime.

**Verdict: ADDRESSED.** G1 (release kernel, immutable revisions, CAS activation, request
pinning, fail-closed gateways) is **COMPLETE** before any domain breadth. §16 names it as
the second risk row. Doing this in the right order is genuinely uncommon and is the
program's single best structural advantage.

### A3. Services capture

**What happened.** The product never closes the last-20% gap; an implementation-partner
ecosystem closes it per customer, forever, as billable work. Salesforce, ServiceNow and SAP
all run this way. It is not necessarily failure — but the *product* stops improving in the
dimension that matters, and platform economics quietly become services economics.

**Verdict: NAMED-NOT-DESIGNED.** §15.7's productivity gate measures internal
module-building effort (median N1 module effort ≤ one third of the hand-built baseline),
which is the right leading indicator for engineering. There is no equivalent measure of
*customer-side* configuration effort.

**What to do.** From the first real tenant, record configuration hours per go-live
alongside §15.7's engineering hours. If configuration hours do not fall across tenants
2..n, the gap is being closed by labor rather than by the product, and that is visible
years before the P&L shows it.

### A4. Customer-specific forks

**What happened.** One blocked deal, one deadline, one branch — and composability is gone.
This is how vendors end up maintaining N codebases.

**Verdict: PARTIAL.** §16 has the risk row, but its control ("support-cell/gap process and
reusable capability funding") is a process, not a mechanism. §17's stop rule — "the phase
needs customer-specific source branches" — makes it a tripwire. The mechanism that actually
prevents forks is a governed escape hatch existing when the pressure arrives; see **B5**.

---

## B. Customization architecture

### B1. Dual lineage / overlay activation

**What happened.** The clearest settled verdict in the industry. Dynamics AX had exactly
the static-base-plus-overlay layering model (SYS…USR); Microsoft killed overlayering in
D365 F&O and moved to extensions-only. SAP went modifications → enhancement points →
today's "clean core" doctrine. ServiceNow customers still absorb "skipped updates" at every
upgrade, where customized base records shadow the vendor's new ones. Odoo's `_inherit`
chains produce the same pain at major versions.

**Verdict: ADDRESSED, decisively.** Banned in the §1 authority table ("never an
independently active overlay lineage"), doctrine #1/#2, the §1.2 never-transfer list, §10.1
("no second active overlay"), the §16 risk row, and the §17 stop rule ("a second active
metadata/release/overlay authority is introduced"). Enforced in five places. This is a
lesson four vendors paid for and this plan inherited for free.

### B2. Vendor/customer asymmetry

**What happened.** In Salesforce, NetSuite, ServiceNow and Dynamics, the vendor's own
modules are not built from the customer-facing metadata platform. That asymmetry is the
root of twenty years of "why can't I do to Opportunity what I can do to my custom object,"
and — worse — it means the vendor never discovers its primitives are inadequate, because
its own team routes around them. Odoo and ERPNext are the symmetric counterexamples; both
are real existence proofs and both are smaller.

**Verdict: ADDRESSED IN DOCTRINE AND ENFORCED IN CODE; UNPROVEN AT BREADTH.** Doctrine #2,
§5.10's module-artifact ban list, and §12.14's "zero kernel branches" breadth proofs.
Verified today: `validateModuleConformance` runs inside the compiler for every package
revision ([compiler.ts:732](packages/compiler/src/compiler.ts:732)) and first-party Party
carries conformance assertions ([definition.ts:42](packages/domain/src/party/definition.ts:42)),
so the gate applies to first-party modules rather than only generated ones. That is the
correct wiring and it already exists.

**What it means.** The doctrine is real; the *proof* is N1/N2/N4 plus the fifth
non-inventory package. The realistic threat is not a decision to abandon symmetry — it is
convenience: a first-party module acquiring a small handwritten branch "just for now."
The conformance gate is the antibody; keep it in the required matrix as domain breadth
grows.

### B3. The 80% wall

**What happened.** Not the last 20% of features — the last 10% of *every* feature. Nearly
every real requirement is 90% expressible and 10% not, and the 10% is load-bearing, so
modules end up 95% declarative and 100% blocked. Two curves cross: cost per new capability
rises (each must satisfy an ever-wider support matrix) while value per new capability
collapses (remaining demand is Zipfian, each request unlocking a fraction of a percent).
Nobody decides to stop; the roadmap just silently reprioritizes forever.

**Verdict: PARTIAL — best-in-class mitigations, no instrument.** Three real defenses:
Tier B (§12.3) is the middle tier Salesforce never had, betting that the residue clusters
into a few shapes even though each request is unique; symmetry (B2) forces our own team to
hit the wall first; and §2.3's exclusions function as a *variance budget* — the wall's
position depends on domain variance far more than on platform sophistication, so narrowing
the domain moves it further than adding primitives ever will.

**Correction (2026-07-26).** This verdict, and the levers document built on it, both assumed
`p` was already high in the **head** of the distribution and that only the tail remained. A
source-level review of the canonical language found otherwise: the predicate vocabulary is a
boolean literal, `field OPERATOR literal-scalar` over four operators, and and/or/not. No
field-to-field comparison, no arithmetic, no traversal, no aggregation — so
`shippedQuantity > orderedQuantity` is inexpressible, and cross-record validation is the
most common escape reason in the prior art. Those are head items, and Tier B/C are the wrong
instrument for them. Plan **§5.12** now fixes the required floor (F1-F7) with a membership
test, and §17 stops on a floor primitive answered by an escape. The mitigations below remain
correct; they apply *after* the floor, not instead of it.

**What to do.** Program rule #5 already forces every demand into one of four dispositions
(mapped / admitted as capability / routed to Tier C / deferred). Log the disposition with a
date. Deferral rate over time *is* the wall, quantified, with quarters of lead time. No
prior platform had this instrument because none wrote rule #5 down before needing it.

### B4. The expressiveness ratchet

**What happened.** The standard escape from B3 is "make the declarative layer more
expressive," and it always walks the same path: formula → conditional formula → cross-entity
lookup → aggregation → branching → loops. Salesforce went formula fields → Workflow Rules →
Process Builder → Flow, and Flow is now a visual programming language with subflows, fault
paths and its own debugging problem. ServiceNow went UI policies → client scripts →
business rules → script includes, which is just JavaScript. The endpoint of "more
expressive declarative" is always a worse programming language with a worse debugger and no
type system.

**Verdict: PARTIAL.** §5.11's kernel evolution rule is the correct governor: identify the
missing semantic dimension, then decide explicitly whether it belongs in the general
algebra, a domain pack, or the extension tier. That rule is precisely the antidote, because
it forces the routing decision instead of letting the rule language quietly grow. But
nothing yet bounds the Formula IR itself, and no formula code exists in the repository
today.

**What to do.** Ratify the Formula IR's permanent ceiling *before* writing it — total and
terminating, no loops, no operation invocation, bounded traversal depth — as an ADR. Then
future pressure hits a ratified boundary and routes to Tier B/C by design rather than
by argument. This costs one document now and is unwinnable later.

### B5. Escape hatch without an envelope

**What happened.** Every declarative platform that reached real customers grew a code tier
within a few years: Apex, SuiteScript, ServiceNow business rules, Compiere's Java callouts.
Salesforce's decisive advantage was not that Apex existed but that it was *sandboxed from
birth* — governor limits, mandatory test coverage, no filesystem, no threads. The unit of
governance became the runtime envelope, not the authoring surface. Everyone who bolted on a
code hatch without an envelope got the fork problem anyway, with extra steps.

**Verdict: NAMED-NOT-DESIGNED, AND SCHEDULED LATE.** §5.2 reserves identity, versioning and
serialization seams for server WASM and isolated UI extensions. §12.10 (N7) owns the tier,
and §12.14's fourth proof lists exactly the right properties: typed inputs/outputs,
isolation, resource limits, policy, observability, versioning, kill switch, revocation. But
N7 sits after N2–N6 of accumulating demand, and history says the first blocked customer
arrives around N2–N3.

**What to do.** Split Tier C into **contract-and-envelope** and **implementation**. The
serialization seam (§5.2) is the cheap half and is already reserved; the envelope — what an
extension may touch, which grants it needs, what it executes inside, how it is reviewed,
how it pins to a release, what happens on rollback — is the expensive half and the one that
gets skipped under deadline pressure. If the envelope exists as a compiled seam before it
is needed, the first blocked customer becomes a governed extension instead of a fork (A4).

### B6. Customization sprawl with no retirement path

**What happened.** Mature Salesforce and ServiceNow orgs accumulate thousands of fields,
rules and views that nobody dares delete because nobody can prove they are unused. Every
upgrade, migration and compile carries the dead weight. There is no usage telemetry, so
there is no safe deprecation, so accumulation is permanent.

**Verdict: GAP.** The plan has capability-status vocabulary (`unsupported`, `deprecated`,
`internal` at §5.6) and enum-option retirement (§10.2), but nothing about per-customization
usage telemetry, a deprecation workflow for fields/surfaces/views, or revision garbage
collection. AGENTS.md §7's no-hard-delete doctrine — correct for business data — makes
accumulation the default posture everywhere.

**What it means.** Invisible at 5 tenants and 1 year. At 500 tenants and 3 years it is a
dominant support cost and it slows every compile, migration and release diff.

**What to do.** Cheap now, expensive later: the gateways already correlate query and
operation IDs per §15.2, so record per-field and per-surface last-read/last-write
timestamps as a by-product. Separately, add a `deprecated` state to the *customization*
capability set (§10.2) so retirement is expressible before there is anything to retire.

### B7. Base-package upgrade under tenant customization

**What happened.** This is what the overlay systems actually died of. Banning overlays
(B1) does not eliminate the problem — it *relocates* it from runtime overlay resolution to
author-time reconciliation, which is much better but still needs a named mechanism. When
first-party `domain-inventory` ships v2 and a tenant's active revision customized it,
something must reconcile the two. The industry's working answer is extension-points-only:
customizations may attach at declared extension points and may never modify base objects,
so a base version bump cannot collide. That constraint is what makes D365 extensions and
SAP clean core work.

**Verdict: NAMED-NOT-DESIGNED — and this is the most consequential item in this document.**
The plan knows: N3-05 requires "existing-tenant upgrade, rollback/forward-fix and
reconciliation," N6-04 requires "upgrade from existing tenants," and §12.8 REFERENCEs v1
corpus §9.5 on fleet-wide upgrade discipline, noting that tenant count makes a platform
upgrade a fleet event rather than a deploy. So proofs are scheduled and a reference is
pointed at — but no *mechanism* is named. Rebase? Three-way merge of package revisions?
Extension-points-only? Version-pinned base with opt-in adoption?

**Correction (2026-07-26): extension-points-only is the wrong import here.** An earlier
version of this section recommended it. That is the correct answer for the *asymmetric*
platforms above — in Salesforce, SAP and Dynamics the vendor's modules are a different
kind of object than a customer's, so forbidding modification of base costs them nothing
they had. **This platform is symmetric by doctrine #2.** Adopting the restriction would
manufacture the two-tier world B2 exists to prevent: a tenant could do less to Inventory
than to a module they authored themselves. It also contradicts the program's own recorded
direction — `doctrine-coverage.md` already schedules "full package composition/merge and
tenant three-way rebase" with the G6 stage cut owning the packet.

**The collision surface is much smaller here than in the prior art.** What forces a
mandatory update to a running tenant is correctness, security and regulatory behaviour —
and in this architecture that behaviour lives in **Tier B domain packs behind versioned
protocols** (posting, allocation, pricing, tax), which tenants cannot customize anyway.
What tenants customize is declarative structure, which is what least needs to change under
them. New capability is opt-in; language evolution is a recompile handled by version
dispatch. Only structural change to first-party *declarative* definitions genuinely
collides, and it is rare. The prior art suffers worse because those vendors ship code into
objects customers have modified. A path must still exist — you cannot design for *never* —
but it can be narrow and rarely exercised.

**What it means.** The real mechanism is already latent in the plan. §5.6 states that every
authoring channel — first-party engineering, visual builder, conversational AI — emits the
same typed **semantic patches**, which "normalize into a complete desired-state revision
before compilation." So a customization begins life as *declared intent*. If that intent is
retained, upgrade is not a merge at all: it is **re-applying the tenant's patch to base v2
and normalizing**. No three-way diff of outcomes, no conflict adjudication. The only
failure is a patch whose target moved or vanished — enumerable and reportable.

But nothing persists it. §10.1 treats the patch as a pipeline *step*, and G6 item 4
specifies a "draft service with **revision history**" — outcome history, not patch history.
Intent cannot be reconstructed from the revision it produced, after the fact, at scale.

**What to do.** Three things, in this order:

1. **Persist the semantic patch lineage, not only the normalized revision.** A schema
   decision, cheap before the customization canonical model exists and unrecoverable after.
   This is the whole of B7's cost-of-delay.
2. **Frame the scheduled G6 merge/rebase packet as patch re-application**, with three-way
   rebase as the fallback for patches that no longer resolve — not the other way round.
3. **Register LLM-assisted migration as the proposer for the unresolvable residue.**
   Patch re-application handles mechanical cases deterministically; what remains is
   semantic reconciliation, which is judgment. Gated by compile, by the tenant's own
   approved assertion scenarios as the regression oracle, and by human approval, activating
   as a release with rollback. Two hard boundaries: it consumes **usage telemetry and
   metadata only, never tenant business records** (reading business data to author an
   upgrade crosses a classification boundary nothing in the plan permits), and it is a
   **proposer only — never auto-activation**, because the migration is non-deterministic
   and a running business system must not adopt an unreviewed one.

Prove base-version-bump-under-customization at **G6**, not N3.

---

## C. Storage and data

### C1. EAV as the universal storage answer

**What happened.** Salesforce made flex columns plus pivot tables work with a custom query
optimizer and a dedicated performance organization; nobody else has matched it, and even
theirs is not really EAV. Everyone who reached for a universal attribute table hit query
plans they could not fix. The prior repository's own `mt0-*` reports are cited in the plan
as bounding this topology and its indexing pitfalls — so this program has first-hand scar
tissue, not just industry lore.

**Verdict: ADDRESSED.** §5.9's storage algebra, §7.1's four typed layers, the §1.2
never-transfer ban on typed EAV as a universal answer, the §16 "generic JSON business
model" row, and ADR-0011. Already shipped, not merely planned: G2-P2b delivered the
compiler-owned typed materializer, and PR-6 added deterministic per-relation indexes with
forced-RLS `EXPLAIN` conformance that fails closed on an unknown plan node. This is
substantially further ahead than prior art was at the equivalent stage.

### C2. JSON bag as the business-data API

**What happened.** The lazy cousin of C1: store customer data as untyped JSON and lose
types, policy, migration, reporting and search in one move.

**Verdict: ADDRESSED.** §7.1 layer 2 states it directly ("a loose arbitrary JSON bag is not
a business-data API"), reinforced by §5.9's closing bullet and the §16 row.

### C3. External analytics and BI access

**What happened.** Metadata-driven schemas are unreadable to external BI tools — columns
named `value17`, data split across pivot tables. Customers who cannot point their BI tool
at their own data either churn or build shadow extracts, which become E4.

**Verdict: GAP AT LAUNCH, deliberately.** §2.2 includes reports, dashboards, saved views
and exports; connectors are N5. There is no external SQL, replica or warehouse story.

**What it means.** Because storage is real typed tables rather than EAV, the eventual answer
is far cheaper for us than it was for Salesforce — a read replica with per-tenant views is
plausible rather than fantastical.

**What to do.** Nothing structural now. One cheap constraint: keep generated storage's
physical column names human-legible so a future replica view is a projection rather than a
translation layer. The compiler already carries `physicalName` and `sourceColumn` through
[storage.ts](packages/compiler/src/storage.ts:1037); confirm the naming policy is legible
by intent and record it, before generated Tier-A entities exist to rename.

### C4. Search and indexing over dynamic fields

**What happened.** Declared-at-runtime fields defeat statically planned indexes; search
becomes either unindexed or a separate engine with its own consistency problem.

**Verdict: PARTIAL, and already live.** Field-level search/report status is in the canonical
model (§5.1) and §7.5 requires search-index rebuild in recovery. Concretely, the PR-6
debate established that under `FORCE ROW LEVEL SECURITY` a `fold(col) LIKE '%…%'` predicate
is not index-servable because `textlike` is not leakproof — so substring search is currently
unindexed by construction, and the folded-column work moved to PR-6b. This concern is being
worked with evidence rather than assumed away, which is the right state for it.

### C5. Derived truth at scale

**What happened.** Computing balances from movements is correct and eventually too slow.
SAP kept aggregate tables beside line-item documents for decades, then removed them in
S/4HANA once hardware allowed computing from the universal journal. Everyone adds
materialization, and then materialization *correctness* becomes the new defect source.

**Verdict: ADDRESSED IN DESIGN, UNPROVEN.** §15.5 requires registered materialization/cache
strategies with ledger reconciliation; §14.3 makes "rebuilding projections does not change
answers" a permanent property; §14.2's read-model row requires reconciliation to canonical
facts plus rebuild plus UI/report/agent parity. That is exactly the right control set. It
gets its first real test at G3.

### C6. Concurrency in posting and allocation

**What happened.** Oversell, over-receive, double-post. The classic inventory defect class;
every WMS and ERP carries scar tissue.

**Verdict: ADDRESSED IN DESIGN, PARTIALLY PROVEN.** §7.3's one-transaction command contract
with idempotency keys and optimistic preconditions, §14.2's concurrency row, §14.3's "no
valid interleaving violates receipt, reservation, shipment, or negative stock limits," the
§16 row, and the §17 stop rule. PR-5 already shipped durable O0 idempotency at the correct
key scope across all four layers that carried the old scope — and its round-1 review caught
mixed-case UUIDs splitting the advisory lock, which is precisely this defect class found by
process rather than by a customer.

---

## D. Runtime and interface

### D1. Generic write APIs leak

**What happened.** OData (Microsoft and SAP) succeeded technically for reads and leaked
badly for business operations. The durable pattern is named, registered, versioned domain
operations — SAP's BAPIs are literally that, and they are the part of SAP's integration
surface that aged well. Reads generalize; writes do not.

**Verdict: ADDRESSED.** The O0/O1/O2/O3 tiering in §5.9 encodes the earned lesson directly,
supported by §16's "incorrect specialization" row and the §17 stop rule "a domain-specific
invariant is being approximated by generic CRUD/rules."

### D2. Debuggability of compiled and generated systems

**What happened.** The dominant support cost in every metadata platform. "Why did this
field become read-only, why did this validation fire, why did this record not appear" has
no stack trace that means anything, so support engineers read metadata by hand. It scales
with tenant count multiplied by customization depth.

**Verdict: PARTIAL — excellent raw material, no instrument.** §15.2 correlates request →
tenant/environment/release → query/operation ID and handler version → audit/change/event →
verification result. §9.2.2's result envelope carries provenance, freshness and unsupported
diagnostics. §5.8 mentions per-property provenance and authored-meaning-versus-derived-fact.
§15.4 says a missing diagnostic is a product capability gap. What does not exist is a named
capability that takes an outcome plus a release and returns the chain of compiled rules that
caused it.

**What it means.** Support cost grows superlinearly once customization ships, and the agent
inherits the problem — it cannot explain a denial it cannot trace, which undermines the
"perform and explain those operations" half of the product mission (§2).

**What to do.** Make "explain this outcome" a first-class registered diagnostic query at
G6, when the rule set is still small, fed by the correlation data §15.2 already requires.
Nearly free then; a rewrite later.

### D3. Generated-UI rigidity

**What happened.** Generated screens look generated. Customers reject them, the vendor adds
bespoke screens, and the generated path stops being dogfooded and rots — the UI-layer
version of B2.

**Verdict: ADDRESSED, unusually well.** §8.5–8.6's binding UX grammar (archetype kinds,
named slots, status roles, navigation budget) plus §14.2's surface-grammar row, which
includes compact-projection journeys, a **bespoke-screen scan**, and skill-doc pinning. The
`ux-grammar` skill has been pinned in CI since G1-P8. Designing the grammar before the
screens and then scanning for escapes is the antidote almost nobody applies in time.

### D4. Multi-tenant resource isolation

**What happened.** Salesforce governor limits exist because one customer's loop consumed
shared capacity. Every multi-tenant platform eventually needs per-tenant budgets, and
every one of them added them after an incident.

**Verdict: PARTIAL / DEFERRED-KNOWN.** Q0/Q1 carries cardinality and byte/time limits
(§5.9), §15.5 pushes bulk work to the worker rather than per-record requests, and §12.14
requires resource limits for Tier C extensions. There is no per-tenant resource budget.

**What to do.** Nothing structural at launch scale. Add "per-tenant resource budget" as an
explicit dependency on N5/N7 so it is designed rather than discovered during an incident.

### D5. Request-time interpretation overhead

**What happened.** Interpreting metadata per request is slow; Salesforce and ServiceNow
both built extensive caching layers to compensate for a design that read definitions at
runtime.

**Verdict: ADDRESSED BY CONSTRUCTION.** §15.5's opening bullets: compilation occurs before
activation, requests consume immutable prepared artifacts, release artifacts cache by
content hash while authorization and state stay live, and query dispatch resolves from
canonical ID directly to a prepared handler. This is the retrofit prior art needed, present
from the start.

---

## E. Trust, verification, and operations

### E1. Verification gates get gamed

**What happened.** Salesforce's mandatory 75% Apex coverage for production deploys is the
most famous forced-verification mechanism in the industry, and it produced an industry-wide
supply of assertion-free tests. The failure is structural, not cultural: the author writes
the assertions.

**Verdict: ADDRESSED AT THE META LEVEL, UNDESIGNED IN-PRODUCT.** AGENTS.md §6 is genuinely
rigorous about *our* gates — observe the fact rather than a proxy, one recorded negative
control per vacuity vector, and no verifier sharing a code path with the thing that heals
what it verifies. PR-4/PR-4b applied exactly that doctrine to reachability. §14.5 forbids
the implementer redefining a gate after seeing results. But inside the *product*, §5.1's
assertion-scenario objects are authored by the same party authoring the package — a tenant
author writes both the customization and the assertions that verify it. That is the
Salesforce failure reproduced one level down.

**What to do.** When customization ships (G6), require that the assertions gating a
candidate be **compiler-derived** — from types, constraints, state machines and policy —
and that author-supplied assertions are strictly additive, never the whole gate. Put this
in the customization ADR, because it is the difference between a verification gate and a
coverage ritual.

### E2. Per-tenant configuration combinatorics

**What happened.** Every tenant is a different application. The vendor cannot regression-test
the product against N customer configurations, so upgrades break customers in ways no vendor
test could have caught. This is the mechanical reason B7 hurts so much in practice.

**Verdict: ADDRESSED — and this is the plan's most underrated win.** Because each package
revision compiles to a release carrying *generated* assertions (§5.10 item 10) and candidate
verification runs before activation (§10.1, §14.2 customization row), each tenant's
configuration verifies itself at publish time. The vendor does not need foreknowledge of the
configuration. Almost nobody has this, because almost nobody compiles.

### E3. Go-live data migration

**What happened.** Not an architecture failure — the reason ERP *implementations* fail.
Opening balances, open purchase orders, partial receipts and in-flight reservations are the
hard part, and they collide with append-only truth: an opening balance must itself be a
posted movement with a distinguishable origin, or the ledger starts life lying.

**Verdict: PARTIAL, appropriately scoped.** §1 assumes a one-time governed import rather
than continuous synchronization; G2-P8 covers server-validated durable item/location import
with dry run, row diagnostics and result artifact; §11.10 covers opening-data import with
dry run, diagnostics and backup-before-import.

**What to do.** Confirm at **G3**, when the movement model is designed, that opening
balances and in-flight documents are expressible as posted movements with a distinguishable
origin classification — not at G7 when the pilot discovers it.

### E4. The spreadsheet shadow system

**What happened.** The universal escape hatch, and for this product the most dangerous one:
a spreadsheet that becomes a peer source of truth outside posted movements is precisely
what doctrine #4 exists to prevent. You can ban the editable balance column; you cannot ban
Excel.

**Verdict: NOT DIRECTLY ADDRESSABLE — mitigate indirectly.** The counters are capability
coverage, honest export/import round-trips, and an agent that makes asking the system
cheaper than extracting to a spreadsheet.

**What to do.** At the G7 pilot, treat "what are people exporting and re-keying" as a
first-class product signal. It is the most precise available map of the last-20% gap, drawn
by users in production rather than guessed at in planning.

### E5. Recovery when the definition is also data

**What happened.** Restoring an ERP is straightforward; restoring one whose application
definition, active-release pointer and business data must be mutually consistent at a single
point in time is not. Platforms that versioned data but not definition discovered this
during their first real restore.

**Verdict: ADDRESSED.** §7.5 requires restoring the active release pointer and immutable
package revisions alongside the data, plus derived-read-model reconstruction, outbox replay
or reconciliation, tenant export, and measured RTO/RPO proven in a drill before launch.
That is a more complete recovery definition than most vendors publish.

### E6. Rename and identity instability

**What happened.** Systems that keyed on labels, routes or table names ossified: renaming
anything broke integrations and reports, so nothing was ever renamed.

**Verdict: ADDRESSED.** §5.1 — "Stable IDs never derive from labels, routes, table names,
or physical action files." §5.9 — query and operation contracts do not expose table names
or storage class. §7.1 — promotion from generated to dedicated storage preserves canonical
identity and contracts.

---

## F. The AI layer (the newest generation)

### F1. Agent bolted onto a non-semantic backend

**What happened.** 2023–2026: Agentforce, Now Assist, D365 Copilot, Joule. Several started
with agent-specific backends and converged on reusing the same service layer the UI uses —
by retreat, after drift between what the agent could see and what the UI could do.

**Verdict: ADDRESSED BY CONSTRUCTION.** §4.1's flow makes the agent and SurfaceRuntime peer
clients of the same gateways from the same pinned `RequestRuntimeView`; ADR-0008/0009 fix
it; §17 makes any bypass of Semantic Operations a stop condition. We arrive where the
vendors ended up, by design rather than retreat.

### F2. Tool explosion and context cost

**What happened.** Agent context grows with module count until it is expensive and
unreliable — the reason "just add a tool per module" fails at the fifth module.

**Verdict: ADDRESSED, with binding numeric gates.** Five business tool schemas fixed at G1
and adding fixture modules must not increase the count; G3 requires bulk model interaction
constant with target cardinality; N1 requires base tool schemas and context within 10% of
G7 as generated modules are added. Quantifying this in advance is rare.

### F3. Agent over-authority

**What happened.** The failures of 2024–2026 were open-ended agents with broad write access.
What survived is narrow, tool-constrained, human-confirmed action with read-back.

**Verdict: ADDRESSED.** Doctrine #11, §9.2.5's prohibited paths, ADR-0009, no
self-activation (§10.1), and plan/confirm/execute/verify. PR-3 already shipped
**server-issued fully bound confirmation**, which is what makes this structural rather than
a prompt-level promise.

### F4. Evaluation debt

**What happened.** Agent regressions are silent without a versioned corpus and a frozen
baseline. Teams ship on demos and learn about regressions from customers.

**Verdict: ADDRESSED, with one honest caveat.** §14.4's versioned eval set includes
ambiguity, refusal, stale release, duplicate execution, correction-versus-deletion, and
cross-tenant prompt injection and exfiltration. §15.6 froze the X-01 comparative baseline
during G0 while the prior environment still ran, and §15.8 forbids a benchmark change from
erasing a poor result.

**Caveat.** G0-P6b was accepted "with red replay limitations," so the baseline is weaker
than designed. The G7 gate requires a ≥50% reduction in median tool round trips *against
that baseline*. Re-examine X-01's replay fidelity before G7 depends on it, not during G7.

### F5. Model dependency

**What happened.** Products that route core workflows through a model stop working when the
model is slow, unavailable or silently changed.

**Verdict: ADDRESSED.** §15.5's closing bullet: a slow or unavailable model cannot prevent
authorized users from operating normal UI, query and operation paths. The agent is a lane,
not the only lane (§9.1).

### F6. The agent as a cross-tenant confused deputy

**What happened.** Prompt injection turning an agent with legitimate credentials into an
exfiltration path is the defining new vulnerability class of this generation.

**Verdict: ADDRESSED.** §7.2 is unambiguous: tenant identity comes from authenticated
request context, "never from model output, browser form data, query arguments, or custom
code." The agent passes the same policy gateway as every other caller, and §14.4 carries
adversarial cross-tenant eval cases. G0-P4b proved trusted context with two-tenant and
pool-reuse isolation.

---

---

## G. Domain model, operational envelope, and business (added 2026-07-26)

Sections A-F ask "will the customization architecture survive contact with customers." Section
G asks three different questions: is the **business model** shaped so it can grow, can the
**operational envelope** survive a real incident, and is there a **company** around the
product. Prior art dies of all three at least as often as it dies of overlay resolution.

### G1. The ledger grain is a one-way door

**What happened.** Every inventory system eventually adds lot, serial, expiry, bin or
quality status. Each one is a new member of the key that names a bucket of stock. Systems
that hardcoded `(item, location)` into their balance logic discovered that adding a
dimension meant either a history rewrite they could not perform or a permanent untracked
era that every report, recall and audit had to special-case forever. The same trap catches
unit of measure: change an item's base unit after postings exist and every historical
quantity silently changes meaning.

This is not an exotic failure. It is the normal way a v1 inventory system becomes
unextendable, and it is invisible until the extension is attempted.

**Verdict: ADDRESSED IN DESIGN, UNPROVEN.** [ADR-0016](../decisions/ADR-0016-stock-identity-dimension-set.md)
makes stock identity a declared versioned dimension set, stamps every posted movement with
the version it was posted under, makes `unspecified` a first-class member rather than a null,
and requires a named re-baseline operation for extension. Base-unit immutability once any
movement exists is a compiler rule plus a provider constraint. Plan §6.3, §6.4 invariants
16-17, §11.6 prerequisites and gate, §12.6, §14.3, §16 and §17 carry it.

**What remains.** It is design. G3 must land it *before* the first posted movement, and the
gate's replay property — adding a dimension reproduces byte-identical prior balances — is
the proof.

### G2. No legal-entity dimension

**What happened.** Almost every business that outgrows one company runs two, and every ERP
that shipped with a single implicit company had to retrofit an organizational dimension into
a schema whose keys were already frozen. Compiere/iDempiere carried `AD_Client`/`AD_Org` from
the start and could grow; systems that did not, could not.

Before this ruling the words "legal entity" and "company" appeared **zero times** in the plan.
Tenant and environment were the only scoping axes.

**Verdict: ADDRESSED IN DESIGN, UNPROVEN.** [ADR-0015](../decisions/ADR-0015-legal-entity-business-dimension.md)
puts `legalEntityId` on every business record from creation as a compiler-derived system
column. The load-bearing ruling is that it is a **business** dimension, not a second tenancy
axis: it does not enter `northstar.postgresql-module-provider-abi/v1`'s leading key columns
or the RLS predicate, because cross-entity consolidated reporting is an ordinary authorized
requirement that an isolation boundary would forbid by construction. Freeze F, the PR-6
relation indexes and the PR-6b folded columns are untouched.

**What remains.** Enforcement by entity is policy narrowing, which depends on the
identity/policy kernel — presently an allow-all stub (queue row 9). Until that lands, entity
is recorded and queryable but not enforceable, and the ADR says so rather than implying
otherwise.

### G3. Discarding the inputs to valuation

**What happened.** The distinction between "we do not compute stock value" and "we do not
retain the inputs to stock value" is one that plans routinely fail to make. Perpetual
valuation needs the actual cost at which each receipt entered stock; the purchase-order price
is not a substitute, because partial receipts, substitutions, price corrections and supplier
credits all move it. A receipt that posts without capturing actual cost destroys the input
permanently.

The consequence is **E4 in its most predictable form**. "What is my stock worth" is among the
first questions an owner asks. An unanswerable question becomes a spreadsheet, and the
spreadsheet becomes the peer source of truth doctrine #4 exists to prevent. The audit
previously treated E4 as unaddressable in general while the plan itself created the specific
trigger.

**Verdict: ADDRESSED IN DESIGN, UNPROVEN.** [ADR-0017](../decisions/ADR-0017-cost-capture-without-valuation.md):
capture the inputs, compute nothing. Receipt lines carry actual received unit cost or an
**explicit absence** — never zero, never null-as-unknown — so a coverage gap is a queryable
row list. Movements carry no monetary amount; cost is reached through the source-document
lineage ADR-0007 already guarantees. `inventory.value` resolves to `unsupported` and the agent
surfaces it as a capability gap rather than approximating it.

**What remains.** The obligation sits at G4, where goods receipt lives. G3 must not invent a
costed movement in the meantime.

### G4. Per-tenant point-in-time restore in a shared database

**What happened.** Shared-schema multi-tenancy makes single-tenant recovery nearly impossible,
and every vendor discovers this during a real customer incident rather than in design.
Salesforce retired its Data Recovery Service on 31 July 2020 — $10,000, six-plus weeks, and
results that were not reliably complete — then reversed course and replaced it with a
product. ServiceNow customers hit the same wall.

**Verdict: ADDRESSED IN DESIGN, UNPROVEN** (was GAP; closed 2026-07-26 by
[ADR-0019](../decisions/ADR-0019-tenant-completeness-and-single-tenant-recovery.md)).

Plan §7.5's original list — encrypted backups, PITR, isolated-environment restore, tenant
export, read-model and search-index reconstruction, outbox replay, release-pointer
restoration, measured RTO/RPO — was entirely whole-cluster. The topology made the obvious fix
unavailable: pooled shared tables plus no-hard-delete plus append-only trust facts mean a
restore cannot be expressed as delete-and-replay.

ADR-0019 answers in two parts. The **tenant completeness manifest** classifies every table in
every plane exactly once as tenant-scoped or tenant-independent, with a verifier that fails
closed — the same shape as ADR-0011's accounted additive closure, applied to tenancy. Cheap at
ten tables, an archaeology project at a hundred, and the shared prerequisite for tenant export,
single-tenant recovery, and whatever G5's erasure debate decides. **Three named recovery
tiers** follow: R1 in-band logical recovery through the ordinary operation algebra, which
serves most incidents; R2 governed point-in-time reconciliation via isolated PITR and
compensating operations under a write freeze; and R3 reconstruction into a fresh environment.

The binding prohibition is that **no recovery path writes business rows into a live tenant by
direct DML**, which removes the "except during recovery" reading of §17 that would otherwise
be discovered under incident pressure.

**What remains.** It is design; the G7 recovery drill proves it. Two limits are recorded rather
than papered over: R2 requires a tenant write freeze, so a hard RTO for it would be dishonest;
and because posted facts cannot be edited, R2 is forward motion — the customer's bad Tuesday
and its correction both stay in history forever. Whether single-tenant recovery is a published
product promise remains a G7/G8 commercial decision.

### G5. Erasure versus append-only

**What happened.** Append-only trust substrates and data-subject erasure rights are in direct
tension, and the tension is not resolvable by policy. Crypto-shredding — per-subject key,
delete the key — is the industry's standard answer and it changes the storage model.

**Verdict: NAMED-NOT-DESIGNED.** Tracked as `prose-only` in
[`doctrine-coverage.md`](doctrine-coverage.md) and as pending plan-level decision 1, raised
independently by two external reviews, with the `DROP SCHEMA` escape already eliminated by
debate. It was absent from this audit until now, which understated the program's real
exposure: it is a potential launch blocker in EU jurisdictions, not a hygiene item.

### G6. Temporal ambiguity

**What happened.** Four questions hide inside "closed periods if enabled": what backdating may
do, what "a day" means for a tenant spanning time zones, what enforces a period close and
whether it can be reopened, and whether the system can ever reproduce what a report said last
Tuesday. The last is the trap — read models keyed only on effective time make every prior
report unexplainable the moment a backdated posting lands, and the information needed to
recover that ability was never stored.

**Verdict: ADDRESSED IN DESIGN, UNPROVEN.** [ADR-0018](../decisions/ADR-0018-temporal-authority.md)
separates `effectiveAt` from `recordedAt` with recorded time sourced from trusted context and
never editable, requires the tenant to declare a time zone and business-day boundary, makes
the period lock an enforced posting precondition inside the transaction with distinct advance
and reopen operations, and — the actual cost-of-delay item — forbids any read model,
projection, index, export or reconciliation from discarding recorded time, so the ledger stays
bitemporally reconstructible even though launch ships as-of-effective reads only.

**What remains.** The no-discard rule binds every read-model author from G3 onward, including
projections written for performance. It is a real constraint on materialization work.

### G7. Compile-and-verify latency as customization accumulates

**What happened.** D5 correctly claims request-time interpretation is solved by construction.
The other half of the prior art's pain is *publish* time: Dynamics 365 F&O full builds run for
hours; Salesforce deploys are throttled by mandatory synchronous compile and test execution,
to the point that the documented workaround is to disable synchronous compile and accept
runtime errors instead. Slow publish throttles the customization loop, which is the product.

**Verdict: ADDRESSED IN DESIGN, UNPROVEN** (was PARTIAL; closed 2026-07-26 by
[ADR-0020](../decisions/ADR-0020-publish-path-budget-and-verification-integrity.md)).

The architecture carries the same mechanism — normalize the whole desired state, compile
atomically, run generated assertions and provider conformance before activation — so cost
scales with total application size rather than with the change.
[`compiler-slos.md`](../operations/compiler-slos.md) had a real, gated ≤5,000 ms cold full
compile, but at the Freeze A maximum-field envelope under **one** module, entity and storage
mapping, with incremental compile reserved and cold-only and preview untargeted.

ADR-0020 makes three rulings. **The budgeted unit is the publish path, not the compiler** —
accepted draft through compile, verification, preparation and activation, with human wait
reported and excluded, because optimizing compile to five seconds while the path takes minutes
is exactly the prior art's mistake. **A second axis is budgeted separately**: PR-6c established
that a deferred-family transaction holds the platform-wide materializer key for the whole
rewrite, so one tenant's publish can fail every other tenant's `prepare` with
`MIGRATION_LOCK_TIMEOUT` — a quantity whose remedy is online DDL strategy, never a faster
compiler. And **the breadth envelope** — a curve across N modules rather than one maximal
module — is startable now, because "triggered by measured need" requires a trend and a baseline
never started cannot be reconstructed.

**The load-bearing clause is verification integrity.** Scope narrows only by a sound impact
analysis derived from the compiled diff, recorded with the candidate; never by sampling,
time-boxing, author selection, a skip flag, or deferral past activation. A budget miss is
remedied by incremental compile, memoization, or an honestly slower budget — never by weakening
verification. This is **E1's root at the other end**: Salesforce's 75% coverage ritual and its
disable-synchronous-compile guidance are the same failure, verification that exists to be
satisfied rather than to be true.

**What remains.** The breadth envelope is a recorded curve, not yet a gate; G6 sets the numeric
objective when a preview and a real authoring flow exist to measure. The 2,000 ms exclusion
trigger is still procedural — `runtime-slos.md` records that nothing in the activation path
consumes rehearsal evidence — and should become a coded admission input when the
online-strategy packet lands.

### G8. The policy kernel is a stub while every module declares permissions

**What happened.** Not a prior-art failure so much as a live inconsistency worth naming here,
because several verdicts in sections D-F lean on it.

**Verdict: NAMED-NOT-DESIGNED.** `CurrentPolicyGateway` and `AuthenticateRequest` are
well-designed deny-capable ports whose only implementations are allow-all stubs; every module
declares `permissionId`s that nothing evaluates; plan §13 has no work-package ID for
identity/roles/policy. Tracked as `prose-only` in `doctrine-coverage.md`, pending decision 4,
and queue row 9.

**What it means for this audit.** F3 (agent over-authority) and F6 (confused deputy) are graded
ADDRESSED on the strength of doctrine, ADR-0009 and PR-3's server-issued bound confirmation —
all real — but the policy gateway those paths consult currently says yes to everything. The
verdicts are about *structure*, and the structure is right; they are not yet claims about
runtime behaviour. G2's entity-narrowing depends on the same kernel.

### G9. Distribution, not architecture, is what usually kills the vendor

**What happened.** The most common cause of death for a new ERP vendor is not a design defect.
ERP is bought on references, vertical fit and channel, with long cycles, and the consistent
finding across post-mortems is that selection turns on how many companies of the buyer's size
and operational profile the vendor has already implemented. Compiere had this architecture in
1999 and died of a licensing and community-governance dispute that forked it twice. NetSuite
survived a decade of losses because Larry Ellison funded it personally. Odoo and ERPNext
survived on open-source distribution rather than product superiority.

**Verdict: GAP — and structurally invisible to this document.** Every instrument in this
repository measures engineering. Nothing measures whether anyone will buy it.

**What to do.** Nothing in the plan; this is not a plan concern. But the tracked
[documentation-debt](documentation-debt.md) "living risk register" is the right home, and this
belongs in it as a first-class row alongside the architectural risks. A2's structural advantage
buys nothing if the company does not reach a second customer.

### G10. Agent unit economics

**What happened.** The newest failure mode, and too new for post-mortems: an agent-first product
whose marginal inference cost per business transaction exceeds its marginal revenue per seat.
Gartner's projection that over 40% of agentic AI projects will be scrapped by 2027 is largely
an operationalization and ROI finding, not a capability one.

**Verdict: GAP.** Section F grades the agent's *architecture* thoroughly — five fixed tools,
constant context with module count, bounded discovery, numeric gates at G1/G3/N1. All of that
bounds context *size*. Nothing anywhere bounds or measures **cost per completed operation**,
and §15.6's comparative benchmark measures tool round trips, which is a proxy for latency, not
for spend.

**What to do.** §15.6 already instruments runs. Record cost per completed journey alongside
round trips in the same evidence, from the first agent packet. It is one more field in an
artifact that already exists, and it is the number that decides whether the agent is a feature
or the product.

### G11. Symmetry and a late escape hatch compound

**What happened.** Sections B2 and B5 are graded separately, and the interaction between them
is the thing that actually bit the symmetric prior art.

Symmetry (doctrine #2) means the platform's expressiveness ceiling **is the product's
ceiling** — you cannot ship a first-party feature the platform cannot express. That is exactly
the discipline that makes symmetry valuable, and it is why B2 is graded ADDRESSED. But it also
means every capability gap is load-bearing for the vendor's own roadmap, not just for
customers, and the only relief valve is Tier B/C. Tier C is scheduled at **N7**, after
N2-N6 of accumulating pressure.

Odoo and ERPNext are the symmetric existence proofs, and both stayed mid-market. B2 notes they
are "smaller" without asking why. This is a substantial part of why.

**Verdict: PARTIAL — the components are graded, the interaction is not.** B5's recommendation —
split the Tier C **envelope** from its implementation and build the envelope early — is the
correct mitigation and this makes it more urgent, not less: under symmetry the first blocked
party is the vendor's own team, which arrives well before the first blocked customer.

---

## The five things worth acting on

Ranked by cost-of-delay, not by severity.

1. ~~**B7 — name the base-upgrade-under-customization mechanism now.**~~ **DONE, and the
   original recommendation was wrong.** Extension-points-only is the answer for asymmetric
   platforms and would have manufactured the two-tier world doctrine #2 forbids. Decided
   instead by [ADR-0013](../decisions/ADR-0013-semantic-patch-lineage.md): persist the
   semantic patch lineage, data-plane not canonical, so upgrade re-applies declared intent
   to the new base. Implementation is owned by the G6 customization stage cut; tracked
   `prose-only` in `doctrine-coverage.md` until then.
2. **B5 — split Tier C's envelope from Tier C's implementation.** The envelope is what
   turns the first blocked customer into a governed extension instead of a fork.
3. **E1 — compiler-derived assertions, author assertions additive only.** One sentence in
   the customization ADR is the difference between a real gate and Salesforce's 75% ritual.
4. **D2 — "explain this outcome" as a registered diagnostic query, designed at G6.**
   Nearly free while the rule set is small; the dominant support cost if deferred.
5. **B3 + A3 — instrument the two leading indicators.** Rule-#5 disposition rates and
   per-tenant configuration hours. Both are cheap logging, and both give quarters of warning
   before the trend is otherwise visible.

Items 2–4 are all cheapest *before* the customization canonical model is authored, which
places them ahead of G6.

### Revised through-line (2026-07-26)

The original closing claim — that remaining exposure is "concentrated almost entirely in the
customization layer" — **was wrong, because sections A-F only looked there.** Section G
relocates it. The current ranking by cost-of-delay is:

1. ~~**G1, G2, G3, G6 — the one-way doors in the domain model.**~~ **CLOSED 2026-07-26** by
   ADR-0015 through ADR-0018. All four shut permanently the moment the first movement is
   posted, which makes them the only items on this page with a hard deadline rather than a
   rising cost. G3's stage cut owns landing them *before* the posting service, and
   [`stage-cut-inputs.md`](stage-cut-inputs.md) §G3 carries the obligations.
2. ~~**G4 — single-tenant recovery.**~~ **CLOSED 2026-07-26** by ADR-0019. The mechanism and
   its honest limits are decided; the **tenant completeness manifest** is the part with a real
   cost of delay and belongs to the G3 cut, not to G7, because it is cheap at ten tables and
   an archaeology project at a hundred. The commercial promise decision stays at G7/G8.
3. ~~**G7 — publish-path latency.**~~ **CLOSED 2026-07-26** by ADR-0020, with one live
   obligation: the **breadth envelope** is startable now and is the only piece that decays,
   since "triggered by measured need" requires a curve nobody is yet recording.
4. **B5 / G11 — the Tier C envelope.** Promoted by G11: under symmetry the first blocked
   party is our own team, so this arrives earlier than "the first blocked customer" implies.
   This is now the highest-ranked genuinely open item.
5. **E1, D2 — compiler-derived assertions and "explain this outcome",** both cheapest before
   the customization model is authored. E1 shares its root with G7's verification-integrity
   clause: verification that exists to be satisfied rather than to be true.
6. **G10, B3, A3 — the three cheap instruments.** Agent cost per completed journey,
   rule-#5 disposition rates, per-tenant configuration hours. All three are logging, and all
   three give quarters of warning.

**G5 (erasure) is not ranked here** because it is not an engineering cost curve — it is a
binary jurisdictional gate that either blocks an EU launch or does not. It belongs to the
pending plan-level decision, not to this ordering.

**G9 (distribution) belongs in the risk register, not here.** No amount of architectural work
retires it, and this document has no instrument that can see it.
