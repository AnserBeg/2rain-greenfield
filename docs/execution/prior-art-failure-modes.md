# Prior-art failure modes and our controls

Status: analysis, not authority. Nothing here overrides the plan or an accepted ADR.
Date: 2026-07-25
Position in program: G2 active (Party accepted, PR-1..PR-6 correctives accepted, PR-6b in flight)
Purpose: enumerate every recurring failure mode of prior metadata-driven / model-driven
ERP platforms, and state honestly whether this program addresses it, how, or what to do.

Verdict vocabulary:

| Verdict | Meaning |
|---|---|
| **ADDRESSED** | A named mechanism exists in the plan/ADRs/code and is enforced |
| **PARTIAL** | A mechanism exists but has a known hole, or is designed and not yet proven |
| **NAMED-NOT-DESIGNED** | The plan acknowledges the risk, but the control is a process or a future proof, not a mechanism |
| **GAP** | Not addressed anywhere |

Summary: 15 ADDRESSED, 8 PARTIAL, 3 NAMED-NOT-DESIGNED, 2 GAP. The highest-value actions
are listed at the end.

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
places them ahead of G6. That is the actionable through-line: this program's remaining
prior-art exposure is concentrated almost entirely in the customization layer it has not
built yet.
