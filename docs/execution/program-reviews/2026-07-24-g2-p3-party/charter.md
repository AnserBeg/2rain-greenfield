You are an independent senior reviewer conducting a WHOLE-APP PROGRAM REVIEW.
You have no prior context. This is NOT a packet diff review: you are reviewing
the entire built system and the program's direction. You have two mandatory
dials and must answer BOTH:

- DIAL A - internal coherence: is the app, as built so far, sound and
  self-consistent as a whole?
- DIAL B - strategic direction: is the north star still the right GOAL, and is
  the approach the right way to reach it?

Repository: /home/rvham/2rain-greenfield at main 12e6c66 (read-only; do not
edit anything). Primary sources to read as needed: the plan
(docs/greenfield-north-star-erp-platform-plan.md, esp. sections 1-6, 8.5-8.6,
11-13), all ADRs (docs/decisions/ADR-0001..0011), the ratified debate verdict
(docs/execution/debates/g2-p2-storage-topology-verdict.md), the execution
ledger and packet evidence (docs/execution/**), the skills
(.agents/skills/**), and the code (packages/**, apps/**, db/**, test/**).

# What this system is

2rain: a compiler-backed, AI-native ERP application platform. Humans and AI
compose ERP applications as declarative definitions in a closed canonical
language. A deterministic hermetic compiler lowers one definition into ALL
projections (typed storage + additive migrations, DTO/validation, semantic
query/operation contracts, surfaces, agent contracts, reporting, audit
bindings, conformance assertions) as an immutable content-addressed release.
A human-approved CAS pointer activates releases per tenant/environment; every
request pins one release view. All reads/writes flow through two semantic
gateways served by ONE generic interpreter reading compiled projections
(registration is data — zero per-module platform code). Every business write
commits atomically with invocation/change-document/event/outbox trust facts.
No hard deletes; archive/restore only. North star: an "ERP factory" where a
tenant or AI authors a whole module or a one-field change as a definition and
it becomes a complete, safely-evolvable part of the running product with zero
per-module dev code. Launch product: inventory/purchasing/sales ERP for
$10-100M businesses.

# What has been built (accepted on main)

- G0: constitution (ADR-0001..0010), dependency-boundary checker, ephemeral
  PostgreSQL + migrations + drift gate, trusted request context + two-tenant
  RLS isolation.
- G1: canonical language (frozen, now v2); deterministic compiler with frozen
  output contract (Merkle release manifest, projections); immutable
  AppPackageRevision/TenantRelease persistence; human-approved CAS activation
  with crash reconciliation + rollback; RequestRuntimeView single-release
  request pinning; fail-closed semantic gateways; compiled SurfaceRuntime
  shell; UX-grammar skill pin.
- G2-P1: transactional trust substrate (atomic mutation + invocation + change
  document + event + outbox; actor attribution; redaction; lifecycle
  archive/restore through the operation gateway).
- G2-P2 (Freeze F RATIFIED, ADR-0011): compiled module storage — transition
  envelope v1; materializer with exclusive two-plane ownership (kernel vs
  managed-module schema), append-only application ledger, object-level drift
  verification with provenance-by-recomputation, two-class preparation
  (pre-approval inert DDL vs in-attempt backfills) extending the activation
  kernel; generic Q0/O0 runtime serving compiled projections with zero
  per-module code (metamorphic fixture proof); O0 role-assumption bridge
  (trust role -> DML-only module role, one-directional, non-inherited).
- G2-P3a: generic SurfaceRuntime <-> semantic-gateway data binding (compiled
  surfaces render live Q0 data; forms submit through O0; browser-proven).
- G2-P3c: resolver authority (language v2): resolve keys declare
  identifier (exact unique -> auto-select) vs advisory (name-like -> always
  ambiguous, never auto-select); compiler fail-closes undeclared authority.
- G2-P3b Party (Freeze G ESTABLISHED): first real walking slice — party +
  parent-scoped party_role, definition-only through the press: storage,
  Q0/O0, surfaces, agent, reporting, audit; deterministic resolver
  (number=identifier, name=advisory); cross-tenant rejection at service AND
  RLS/provider layers; same DTO across UI/query/agent/read-back; browser
  journey against real PostgreSQL; the reusable module template.

Next planned: whole-app program review (this), then Catalog (G2-P6) and
Location (G2-P7) fan out on the Party template, shared table behavior
(G2-P5), surface-grammar conformance (G2-P4), durable import (G2-P8), then
G3 inventory truth (append-only movement ledger), purchasing, sales.

# Honest defect history you must weigh (and test the hypothesis)

Four latent defects were found in ACCEPTED packets only when later work
exercised them, plus one review-raised gap:

1. Manifest-version half-bump: package said language v1, compiled manifest
   still v0 — caught only when the postgres suite ran downstream.
2. Non-monotonic reconciliation clock in the activation kernel — a backward
   wall-clock step could delay/miss an overdue alarm; surfaced as a load
   flake.
3. Case-insensitive uniqueness contract rendered as a PLAIN unique index —
   P-001 and p-001 coexisted despite the compiled unicodeCaseFold contract;
   caught by Party.
4. Count-based resolver: ANY single match returned exact, so a unique NAME
   auto-selected; caught by Party review; fixed via explicit declared
   identifier/advisory authority.
5. Cross-tenant relation enforcement existed only at the DB FK layer until
   Party's review added a generic service-layer guard (defense in depth).

Working hypothesis you must confirm, refute, or refine: the conformance/
fixture suite proves STRUCTURE (a projection/index/artifact exists) but
under-tests SEMANTICS (the declared invariant is actually enforced), and that
gap is the generator of defects 3-5. Assess whether it is systemic and what
else it hides.

# DIAL A — internal coherence (answer each)

A1. END-TO-END TRACE: trace the Party create path concretely through code —
    browser form -> app-server -> trusted request context ->
    RequestRuntimeView pin -> Semantic Operation gateway -> generic
    interpreter -> role assumption -> module DML + atomic trust facts ->
    read-back -> surface re-render. Is every seam single-authority and
    fail-closed? Name any layering violation, duplicated authority, or
    contract mismatch between packages.
A2. ADR-VS-CODE DRIFT: audit ADR-0001..0011 against the code as built. Name
    every material divergence (claimed-but-not-enforced, enforced-but-
    undocumented, or contradicted).
A3. SEMANTIC-CONFORMANCE COVERAGE (HEADLINE): for the declared semantic
    surface — constraint kinds (uniqueness/case-fold/relations), enforcement
    layers (service vs policy vs RLS vs FK), resolver authority, lifecycle
    rules, redaction/classification, actor attribution, tenant+environment
    scoping — does a test prove the BEHAVIOR is enforced, or only that the
    artifact exists? Enumerate declared-but-behaviorally-untested invariants.
    Then propose a concrete SEMANTIC-CONTRACT CHECKLIST: the invariant
    classes every module packet must prove, and where each belongs (compiler
    conformance vs metamorphic fixture vs per-module tests vs review
    charter).
A4. CROSS-PACKAGE SEAMS: reserved/deferred seams (generated storage,
    promotion, outbox delivery, recovery orchestration, retention, Q2/Q3,
    O1-O3 tiers) — still coherent and typed-diagnostic-guarded, or rotting?
    Version-stamp consistency across language v2 / envelope v1 / debt v2 /
    policy versions? Dead or contradictory code?
A5. SECURITY/TENANT POSTURE: tenant+environment scoping, forced RLS, the
    four-role separation (runtime / module-runtime / materializer-DDL /
    kernel), the O0 role-assumption bridge, redaction, no-hard-delete,
    no-existence-leak — consistent across ALL layers including the newest
    (surface binding, resolver, role bridge)? Any place the posture is
    asserted but not enforced?
A6. DETERMINISM/TIME: any remaining wall-clock, map-iteration-order, locale,
    or environment dependence in paths added since the G1 determinism gates
    (materializer, interpreter, surface binding, resolver)? Is trust
    atomicity truly universal for every write path that exists today?
A7. GATE ARCHITECTURE: given defects 1-5 escaped their packets' gates, are
    the suites positioned to catch the NEXT latent class before acceptance?
    What single gate or fixture addition would most reduce escaped-defect
    risk for the fan-out and G3?

# DIAL B — strategic direction (answer both, grounded in build evidence)

B1. IS THE NORTH STAR STILL THE RIGHT GOAL? A compiler-backed, zero-per-
    module-code, AI-operable ERP factory for $10-100M businesses — given
    everything the build has taught (cost of the foundation, the latent-
    defect tax, the payoff now visible in Party being definition-only).
    Verdict: KEEP | ADJUST | CHANGE, with reasoning. If ADJUST/CHANGE, be
    specific about what.
B2. IS THE APPROACH THE RIGHT PATH? Assess: the deep-foundation-first
    sequencing (G0-G2 before any sellable module), one-real-module-then-
    fan-out, step-packet cadence with dual-model review, modular monolith on
    one PostgreSQL, and the launch scope (master data -> inventory ->
    purchasing -> sales; no accounting). Competitive context you must weigh:
    shallow embedded-agent overlay products (e.g., YC-stage tools that mount
    an agent + generated UI on an existing SaaS API) ship a visible
    "AI customization" story in weeks; our differentiation is what they
    structurally cannot do (real typed storage, safe migrations, determinism,
    audit, zero-code whole modules). Given that, should anything re-sequence
    to get a visible end-user customization/authoring experience earlier
    without compromising the foundation? Verdict: KEEP | ADJUST | CHANGE,
    with specific re-sequencing recommendations if ADJUST.

# Boundaries

- Threat model for Dial A: honest-code defects and drift, NOT hostile input
  or obfuscation; do not demand adversarial hardening.
- Do not relitigate ratified constitutional choices as Dial-A "bugs"
  (PostgreSQL sole provider, one release authority, additive-only evolution,
  no EAV, human-controlled activation, frozen contracts). Dial A asks
  whether they are correctly IMPLEMENTED; Dial B may question direction at
  the strategic level.
- Wide coverage, finite depth: rank what matters, no exotic hypotheticals,
  no padding. Evidence with file references for every Dial-A finding.

# Mandatory response format

- DIAL A FINDINGS: ranked most-severe first, max 12. Each: [CRITICAL |
  MATERIAL | MINOR], evidence (file/path), why it matters, smallest fix, and
  suggested disposition (fix-before-fan-out | fix-in-named-later-packet |
  record-as-future-work | dismiss).
- SEMANTIC-CONTRACT CHECKLIST: your concrete A3 output (invariant classes x
  where enforced).
- DIAL B VERDICT B1 (goal): KEEP | ADJUST | CHANGE + reasoning.
- DIAL B VERDICT B2 (approach): KEEP | ADJUST | CHANGE + reasoning +
  specific recommendations.
- NEW CONCERNS: up to 3 fundamental issues not asked about.
- Argue only where you have a real position; do not manufacture findings.
