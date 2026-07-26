# Doctrine coverage map

Purpose: enumerate every binding rule in this program, the instrument that
holds it, how it is enforced today, and the exact packet or stage that makes
it executable. The point is to guarantee that no binding concern stays merely
prose — that "binding in the plan" always has a scheduled path to "fails CI if
violated."

This will complement the planned capability-support matrix (which will track
*product capabilities*); that missing document is recorded in
[`documentation-debt.md`](documentation-debt.md). This map tracks *doctrine
enforcement*. Update it whenever an ADR, skill, or plan section adds or
promotes a binding rule.

## Status legend

- `enforced` — an executable gate/test exists now, or an orchestrator-followed
  skill governs it now.
- `scheduled` — binding, not yet executable, but a named packet/stage will make
  it so and that packet is tracked (or seeded) in the ledger.
- `partially enforced` — an executable gate covers the structural/static
  boundary now, while a named later packet owns runtime or provider proof.
- `prose-only` — binding, but no enforcement instrument yet and no tracked
  packet. These are the real risk rows: they depend on someone remembering to
  promote them. Drive this column to empty.

G0-P3 is accepted. Every row whose "Enforced today by" cell names G0-P3 has
that structural boundary enforced now; `partially enforced` means only that a
separate runtime/provider proof remains scheduled, not that the P3 gate is
pending.

## G1 stage closure

Accepted G1-P9 reviewed SHA `1e69199` evaluates the G1-scoped slice of each
concern separately from its later residual. On integrated product SHA
`03c3d41`, no obligation routed to G1 by G1-P0 remains merely scheduled or
prose-only:

| G1 obligation | Accepted enforcement | G1 status | Residual after G1 |
|---|---|---|---|
| One application/release authority | P3 immutable release root, P4a-b sole approval/CAS path, P5 issued view | ENFORCED | compatibility and fleet rollout |
| Trusted request context and pinning | P5 same-snapshot issued view, live policy, explicit deferred context | ENFORCED | later job/cache/report consumers |
| Compiler determinism | P1 canonical language and P2 byte-stable complete compiler output | ENFORCED | breadth and measured optimization |
| Human-controlled activation | P4a real authority substrate and P4b atomic attempt-only activation | ENFORCED | G6 authoring/product flow |
| Semantic gateway ownership | P6 sole authenticated empty Query/Operation gateways | ENFORCED | G2-P2 registered semantics plus G2-P3/G2-P6/G2-P7 channel bindings |
| Agent tool prohibition at the G1 seam | P2 five-tool projection and P6 raw-capability prohibition | ENFORCED | later agent behavior/evals |
| UX grammar and compiled surface seam | P7 compiled shell and P8 plan/skill/code pin plus bypass negatives | ENFORCED | G2-P4 automated full grammar/mobile/accessibility conformance; broader G7 audit |

The stage evidence is `docs/execution/stage-gates/G1.md`. Global rows below
correctly remain `partially enforced` when the named concern spans a later
stage; that does not reopen the G1 slice certified here.

## G2 enforcement routing

G2-P0 creates concrete owners for every doctrine obligation that must become
executable in G2. These rows remain scheduled or partially enforced until the
owning implementation packet is accepted; the stage cut itself is not product
evidence.

| G2 obligation | Owning packet | Required promotion evidence |
|---|---|---|
| Storage validity/backfill truth and shared-schema transition coexistence | G2-P2 | additive transition, old/new release coexistence, retry, and bounded preparation tests |
| Surface grammar, compact/mobile transforms, and G2 automated accessibility | G2-P4 | compiler/structural negatives and five-archetype desktop/compact browser journeys |
| Transactional lifecycle/audit/outbox plus authorization-decision evidence | G2-P1 | evidence-ready reviewed candidate `a71aa33`: atomic rollback, trusted attribution/delegation, redaction, immutable correlation, and two-tenant provider evidence |
| No business hard delete through Semantic Operation | G2-P2 | compiler/conformance/gateway negatives; archive/restore is the only O0 lifecycle path |
| Exact/ambiguous/not-found resolver behavior | G2-P3 | deterministic Party resolver envelope including duplicate, weak, empty, and cross-tenant cases |
| Agent and human read the same DTO | G2-P6 | Item UI and fixed-tool Operation create paths read back through one Query DTO |
| Cross-tenant relation rejection | G2-P3 | Party-role relation rejection at validation/service, policy, and forced-RLS/provider layers |

The detailed packet map is
`docs/execution/packets/G2-P0.md`. No binding G2 concern is left unscheduled.

## Open gaps to close (the action list)

As of 2026-07-24, the binding rules not yet backed by a tracked enforcement
packet:

1. **Customization boundaries** and **capability support cells** — plan §10,
   §5.5; enforcement lands at G6/per-capability, correctly later, but should be
   confirmed as tracked packets when those stages are cut.
2. **Identity, roles, and policy decisions** — the deny-capable ports and
   declared permission IDs have no real evaluator or owning work-package ID;
   the policy/identity kernel packet is not yet cut (current-plan pending
   decision 4 and queue row 9).
3. **Runtime configuration and secret handling** — committed-secret scans do
   not govern how a deployed instance receives, scopes, or rotates
   configuration and credentials; the runnable-app-composition packet and
   contract are not yet cut.
4. **Retention, purge, and data-subject erasure** — no-hard-delete,
   additive-only storage, append-only trust facts, and one shared database make
   erasure unreachable by construction; pending plan-level decision 1 must
   settle the storage model before G3.
The G2 surface, responsive, accessibility, storage, trust, lifecycle,
resolver, channel-parity, and relation-isolation obligations are routed by
G2-P0. G2-P1 now has an evidence-ready, dual-reviewed Freeze E candidate;
acceptance/integration is still pending. The remaining obligations must be
promoted by their owning packets.

## Authority and structure

| Concern | Instrument | Enforced today by | Executable at | Status |
|---|---|---|---|---|
| One application/release authority | ADR-0001 | G0-P3 alternate-authority scan + G1-P3 sole immutable revision/release repository and no-overlay boundary + G1-P4a one stable pointer per tenant/environment and one approval/attempt binding + G1-P4b sole attempt-only activation service, atomic pointer generation, receipt-driven reconciler, and no compiler access + G1-P5 one issued immutable request view from the authoritative pointer with no reload or fallback path | G1-P3 persistence; G1-P4a pointer/approval contracts; G1-P4b activation; G1-P5 pinning | enforced |
| Modular monolith + dependency direction | ADR-0002 | G0-P3 boundary checker | G0-P3 boundary checker | enforced |
| PostgreSQL sole launch provider | ADR-0003 | G0-P3 protected-import scan | G0-P4a provider/migration tests | partially enforced |
| Trusted tenant/request context | ADR-0004 | G0-P4b authenticated-entry, two-tenant RLS, and pool-reuse tests + G1-P4a forced pointer/approval RLS and trusted createApproval context + G1-P5 issued-context-only same-snapshot view construction, two-tenant pinning, live-policy denial, and explicit child-process deferred context | G0-P4b trusted context; G1-P4a approval substrate; G1-P5 request-view pinning tests | enforced |
| Runtime configuration and secret handling | plan §11.3 | — | Runnable-app-composition packet plus config/secret-handling contract, not yet cut | prose-only |
| Drop `@agent-native/core` | ADR-0005 | G0-P3 manifest, lockfile, import, and compatibility-authority scan | G0-P3 boundary checker | enforced |
| Compiler determinism (round-trip/hash) | ADR-0001 (partial) + plan §5.3 | G1-P2 permutation, schedule, fresh-process, twice-compile, golden leaf/manifest/root/diff, and hermeticity gates | G1-P2 compiler tests | enforced |
| Complete fail-closed Merkle release output | Freeze B; plan §5.3-5.5 | G1-P2 required-family/cross-projection/no-root tests + G1-P3 required release-envelope shape, domain-hash, manifest/projection/chunk links, payload-derived projection semantic digests, exact closure, attestation, and no-root-on-registration-failure tests | G1-P2 compiler tests; G1-P3 verified `bytea` registration | enforced |

## Canonical-language evolution and compatibility

| Concern | Instrument | Enforced today by | Executable at | Status |
|---|---|---|---|---|
| Freeze A is v0-experimental; production-v1 requires inventory, purchasing, and sales through every promised projection | canonical language v0 §Freeze meaning; plan §5.8 | G1-P1 version/schema gates | G5 exit evidence, ratified at G7 release-candidate gate | scheduled |
| Compiler-version-bump identity and approval carry-forward | ADR-0001/ADR-0006; canonical language v0 deferral | G1-P3 immutable revision envelope records Freeze A profiles and each release records compiler/output/attestation versions without content-hash identity | G1-P3 revision envelope + G1-P4a approval binding + G1-P4b activation policy | partially enforced |
| Full package composition/merge and tenant three-way rebase | plan §5.6, §10; canonical language T9 | G1-P1 foreign-reference unsupported fixture | G6 customization stage cut must create the merge/rebase packet. **Framing ruling (2026-07-26):** the packet's primary mechanism is **patch re-application** — §5.6 has every authoring channel emit typed semantic patches, so upgrade is re-applying declared tenant intent to base v2 and normalizing, not diffing outcomes. Three-way rebase is the fallback for patches that no longer resolve, not the default. Extension-points-only is **rejected** for this platform: it is the right answer for asymmetric vendors (Salesforce/SAP/Dynamics) and would manufacture the two-tier world doctrine #2 forbids | scheduled |
| **Persist the semantic patch lineage, not only the normalized revision** | **ADR-0013 (accepted 2026-07-26)**; plan §5.6 (all channels emit typed semantic patches); [prior-art audit B7](prior-art-failure-modes.md) | — . §10.1 treats the patch as a pipeline step and G6 item 4 specifies "draft service with **revision history**" — outcome history, not patch history | G6 customization stage cut, but the schema decision is cheapest **before** the customization canonical model is authored. Intent cannot be reconstructed from the revision it produced. ADR-0013 fixes the shape: data-plane not canonical (so no version bump, and it does not ride row 4), append-only, binding base package versions and resulting revision identity. Its load-bearing gate is determinism — re-applying a patch to the base it was authored against must reproduce the recorded revision identity byte for byte | scheduled — [G6-P0](stage-cut-inputs.md) |
| LLM-assisted upgrade migration is a **proposer only**: usage telemetry and metadata only (never tenant business records), gated by compile + the tenant's approved assertion scenarios + human approval, activating as a release with rollback; never auto-activation | prior-art audit B7; [expression-kernel verdict](debates/expression-kernel-verdict.md) role boundary (author at compile time, never evaluate at runtime) | — | G6 merge/rebase packet, for the residue patch re-application cannot resolve | scheduled — [G6-P0](stage-cut-inputs.md) |
| Historical compiler/runtime compatibility and retirement | plan §5.4, §7.5; canonical language v0 deferral | version/profile identity from G1-P1 | G7 compatibility/recovery packet | scheduled |
| Storage backfill and data-validity semantics are part of compiler completeness | plan §5.3, §5.8-5.9 | G1-P1 storage schema carries no false backfill claim | G2-P2 compiler/storage transition and module-conformance tests | scheduled |
| Per-subgraph incremental compilation and memoization | plan §5.3, §10; Freeze B; salvaged SLO budget reference | G1-P2 cache-input/node contracts, cold equivalence invariant, and 4,096-field numeric budget | G6 builder/compiler stage cut must create the measurement-triggered cached-equivalence packet | partially enforced |
| Compiler execution off the serving event loop and verified canonical `bytea` root registration | Freeze B; plan §5.3-5.4 | G1-P2 process-serializable/hermetic boundary + G1-P3 serving-package no-compile gate and verified exact-byte persistence + G1-P4b activation consumes only immutable registered releases and has no compiler dependency | G1-P3 persistence; G1-P4b activation boundary | enforced |
| Untrusted-definition compiler sandbox release gate | Freeze B; plan §7.2 | G1-P2 rejects non-first-party provenance until the gate exists | G6 builder/compiler stage cut must create process-isolation/resource-limit release gate before tenant/AI authoring | partially enforced |
| Draft preview uses the production hermetic compiler core | Freeze B; plan §5.3, §10 | no second compiler API exists | G6 preview packet must test draft bytes through the same compiler core | scheduled |
| Release-plane definitions versus data-plane preferences | Freeze B; plan §5.4, §8.6, §10 | G1-P2 compiler protocol binds definition projections only | G6 customization stage cut must test saved views/column order as release-pinned data parameters | scheduled |
| Online-compatible optional-field storage path before seconds-fast claims | Freeze B; plan §5.3, §15.1 | G1-P2 emits only a factual exact-pair transition and makes no latency claim | G2-P2 storage topology/transition packet with a factual preparation budget | scheduled |

## Runtime, gateways, agent

| Concern | Instrument | Enforced today by | Executable at | Status |
|---|---|---|---|---|
| Human-controlled release activation | ADR-0006; plan §5.4 | G1-P4a real per-tenant approver eligibility epoch, maker-checker createApproval service, and one approval/attempt constraint + G1-P4b attempt-only activation, approving-human/executor live rechecks, policy-epoch serialization, atomic CAS, and rollback through a fresh approval | G1-P4a approval substrate; G1-P4b activation; G6 approval UI/flow | enforced |
| Prepare → verify → activate transition protocol and rollback/forward-recovery rule | ADR-0006/ADR-0010; Freeze B | G1-P2 exact-pair transition digest and verified base + G1-P4a exact-pair preparation receipt, versioned compatibility policy, forward-recovery class, append-only phases/history, and decisive-outcome slot + G1-P4b fail-closed readiness validation, atomic CAS, generation-bound verification, rollback race, and receipt-driven recovery proofs | G1-P4a contracts; G1-P4b preparation verification and CAS; G2-P2 shared-schema coexistence | partially enforced |
| Approval binds exact diff/transition/compiler evidence and rejects unknown impact codes | ADR-0006; Freeze B | G1-P2 versioned factual evidence + G1-P4a trusted service recomputation of pointer, target root, compiler/evidence, capability, transition, renderer, and policy binding + G1-P4b canonical reload, stale-pointer, expiry, revocation, policy-epoch, and live-deny enforcement | G1-P4a approval binding; G1-P4b stale/live-policy enforcement | enforced |
| Approval fan-out for one decision to many tenant-qualified approvals | Freeze B; ADR-0006 | G1-P4a reserves `sourceDecisionId`/`rolloutId` lineage only | G7 fan-out packet requires an explicit ADR-0006 amendment before any service may mint tenant approvals | scheduled |
| Shared-schema transition coexistence | ADR-0006/ADR-0010; compatibility doctrine | G1-P4a reserves transition scope, storage domain, schema generation, and forward-recovery-only classes without executing migrations | G2-P2 transition planning/application and old/new release provider tests | scheduled |
| Release-pointer invalidation is not request-pinning authority | ADR-0001/ADR-0004 | G1-P4a reserves versioned outbox identities + G1-P4b atomically commits one generation-tagged event and freezes monotonic consumer semantics + G1-P5 consumes that contract, validates every cache use/publication against the authoritative pointer, and proves slow fills cannot survive a newer fence | G1-P4b delivery/fill contract; G1-P5 authoritative request pinning and cache-race tests | enforced |
| Semantic Query/Operation gateway ownership | ADR-0008; plan §5.9, §9.2 | G0-P3 direct-access/private-registry scan + G1-P6 sole empty gateways, authenticated adapters, issued-view-only pinned catalogs, live policy, typed no-such failures, and no physical/ambient bypass seam | G1-P6 gateway skeleton and tests; G2-P2 registered semantics; G2-P3/G2-P6/G2-P7 channel bindings | enforced |
| Identity, roles, and policy decisions | ADR-0004/ADR-0008; plan §6.8, §12.12 | — | Policy/identity kernel packet, not yet cut; plan §13 has no work-package ID (current-plan pending decision 4 and queue row 9) | prose-only |
| Agent tool prohibitions (no raw DB/source; five fixed tools) | ADR-0009; plan §9.2, §9.2.5 | G0-P3 source/model-facing scan + G1-P2 fixed five-tool projection + G1-P6 closed semantic request seam with no DB/SQL/source/admin affordance or added `erp_*` tool | G1-P6 boundary seam; G2-P2 conformance and G2-P6 DTO parity; benchmark G7 | partially enforced |
| Deterministic resolver outcomes (exact/ambiguous/not-found; never silent weak selection) | plan §5.9, §6.6, §11.5 | — | G2-P3 shared resolver envelope and Party exact/duplicate/weak/empty/cross-tenant tests | scheduled |
| Human and agent channels consume the same Query DTO and operation read-back | plan §5.8-5.10, §6.9, §9.2.2-9.2.3, §11.5 | G1-P2 projects one agent catalog family and G1-P6 exposes one pinned gateway seam, with no business success path yet | G2-P6 Item create/read-back parity through fixed tools and the same Q0 DTO | partially enforced |
| LLM-only intent classification | salvaged user policy; plan §9 | — | agent packets (A-01+) | prose-only |
| Append-only inventory posting truth | ADR-0007; plan §6.3-6.4 | G0-P3 direct-write/writable-balance scan | G3 inventory property suite | partially enforced |

## UI/UX and customization

| Concern | Instrument | Enforced today by | Executable at | Status |
|---|---|---|---|---|
| Surface grammar (5 archetypes, one authority per surface, status colors, weight-matches-consequence) | plan §8.5-8.6; `ux-grammar` skill | G1-P7 reviewed candidate `e647968`: issued-view-only SurfaceRuntime, deterministic compiled-navigation assertion, closed own-entry component registry, rendered unsupported/error diagnostics, status-role styling, 6/6 focused contracts, and 3/3 Chromium journeys; accepted G1-P8 SHA `4ea6686`: loadable versioned skill pin, exact per-archetype plan/skill/code vocabulary checks, closed-registry and compiled SurfaceRuntime seam, 9/9 focused negatives, and 35/35 architecture tests | G1-P7 compiled shell + G1-P8 skill-pin/seam; G2-P4 full conformance | partially enforced |
| Responsive/mobile contract | plan §8.5; `ux-grammar` skill | G1-P8 pins the loadable skill to plan/code vocabulary; compact rendering behavior remains unenforced | G2-P4 deterministic compact-projection compiler and shadow-browser conformance | partially enforced |
| Accessibility (WCAG 2.2 AA) | plan §8.4-8.5 | — | G2-P4 automated compiler/browser conformance; broader G7 audit | scheduled |
| Customize content, never grammar | plan §8.6, §10 | `ux-grammar` skill | G6 customization gates | scheduled |
| Customization boundaries (what tenants may change) | plan §10.2-10.3 | — | G6 | scheduled |
| **Position-scoped typed escapes: the escape is a BODY inside an existing position profile, never a new contract** — a validation that cannot be expressed declaratively is supplied as a validation body with the same signature, purity, sandbox, release pinning and audit, and can do nothing a validation could not | [Lever 2](coverage-strategy-levers.md); ADR-0012 position profiles ARE the escape contract (context, result type, phase, purity, dependencies, absent/error behaviour, target); [audit B5/B4](prior-art-failure-modes.md) | ADR-0012 defines the profiles but does not mention escapes — the connection is unrecorded, and the plan's Tier C (§12.3) is scoped for rare novel algorithms, not for an ordinary rule slightly too weird for the language | First implementation G6-era at the lowest blast radius only (derived display field, validation). Ladder order in the strategy doc | scheduled — [G6-P0](stage-cut-inputs.md) |
| **The Tier C runtime envelope exists before the pressure arrives** — grants, resource limits, review path, release pinning, rollback, kill switch, revocation | plan §5.2 reserves "server WASM and isolated UI extensions"; §12.14 proof 4 lists the properties; [audit B5](prior-art-failure-modes.md) | — . §5.2 reserves identity/versioning/serialisation; the runtime **envelope** is reserved nowhere | Plan schedules Tier C at **N7**. History says the first blocked customer arrives around N2, and an envelope that does not yet exist becomes a customer-specific fork (audit A4, whose §16 control is a process rather than a mechanism). Design the envelope early even if unimplemented | `prose-only` |
| **An escape body carries its declarative provenance** — the formula that was attempted, and which missing primitive it substitutes for | [Lever 2](coverage-strategy-levers.md); same cost curve as [ADR-0013](../decisions/ADR-0013-semantic-patch-lineage.md)'s patch lineage | — | Enables two things at once: the **differential check** (diff body against the formula it replaced; every disagreement is the intended fix or an unintended regression, which a business user can adjudicate) and **retirement back to declarative** when the language later gains the primitive. Without it, opaque bodies accumulate permanently — [audit B6](prior-art-failure-modes.md) in its more damaging form, unanalyzable logic rather than unused fields. Cheap when bodies are first defined, unrecoverable afterwards | `prose-only` |
| **Boolean binding positions carry a reason channel** — guards and visibility return a reason alongside true/false, so an escape body must supply one | [Lever 2](coverage-strategy-levers.md); plan D2 explainability; ADR-0012 position profiles | Validation profiles already solve this by shape (pass/fail **plus message** — the message is the explanation). Boolean-only positions have no room for a reason | **Queue row 4**, which builds the formula/rule projection family carrying binding-position profiles. Requiring it now costs a sentence; retrofitting after the family ships costs a canonical change | `prose-only` |
| **The realization ladder has five rungs, and the platform has only two of them** — (1) compiles declaratively, (2) agent-authored escape body run by a sandbox, (3) agent-assisted manual step, (4) bare manual attestation, (5) blocked | [Lever 3](coverage-strategy-levers.md); plan §12.13's four outcomes; ADR-0009 agent tool boundary | Rungs 1 and 5 only. A requirement missing one primitive is blocked entirely, however much of it compiles | **Rung 3 is the cheapest and should be built first** — it needs no sandbox and no new canonical structure, since the step stays a compiled confirmation operation (PR-3 shipped server-issued fully bound confirmation) while the agent surfaces, pre-fills, routes and batches. Rung 2 needs Lever 2's sandbox. G6 customization | scheduled — [G6-P0](stage-cut-inputs.md) |
| **Downgrade boundaries: the platform's capability claim never moves, and there is a floor** | plan §10.2 ("partial support is reported as a capability gap, not approximated"); doctrine #4; [Lever 3](coverage-strategy-levers.md) | §10.2 is stated but has no downgrade mechanism to bound, because no downgrade exists yet | Forbidden: the platform advertising a capability it partly supports. Allowed: a **tenant** knowingly shipping a module whose remainder is recorded **as** manual — the support matrix still says unsupported and the gap report stays exact. **Floor:** never degrade anything protecting inventory truth, tenant isolation, authorization, or audit completeness; those fail closed with no offer presented. Without a written floor, "ship it with a manual step" drifts to "post the movement manually and reconcile later" | `prose-only` |
| **The agent may evaluate what has no authority; never what IS the decision** — triage, prioritisation, suggestion, drafting and explanation are permitted; blocking, posting, authorising, or computing a stored value are not | Generalises the [expression-kernel verdict](debates/expression-kernel-verdict.md) role boundary beyond expressions; ADR-0009; plan §14.3 replay determinism; §15.5 model-independence | ADR-0009 constrains the agent to registered operations with confirmation and read-back | Load-bearing from the moment rung 3 exists. The tempting shortcut — "let the agent evaluate the rule we could not compile" — breaks determinism (§14.3 replay), auditability ("the model decided"), release pinning (a model is not pinned, so a provider update changes business behaviour with no approval or rollback), and §15.5. Rung 2 is the legitimate form: the agent **authors** the body at compile time and a sandbox runs it | `prose-only` |
| **Instrument the wall: gap-to-capability cycle time, rule-#5 disposition mix, and per-tenant configuration hours** | [Lever 4](coverage-strategy-levers.md); program rule #5's four dispositions; [audit B3/A3](prior-art-failure-modes.md); plan §15.7 | §15.7 measures module-building effort from EXISTING capabilities — the wrong axis for this. It notes capability cost should be measured separately but makes it neither headline nor gate | **Can start now**, before any tenant: PR-6's `relation` index kind and row 4's two canonical families are capability additions whose cycle time is measurable today. A baseline not started cannot be reconstructed. Disposition rates and configuration hours follow at G6/first tenant | scheduled — [G6-P0](stage-cut-inputs.md) |
| **Self-hosting the capability compiler is earned, never anticipated** — add three or four capabilities by hand, observe which projections were purely mechanical, generate only those. Trigger: the same projection hand-written three times identically | [Lever 4](coverage-strategy-levers.md); doctrine #10's ten support cells; plan §16 first risk row | — | The payoff is real (gap latency from quarters to days, and doctrine #2's symmetry makes it possible where Salesforce's asymmetry did not) **and it is §16's platform-before-product risk in disguise** — a capability-compiler is the most seductive possible project and produces no direct customer value. Earliest realistic N1-N2, and only on the trigger | `prose-only` |
| Escapes protect the expression ceiling — pressure must route to a contained position, never ratchet the language | [Lever 2](coverage-strategy-levers.md); ADR-0012 growth governor; [audit B4](prior-art-failure-modes.md) expressiveness ratchet | ADR-0012 fixes the ceiling (total, terminating, no loops, no operation invocation, bounded depth) | The ceiling holds only while an escape exists to absorb demand. Without one, the observable symptom is proposals to add expressiveness to the language itself — treat that as the tripwire | `prose-only` |
| **The builder negotiates the requirement against existing vocabulary before declaring a gap** — and presents the alternative *together with its difference*, never the alternative alone | Extends plan §12.13, which covers only **discovery and disambiguation** ("discovers existing canonical objects and capabilities, asks only material clarification"). Negotiation additionally re-expresses the *need*: "you asked for a custom approval matrix — a two-state transition plus a permission narrowing gives you what you need; here is what it would not give you" | — . §12.13's flow is binary today: composable, or an exact gap report. The middle step does not exist | G6 builder (plan §11.9 items 1-3). The composition ladder becomes **discover → negotiate → compose, else downgrade offer, else gap report** | scheduled — [G6-P0](stage-cut-inputs.md) |
| Capability support cells (supported = every edge + evidence) | plan §5.5 | — | per-capability from N1 | scheduled |
| Expression ceiling: one language, total and terminating, no loops, no operation invocation, bounded depth | [expression-kernel verdict](debates/expression-kernel-verdict.md) V1-V2 (RATIFIED); plan §5.11 | `CANON_LIMIT_EXPRESSION_DEPTH` = 24 and commutative-term sorting in `normalize.ts` already make order-dependent semantics inexpressible | queue row 1 — ADR-0012 ratifies the ceiling | scheduled |
| **One owned evaluator per execution target** (one language is necessary but not sufficient — the quarry forked with a unified AST because a consumer re-implemented evaluation) | expression-kernel verdict V3/V8 + quarry evidence `condition-evaluator.ts:36` vs `runtime-metric-service.ts:478` | row 1 collapses three call sites onto one canonical-model entry point; static out-of-kernel dispatch scan recorded as a proxy | queue row 8 (Q1) — execution receipts plus the server-inclusive dispatch tripwire (L3) | scheduled |
| Cross-target semantic parity (absent values vs SQL three-valued logic, exact-decimal vs `numeric` ordering, database-owned case-fold parity) | expression-kernel verdict, additional obligation 4 | — (invisible failure class; nothing observes it today) | queue row 8 (Q1) differential parity corpus (L2); bidirectional at G6 (L5) | scheduled |
| SQL admissibility is a cost class per admissible shape, never a binary indexability test | expression-kernel verdict V4; PR-6 R4 bounded partition scan | PR-6/PR-6b execution-observed index probes for the shipped shapes | queue row 8 (Q1) lowering table with one paired provider probe per row | scheduled |
| Per-evaluation explanation is a required Formula-family output, not an optional receipt | plan lines 640/2338/2639; expression-kernel verdict V8 | — | row 1 ADR obligates it; emitted from G6 | scheduled |
| Compiler-derived assertions gate customization candidates; author-supplied scenarios are additive only | prior-art audit E1 ([prior-art-failure-modes.md](prior-art-failure-modes.md)); plan §5.1 assertion family, §10.1 | — (a tenant author currently writes both the change and its verification — the Salesforce 75%-coverage failure shape) | G6 customization gates (L6), prototyped on the kernel at row 8 (L4) | scheduled |
| Workflow mutation steps invoke whole Semantic Operations, never `EffectGraph` nodes; compensation is a named correcting operation | expression-kernel verdict V7 (RATIFIED); ADR-0008 sole write ingress; plan §7.3-7.4; ADR-0010 | ADR-0008 gateway mediation enforced from PR-3 | N2 workflow substrate | scheduled |
| **Zero query/operation/surface/policy/storage kernel branches** across four structurally different no-platform-branch modules, plus a fifth from a materially different domain | plan §12.14 breadth proofs; plan §5.10 standard module artifact ban list | `validateModuleConformance` (`compiler.ts:732`) checks module *definition* shape; `module-conformance-runtime.test.ts` scans `packages/domain` source for SQL, PostgreSQL clients, and Q0/O0 execution | N1 inspection, N2 approval/communication, N4 CRM/work-order, N6 fifth non-inventory package | scheduled |
| **Platform-side kernel proliferation** — no *second* evaluator, interpreter, or lowering engine grows inside the platform packages for ANY kernel (expression, query, effect, surface, policy, storage) | Lever-1 consolidation thesis; [expression-kernel verdict](debates/expression-kernel-verdict.md) V8 and its quarry evidence | Nothing. Today's source scan is aimed at `packages/domain` — it stops a *module* from growing an engine, but the quarry's actual fork was platform code (`runtime-metric-service.ts:478` re-implementing `condition-evaluator.ts`) | queue row 8 (Q1) L3 tripwire covers **expressions only**; generalizing it to the other five kernels is unowned and should be scoped at N1 alongside the first breadth proof | `prose-only` |

## Domain-model one-way doors

Added 2026-07-26. Every row here closes **permanently** when the first inventory movement is
posted, because ADR-0007 and plan §7.4 forbid rewriting a posted fact. They are `scheduled`
rather than `prose-only` because ledger row `G3-P0` is seeded and
[`stage-cut-inputs.md`](stage-cut-inputs.md) §G3 carries the obligation list; the G3 cut may
not disposition any of them as a deferral past the posting service.

| Concern | Instrument | Enforced today by | Executable at | Status |
|---|---|---|---|---|
| Every business record carries a resolved owning legal entity, immutable after create | [ADR-0015](../decisions/ADR-0015-legal-entity-business-dimension.md); plan §1, §2.2, §6.1-6.4; [audit G2](prior-art-failure-modes.md) | — . The dimension does not exist in any compiled artifact today | `G3-P0` cut: compiler-derived system column, `legal_entity` master in Party, storage-target payload version bump, two-entity fixture in the G3 gate | scheduled |
| The entity dimension is business, not tenancy — absent from ABI leading keys and RLS predicates | ADR-0015; ADR-0011 `northstar.postgresql-module-provider-abi/v1` | Vacuously true: the column does not exist | `G3-P0` structural test asserting no RLS policy and no ABI-frozen key includes `legalEntityId`, so the distinction is executable rather than prose | scheduled |
| Stock identity is a declared versioned dimension set; every movement stamps its version; `unspecified` is a member, not a null | [ADR-0016](../decisions/ADR-0016-stock-identity-dimension-set.md); plan §6.3, §6.4 invariant 17, §12.6, §14.3; [audit G1](prior-art-failure-modes.md) | — . No movement table exists | `G3-P0` cut, proven by the §14.3 replay property: extending a fixture dimension set reproduces byte-identical prior balances | scheduled |
| Base unit is immutable once any posted movement references the item | ADR-0016; plan §2.2, §6.2, §6.4 invariant 16 | — | `G3-P0` compiler rule plus provider constraint, with the diagnostic naming the binding movement | scheduled |
| Effective and recorded time are distinct; recorded time is trusted-context-sourced and never editable; no projection discards it | [ADR-0018](../decisions/ADR-0018-temporal-authority.md); plan §6.3, §6.4 invariants 18-19; [audit G6](prior-art-failure-modes.md) | plan §6.3 stated the distinction with no contract behind it | `G3-P0`; the no-discard rule binds every read-model author from G3 onward, including performance projections | scheduled |
| Tenant-declared time zone and business day; per-entity period lock enforced inside the posting transaction | ADR-0018; plan §6.4 invariant 20, §11.6 | — . Plan §11.6 said "closed periods if enabled" with no enforcement point | `G3-P0`, with a recorded negative control proving a locked-period post is rejected | scheduled |
| Movements carry no monetary amount; receipt lines capture actual cost or an explicit absence | [ADR-0017](../decisions/ADR-0017-cost-capture-without-valuation.md); plan §2.2, §6.2, §6.4 invariant 13; [audit G3](prior-art-failure-modes.md) | — | `G3-P0` for the prohibition (structural test: no movement-sourced money field in any compiled artifact); `G4-P0` for the capture | scheduled |

## Trust, lifecycle, recovery

| Concern | Instrument | Enforced today by | Executable at | Status |
|---|---|---|---|---|
| Lifecycle / audit / correction / recovery doctrine | ADR-0010; plan §7.3-7.4 | G0-P3 duplicate-authority and hard-delete scan + G1-P4a append-only approval/attempt/phase/history contracts + G1-P4b atomic history/outbox facts, decisive receipt reconciliation, generation-bound verification, no-pointer-move reconciler, and durable statement-time overdue detection + G2-P1 reviewed candidate `a71aa33` for atomic mutation/invocation/change/event/outbox facts, immutable links, attribution, redaction, and write-side outbox | G1-P4b activation recovery; G2-P1 T-01 trust substrate; correction/recovery drills G7 | partially enforced |
| Authorization audit captures policy/evaluator version, relevant inputs, and decision | ADR-0008/ADR-0010; Freeze B | G1-P2 pins policy references/model version and declares live deny-capable decisions + G2-P1 reviewed candidate `a71aa33` persists versioned policy/evaluator evidence, redacted relevant inputs, decision, actor/delegation envelope, and two-tenant provider proof | G2-P1 T-01 invocation/change evidence and two-tenant provider tests | enforced |
| No hard delete for business data | ADR-0010; AGENTS.md; plan §7.4 | G0-P3 hard-delete scan + G2-P1 reviewed candidate `a71aa33` exposes archive/restore-only `LifecycleService` through the Semantic Operation Gateway and makes trust facts append-only | G2-P2 module compiler/conformance and Operation-gateway negatives; O0 archive/restore only | partially enforced |
| Retention, purge, and data-subject erasure | ADR-0010/ADR-0011; plan §7.4; [audit G5](prior-art-failure-modes.md) | — | Pending plan-level decision 1 before G3; crypto-shredding would change the storage model. This is in direct tension with the enforced no-hard-delete row above. Not an engineering cost curve but a binary jurisdictional gate — a potential EU launch blocker rather than a hygiene item. | prose-only |
| Cross-tenant relation rejection at service and policy layers | ADR-0004; plan §6.4, §7.2, §11.5 | G0-P4b trusted context/RLS base and G1 issued-view/gateway tenant scope | G2-P3 Party-role validation/service, policy, and forced-RLS/provider tests | partially enforced |
| Backup / restore / RPO / RTO | ADR-0010; plan §7.5 | authority-map review | G7 recovery drill | scheduled |
| **Tenant completeness manifest** — every table in every plane classified exactly once as tenant-scoped (naming its column) or tenant-independent | [ADR-0019](../decisions/ADR-0019-tenant-completeness-and-single-tenant-recovery.md); plan §7.5; [audit G4](prior-art-failure-modes.md) | — . Tenant export is promised by §7.5 but is presently a claim with no completeness proof behind it | `G3-P0` cut, reusing ADR-0011's accounted-additive-closure object enumeration. Cheap at ten tables, an archaeology project at a hundred; also the hardest prerequisite for the pending erasure decision | scheduled |
| **Single-tenant recovery tiers R1/R2/R3, and no live-tenant DML from any recovery path** | ADR-0019; plan §7.5, §11.10 item 6, §17 | Vacuously: no recovery service exists | `G7-P0` recovery packet. R2 requires a tenant write freeze and is forward motion rather than rollback — both recorded as product limits, not papered over. The published-promise decision is commercial, at G7/G8 | scheduled |
| **Publish-path budget, both axes** — publisher latency and platform exclusion imposed on other tenants | [ADR-0020](../decisions/ADR-0020-publish-path-budget-and-verification-integrity.md); [`compiler-slos.md`](../operations/compiler-slos.md); [`runtime-slos.md`](../operations/runtime-slos.md); [audit G7](prior-art-failure-modes.md) | Compiler component budget gated at ≤5,000 ms on one maximal module; PR-6c's 2,000 ms exclusion trigger recorded but **procedural**, not consumed by any approval path | Breadth envelope startable **now** as a recorded curve; numeric objective at the G6 cut; the exclusion trigger becomes a coded admission input at the online-strategy packet | partially enforced |
| **Verification integrity** — scope narrows only by recorded impact analysis, never by sampling, time-boxing, author selection, a skip flag, or deferral past activation | ADR-0020; plan §15.5, §17; shares its root with [audit E1](prior-art-failure-modes.md) | Vacuously true: no narrowing mechanism exists to abuse yet | `G6` customization cut, when the first real narrowing pressure arrives. Structural test plus negative controls for each of the five forbidden narrowings | scheduled |
| **Incremental compile is byte-identical to cold, or it does not ship** | ADR-0020; `compiler-slos.md`; doctrine #1; plan §5.7 | Stated in `compiler-slos.md`; vacuously held because no incremental path exists | G6 compiler packet, with a negative control that perturbs the incremental path | scheduled |
| PITR/restore cannot revive pre-restore activation coordinators | ADR-0006/ADR-0010; G1-P4 debate | — | G7 recovery packet must define isolated restore, logical promotion, and a recovery incarnation that invalidates pre-restore zombies | scheduled |
| Release artifact GC preserves every activation/recovery root | ADR-0001/ADR-0010; G1-P4 debate | G1-P3 immutable release/link constraints; no GC path exists | G7 lifecycle/GC packet must root active releases, rollback candidates, approvals, history, and transition evidence | scheduled |
| Secrets never in source/fixtures/prompts | AGENTS.md | G0-P5c clean-history scan plus committed synthetic-secret negative gate | G0-P5c secret scan in CI | enforced |

## Process and evidence (already enforced by skills)

| Concern | Instrument | Enforced today by | Status |
|---|---|---|---|
| Step-packet cadence (one packet, user checkpoint, no autonomous continuation) | `mission-cadence` skill | orchestrator follows skill | enforced |
| Seat/model + threat-bounded review tiers | `review-tiers` skill | packet records and fresh review prompts state in-scope and deferred threat cases | enforced |
| Salvage admission (PORT/RE-EXPRESS/REFERENCE) | `salvage-admission` skill | per-port admission record | enforced |
| Branching / commit / push discipline | `git-workflow` skill | orchestrator follows skill | enforced |
| Evidence packet per stage gate | AGENTS.md + template | per-gate record | enforced |

## Observability and security

| Concern | Instrument | Enforced today by | Executable at | Status |
|---|---|---|---|---|
| Baseline observability (structured logs, correlation/trace IDs, health/readiness, metrics/error evidence) | plan §15.2; AGENTS.md | G0-P5 propagation, PostgreSQL-loss readiness, redaction, metrics, and CI-evidence tests | G0-P5 observability packet | enforced |
| SLOs / error budgets | plan §15.1; Freeze B SLO families | G1-P2 monotonic numeric 4,096-field full-compile budget + G1-P4b durable reconciliation start/max-age facts, crash-independent overdue derivation, idempotent alarm projection, and fresh-worker/lock-crossing proofs + PR-6 `runtime-slos.md` request-path bounds and forced-RLS relation-index plan gate; runtime percentiles and platform error budgets remain unratified | PR-6 request-path measurement contract; G1-P4b activation telemetry; G2-P2 transition preparation; G6 preview/incremental; G7 platform budgets | partially enforced |
| Tenant isolation (defense in depth) | ADR-0004; plan §7.2 | G0-P4b context transaction + G1-P3 forced-RLS release persistence + G1-P4a forced pointer/approval RLS and cross-tenant/environment UPDATE denial + G1-P4b trusted activation context and concurrent activation proofs + G1-P5 issued-context-only two-tenant request views, scoped cache keys, and no ambient fallback + G2-P1 reviewed candidate `a71aa33` forced-RLS trust tables, trusted insert context, two-tenant visibility, and one-backend pool-reuse cleanup | G0-P4b/G1 base; G2-P1 trust evidence; G2-P3/G2-P6/G2-P7 module and relation provider tests; G7 pentest | partially enforced |
| Dependency / secret scanning | AGENTS.md | G0-P5c high/critical dependency audit, clean-history scan, negative secret fixture, and retained CI reports | G0-P5c CI scans | enforced |
| Cross-tenant CAS deduplication domains prevent hash-oracle/existence leaks | Freeze B; plan §7.2 | G1-P2 keeps identity out of content; G1-P3 internally deduplicates verified policy-free bytes, stores no tenant columns on blobs, denies runtime blob SELECT, and exposes no hash lookup product API | G7 security stage cut must define authorization/encryption/dedup domains before global artifact reuse | partially enforced |

## Maintenance rule

Every accepted ADR, new skill, or promoted plan section updates this map in the
same packet. A stage cut (G1, G2, …) must, as part of its packet breakdown,
create tracked packets for every `scheduled` or `prose-only` row whose
executable-at column names that stage — otherwise a binding rule silently
enters a stage with no enforcement packet. The `prose-only` column is the
standing to-do; the goal is to keep driving it toward empty.
