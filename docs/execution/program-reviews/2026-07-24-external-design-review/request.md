Provenance: source `/home/rvham/novel-problems-review.md`, 2026-07-24; this is the request answered by the archived external design review.

# Independent review of derived design decisions — 2rain compiler-backed ERP platform

You are an independent senior systems architect. You have no prior context on this
project. Below are seven design problems that had no off-the-shelf answer and were
derived from first principles by an engineering team (with adversarial multi-model
review). Your task is to revisit them independently: for each, judge whether the
derived solution is sound, whether a better-known or simpler solution exists that
was missed, and what failure modes remain. Be direct — if a decision is wrong or
reinvents something standard, say so plainly. Do not be agreeable.

---

## System context (read first)

**What it is.** A compiler-backed, AI-native ERP application platform. Humans and
AI compose ERP applications as declarative definitions in a closed canonical
language. A deterministic, hermetic compiler lowers ONE definition into ALL
projections — typed storage + additive migrations, DTO/validation, semantic query
and operation contracts, UI surfaces, agent contracts, reporting, audit bindings,
conformance assertions — emitted as an immutable, content-addressed release
(Merkle manifest). A human-approved compare-and-swap pointer activates a release
per (tenant, environment); every request pins exactly one release view. All reads
flow through one Semantic Query gateway, all writes through one Semantic Operation
gateway, both served by a single generic interpreter that reads compiled
projections. Every business write commits atomically with its audit evidence.
No hard deletes — archive/restore only.

**North star.** An "ERP factory": a tenant or an AI authors a whole module, or a
one-field change, as a declarative definition, and it becomes a complete,
safely-evolvable part of the running product with ZERO per-module platform code.
Launch product: inventory/purchasing/sales ERP for $10–100M businesses.

**Hard constraints (ratified; treat as given, but you may challenge them explicitly
if you believe one is the actual root problem).**
- PostgreSQL is the sole launch storage provider; one shared database.
- Exactly ONE release authority. The predecessor system died of dual metadata
  lineage (a static registry plus a runtime overlay both claiming authority) and
  deployment-global activation (one mutable pointer for all tenants).
- Additive-only schema evolution at launch (no destructive/retire migrations yet).
- NO EAV or generic JSON blob escape hatch — real typed columns.
- Tenant isolation via tenant_id + environment_id + forced row-level security.
- Human-controlled activation: an immutable human approval authorizes exactly one
  activation attempt; AI may prepare candidates and evidence but never approve or
  activate its own output.
- Authorization is deliberately NOT baked into the pinned release — it stays live
  and deny-capable per request even though the definition is pinned.
- Modular monolith, TypeScript, one web/API process + one worker.

---

## Problem 1 — Compiler-owned DDL applied at activation, across tenants on
## different releases sharing one physical table

**The problem.** If a newly authored entity must get real typed storage with no
engineer hand-writing a migration, the compiler must own the DDL. But releases are
per-tenant: tenant A may sit on release root R1 while tenant B is on R2 and tenant
C has an in-flight prepared candidate — all against the SAME shared physical table
(shared table + tenant_id, not per-tenant schemas). A naive pairwise "migrate from
root X to root Y" model is wrong the moment a second tenant exists on a third root.

**What was derived.**
- Two desired-state authorities with EXCLUSIVE, non-overlapping object ownership:
  hand-written kernel migrations own the platform schema; the canonical release is
  the sole authority for a disjoint managed-module schema. One materialization
  executor, one ordering/advisory-lock discipline shared with the kernel migration
  lock (plus a starvation rule), one isolated DDL-capable role unreachable from the
  request path (the steady-state runtime role is DML-only).
- Transitions are ADDITIVE-ONLY and produce a physical SUPERSET satisfying every
  live release simultaneously: add tables/columns/indexes; never drop, rename, or
  retype in place. Old-release and new-release requests both work against the same
  tables during coexistence.
- Validity and drift are computed against the UNION of live roots in the
  environment (every tenant's active release plus non-terminal preparations), NOT
  pairwise. Element identity (not plan digest) is the convergence key, so two
  overlapping plans implying the same column emit byte-identical elements that
  converge idempotently.
- The compiler stays hermetic and pairwise; the union-of-live-roots computation
  lives only in the materializer (feeding a union into the compiler would destroy
  content-addressing).
- "Additive to the schema" is NOT "additive to behavior": a new NOT NULL, UNIQUE,
  CHECK, or FK can reject writes from an old release that cannot render the
  violation. So constraint tightening is two-phase — a new required field is
  physically NULLABLE during coexistence (the new release's validation enforces
  requiredness), and storage-level tightening is deferred to a later,
  separately-approved, generation-gated step. Every transition element carries a
  declared coexistence-impact class. Retype disguised as add-column + backfill +
  switch-read is declared UNSUPPORTED (no dual-write mechanism exists to make it
  truthful).
- Deferred tightening creates a first-class durable "tightening debt" record
  naming the blocking release roots and the specific old-release readers/writers
  (kept as distinct prior-vs-candidate identity sets, so a materializer knows
  exactly which writers must drain), surfaced in the drift report, with shipping
  the cleanup family as an admission requirement.

**Judge:** Is superset coexistence the right model here? Is union-of-live-roots the
right validity domain, or is there a cleaner formulation? Is the two-phase
constraint discipline correct, or is there an additive change class still unsafe
under live old-release traffic that this misses? Does the "tightening debt"
mechanism actually force the debt to be paid, or does it normalize
nullable-forever?

---

## Problem 2 — Trustworthy drift detection when the thing that writes the schema
## also writes the audit ledger

**The problem.** With compiler-owned DDL, the live database will legitimately
contain schema objects beyond what any single release implies (other tenants'
needs, prepared-but-never-activated candidates, prior compatible generations). So
drift detection cannot be "the catalog equals the active release." But if surplus
objects are justified by ledger rows, a buggy or compromised materializer could
create both a rogue object AND its own justifying ledger row, defeating the check.

**What was derived.**
- Drift = ACCOUNTED ADDITIVE CLOSURE: everything implied by the union of live
  roots must exist with exact type/constraint/RLS/grant shape; every surplus
  element must be accounted for; anything else is drift.
- Crucially, "accounted for" means the verifier RECOMPUTES the element's expected
  shape from content-hash-verified immutable artifact bytes reachable from a
  persisted release/receipt chain. Ledger row shape-columns are NEVER trusted.
  (Shape-from-artifact-bytes defeats the buggy-materializer case;
  shape-from-ledger-columns does not.)
- Coverage is OBJECT-level, not schema-level: every object of every kind (tables,
  columns, sequences, defaults, constraints, indexes, policies, functions,
  triggers, ownership, grants) across every non-system schema must be covered by
  exactly ONE verifier, and unknown object kinds fail closed. (A real finding:
  an internal schema holding the migration ledger was invisible to every verifier.)
- Ledger tables are writable only by the materializer role.

**Judge:** Is provenance-by-recomputation the right trust boundary, or is it
solving a threat that a simpler design (e.g. separation of duties, or signing)
handles better? What can still hide? Is object-level exhaustive coverage
maintainable in practice, or will unknown-kind fail-closed become an operational
tax?

---

## Problem 3 — Human-approved activation composed with online schema migration

**The problem.** Constitution says an immutable human approval authorizes exactly
one activation attempt, and a FAILED attempt requires a fresh approval. But real
schema preparation (DDL, index builds, backfills) is long-running and cannot sit
inside the pointer-swap transaction. So: what may run BEFORE the human approves,
what must run inside the approved attempt, and where exactly is the
failed-vs-resumable line for storage?

**What was derived (this was the most contested decision; two independent
reviewers split on it and were reconciled).**
- TWO-CLASS PREPARATION. Genuinely INERT schema elements (create table, add
  nullable column, index on objects introduced by the same plan) may be applied
  BEFORE approval — the governing ADR explicitly permits non-humans to prepare
  candidates and evidence, and preparation is not activation. DATA-MUTATING
  elements (backfills) and data-SCANNING validation execute ONLY inside the
  claimed, human-approved attempt.
- Classification uses three independent axes (semantic effect, data effect,
  operational risk) rather than a binary. Concretely: an index build on an
  existing populated table is NOT inert (lock_timeout bounds acquisition, not
  build duration or lock hold); ADD CONSTRAINT ... NOT VALID still constrains new
  writes; VALIDATE scans live data and can fail on another tenant's rows.
- Receipts carry a prepared-subset digest plus a remaining-plan digest, and a final
  READY_TO_SWAP live-catalog receipt gates the compare-and-swap. Preparation and
  the pointer swap are separate transactions; the swap stays short.
- Executor "APPLIED" state means live-catalog-inspection evidence, never
  step-log evidence.
- Terminal vs resumable: a definitive SQL/validity/plan mismatch is terminal and
  consumes the approval; a lock timeout, connection loss, or ambiguous commit is
  RECONCILING, and catalog postconditions decide whether the same attempt resumes.
- The rendered approval diff must disclose per-element applied-vs-pending state,
  so a human never approves already-executed DDL described as future work.
- Backfill admissibility invariant: a backfill element is admissible only if
  new-release reads are correct with residual un-backfilled rows
  (coalesce-at-read); backfill completeness is never load-bearing.

**Judge:** Is pre-approval inert DDL on shared production tables defensible under a
human-controlled-activation constitution, or does it normalize unapproved schema
mutation? Is the inert/data-mutating line crisp enough to freeze? Is the
terminal-vs-reconciling split right? What does the cross-tenant DDL lock blast
radius do to availability (an ACCESS EXCLUSIVE lock on a shared table queues behind
every tenant's traffic)?

---

## Problem 4 — Conformance that cannot be satisfied by self-attestation

**The problem.** The platform's core claim is "one definition lowers to ALL
projections or compilation fails." The conformance gate was found to credit an
entity with verification evidence (structure, provider, UI, agent, migration,
recovery) if the definition merely DECLARED a JSON array listing those evidence
kinds. A module could claim recovery evidence with no recovery test in existence.
More broadly, an independent review confirmed a systemic pattern: the test suite
proved STRUCTURE (an index/projection/artifact exists) but did not execute
SEMANTICS (the declared invariant is actually enforced). Concrete escapes found
this way: a case-insensitive-unique contract rendered as a plain unique index (so
"P-001" and "p-001" coexisted); a resolver that returned "exact" for any single
match, so a unique NAME auto-selected; a declared archive-restrict rule silently
dropped so a parent could be archived with active children; enum domains lowered
to unconstrained text; a field declared non-searchable and confidential still
matched by search.

**What was derived.**
- The verification plan becomes EXECUTABLE: content-derived scenario IDs generated
  from compiled semantics, requiring linked, executed, real-provider proof digests
  with matching scenario fingerprints. Declaration labels never satisfy
  conformance. (A first review round caught that fabricated proof objects could
  otherwise satisfy it — hence content-derived fingerprints plus provider identity.)
- Prior artifacts missing newly-required semantic metadata fail closed as
  UNSUPPORTED rather than silently skipping enforcement.
- A "semantic-contract checklist" enumerates invariant CLASSES (closed input/DTO
  types and enum domains; uniqueness and normalization; relations including
  archived targets; lifecycle/no-delete; tenant+environment/policy;
  resolver authority; searchable declaration; classification/redaction/actor
  attribution; confirmation/idempotency/concurrency; trust atomicity including
  denied/failed evidence; query result semantics; determinism; verification-
  evidence honesty), each mapped to the layer that owns its behavioral proof
  (compiler conformance vs a generic metamorphic fixture vs per-module tests vs
  human review charter). Each needs paired positive AND negative probes, and the
  gate must FAIL if either a declaration or an enforcement layer is removed.

**Judge:** Is executable-verification-with-proof-digests the right structural
answer to self-attestation, or over-engineering versus simply requiring real tests?
Is the invariant-class taxonomy complete? What class of declared-but-unenforced
semantic would still slip through this?

---

## Problem 5 — "Registration is data, not code"

**The problem.** For zero-per-module platform code, something must serve queries
and operations for a module that did not exist when the platform shipped. The
obvious industry approach is code generation (emit per-module handlers/repositories
from the definition). But emitted code means every tenant- or AI-authored module
needs a build/deploy artifact, which kills the "author a definition, it's live
after approval" premise — and risks recreating a second authority lineage.

**What was derived.**
- ONE generic platform interpreter serves all queries and operations by reading the
  pinned release's compiled projections at request time. Registration is DATA.
  No per-module handler code is emitted, ever. Module packages contain zero
  hand-written SQL or handlers; a dependency-boundary rule forbids SQL/driver
  imports in domain packages; only the generic executor touches module storage.
- Proven by a METAMORPHIC test: a freshly generated, randomly-namespaced definition
  is compiled at test time and served end-to-end (DDL, queries, operations, audit)
  with zero emitted TypeScript.
- The first real module (a Party/customer master with a parent-scoped child) is
  pure declaration data with no production module code.

**Judge:** Is interpretation-over-generation the right bet at ERP scale? What are
the real costs (per-request work, query planning, type safety, debuggability) and
at what point does it break down? Is there a hybrid that preserves
author-a-definition-and-it's-live without full runtime interpretation? Note one
known scaling concern already flagged: every request currently re-reads and
re-hashes release artifacts for verification, which will not scale without a
verified-once content-addressed cache.

---

## Problem 6 — Resolver authority (when may a system auto-select a record?)

**The problem.** An AI agent or UI resolves a human-supplied string ("Acme") to a
record. The naive implementation returns "exact" whenever the query matches exactly
one row — so a unique NAME auto-selects, and the agent acts on a record the user
never confirmed. The predecessor system's weak fuzzy auto-selection was explicitly
rejected as a defect. But the platform also bans heuristics and implicit
inference — deriving authority from "this field has a unique constraint" or from
field names would reintroduce exactly the inference the architecture forbids.

**What was derived.**
- Match authority is DECLARED per key in the compiled query, as a language change
  (versioned bump, not silent widening): `identifier` (authoritative — a unique
  exact match may auto-select) vs `advisory` (name-like — ANY match returns
  AMBIGUOUS and never auto-selects, even when exactly one record matches).
- The compiler fail-closes any resolve query that does not declare authority.
- Missing and cross-tenant identifiers return not-found without leaking existence.
- Deriving authority from the storage uniqueness constraint was explicitly
  considered and REJECTED: it couples two orthogonal concerns (storage uniqueness
  vs resolve authority) and is the implicit inference the architecture bans.

**Judge:** Is explicit declared authority right, or is rejecting the
uniqueness-derived shortcut dogmatic? Is the binary identifier/advisory
sufficient, or is there a needed middle (e.g. confidence-ranked candidates with
mandatory confirmation)? How should this interact with an AI agent's UX so
"ambiguous" doesn't degrade into an unusable assistant?

---

## Problem 7 — Reusable domain capability vs one-off feature (the upcoming one)

**The problem, still ahead.** The next major stage builds inventory truth:
append-only posted movements, derived on-hand/reserved/available read models, and
reservation of scarce stock under concurrency. The trap: implementing reservation
and posting as inventory-specific logic. Other domains need the same semantics —
work orders reserve and consume parts; sales orders reserve then ship; rentals
allocate scarce assets. If reservation is inventory-private, every later domain
either reimplements it or patches stock directly, and the zero-dev-code north star
dies for anything non-CRUD.

**The framing derived so far (not yet built).** A three-tier realization model:
Tier A = declarative composition over general primitives (forms, registers,
approvals, simple case management); Tier B = REUSABLE DOMAIN CAPABILITY for
semantics needing specialized invariant-preserving logic (inventory movement,
reservation allocation, pricing, tax, work-order costing) — built once as a
versioned domain pack with its own semantic queries/operations, composed by many
modules; Tier C = controlled signed extension for genuinely novel algorithms.
Rules already fixed: quantities are DERIVED from posted append-only movements
(no editable balance column is ever a peer source of truth); every capability must
declare where it composes with existing movement/reservation/receipt/shipment
contracts; consumers use the reservation capability rather than patching stock.
Known prerequisite gap: the operation layer currently has no idempotency contract,
so a retried post could double-post — which is fatal for a movement ledger and must
be solved before this stage.

**Judge:** Is the Tier-A/B/C taxonomy a real distinction or a rationalization? What
is the right contract shape for a reservation/allocation capability that inventory,
work orders, sales, and rentals can all compose without any of them special-casing?
How should idempotency be structured so one source effect can never post twice
across retries, crashes, and concurrent writers? What breaks first at scale?

---

## What to produce

For EACH of the seven problems:
1. VERDICT: SOUND | SOUND-WITH-AMENDMENTS | UNSOUND | REINVENTS-A-STANDARD-SOLUTION
2. Your reasoning, concise and concrete.
3. If a known standard solution, product, or paper already solves it better, NAME
   it specifically and say what it would replace.
4. The strongest remaining failure mode, and the smallest change that addresses it.

Then, overall:
- Which of these decisions is most likely to be regretted, and why?
- Which is the most genuinely valuable/defensible, and why?
- Anything the framing above is blind to.

Argue only where you have a real position; do not manufacture objections, and do
not praise a decision merely because it is elaborate.
