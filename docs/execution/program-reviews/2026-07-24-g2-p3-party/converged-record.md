# Program review — G2-P3 Party milestone (2026-07-24) — CONVERGED RECORD

Scope: whole app at main `12e6c66` (G0 through G2-P3b, Freeze F ratified, Freeze G
established), before Catalog/Location fan-out. Reviewers: codex `gpt-5.6-sol` at
reasoning effort MAX and Fable 5 at max, independent, identical charter
(`charter.md`), replies `r1-codex-reply.md` / `r1-fable-reply.md`. Adjudicator:
orchestrator. CONVERGED IN ONE ROUND: zero material contradictions; identical
Dial-B verdicts; union of findings adopted.

## Headline

The spine is sound — both reviewers independently probed and PASSED: release
pinning + per-artifact hash verification, CAS activation + READY_TO_SWAP,
tenant/environment isolation at service+RLS+FK+pool layers, four-role
separation with one-directional role bridge, case-fold uniqueness, resolver
authority, zero-per-module-code (metamorphic proof), trust atomicity for
successful writes, drift provenance-by-recomputation. The charter hypothesis is
CONFIRMED AND REFINED by both: the suite proves STRUCTURE but does not execute
declared SEMANTICS — and in two places it actively enshrines the gap (hidden
auto-confirm asserted by test; self-attested evidence kinds). The defect ring is
in the declared-semantics enforcement layer around a healthy kernel.

## Dial B (identical verdicts)

- B1 GOAL: KEEP. Party validates the thesis (definition-only module, zero
  production module code, real storage/trust/RLS/browser). The moat is
  structurally real; defects show the compiler proves less than claimed — a
  verification problem, not a thesis problem. Qualification adopted: "zero
  per-module code" = no per-module production platform branch; modules still
  declare semantic scenarios, and the factory must EXECUTE them.
- B2 APPROACH: ADJUST (sequencing only). Keep: deep-foundation-first (paid
  out — retire the debate), one-real-module-then-fan-out (caught 4 of 5
  historical defects), step-packets + dual fresh review, modular monolith,
  no-accounting launch scope. Adjust: corrective packets before fan-out (below);
  keep the cut's P4→P5→P6/P7 order; Catalog's acceptance criterion = zero press
  changes (factory test — if it needs a press change, stop and harden before
  Location); thin authoring walkthrough after fan-out before G3; define an
  accounting handoff/export contract before pilots.

## Consolidated findings and dispositions (adjudicated union)

### PR-1 — Mechanical gate-integrity corrective (fix-before-fan-out)
1. Browser gate BROKEN at HEAD (Fable F1): fixture import added by G2-P3c
   crosses ESM/CJS package scope; `test:browser` fails to load; escaped because
   packet gate lists are per-packet subsets. Fix import via workspace specifier;
   verify full browser suite green.
2. `test:unit` unquoted glob silently discovers 3 of 6 files (codex F9): make
   discovery explicit/self-checking (assert discovered file set).
3. CI omits `test:compiler`, `check:schema`, agent tests (codex F9): add them.
4. `localeCompare` in determinism/evidence paths (both; 3 sites: interpreter
   compareEntry ~1349, migrations.ts ~69, module-storage-transition.ts ~123/135):
   replace with code-unit comparator; add a non-C-locale CI probe.
5. ADR-0011 status says "candidate" vs ledger "ratified" (codex F12): update.
6. DOCTRINE: acceptance requires FULL CI matrix green at the integrated SHA
   (never a packet-chosen subset); ledger records the CI run.

### PR-2 — Critical semantic-preservation corrective (fix-before-fan-out)
1. Self-attesting conformance evidence (both): verification plan becomes
   EXECUTABLE — compiled scenario IDs + linked executed real-provider results;
   declaration labels never satisfy conformance.
2. `archiveBehavior: restrict` declared→dropped (codex F2): carry into runtime
   contract; reject parent archive with active dependents and child
   create/restore against archived parent; fix the Party test that blesses it.
3. Enum/value domains not runtime contracts (codex F4): emit versioned
   field/input contract (kinds, enum IDs, requiredness, bounds, writable set);
   validate generically before DML; PostgreSQL CHECK defense-in-depth.
4. `searchable:false` + confidential field matched by search (Fable F4):
   restrict search columns strictly to `searchMapping==='normalizedTextIndex'`;
   metamorphic probe (searchable:false never matches).
5. Search uses `lower()` vs pinned case-fold divergence (both): one declared
   normalization primitive across storage/search/resolve; decide NFKC policy
   for business keys BEFORE Catalog SKU (Fable F9).
6. Raw PostgreSQL error leak incl. physical index names (Fable F6): map
   SQLSTATE 23505/23503 → typed MODULE_UNIQUE_VIOLATION etc. via reverse
   physical-name mapping; extend assertNoPhysicalDetails to error paths.
7. Declared-semantics behavioral suite: implement the semantic-contract
   checklist (below) as a required gate generated from compiled semantics, run
   against the metamorphic module + Party, positive and negative per invariant.

### PR-3 — Critical operation-mediation corrective (confirmation before
### fan-out; remainder before G2-P8 durable import / G3)
1. Confirmation grants (both; before fan-out): typed server-issued grant bound
   to view/operation/target/input digest/revision; gateway enforces
   `confirmation!=='none'` fail-closed on every channel; real two-step confirm
   in surface runtime; delete hidden `confirmed=yes`; invert the test that
   asserts the bypass.
2. Classification enforcement (both): canonical field classification flows to
   change documents (replace blanket 'SENSITIVE'), query/read-back/agent/
   reporting decisions; until enforced, non-public classifications fail
   compilation as unsupported (codex's fail-closed interim).
3. Non-accepted invocation evidence (both): wire gateway deny + executor
   failure paths to `recordNonAcceptedInvocation` with typed codes; trusted
   channel attribution at entry (stop hardcoding 'API').
4. O0 idempotency (both): scoped durable idempotency receipt (principal +
   pinned view + operation + canonical input digest → same result); outbox
   dedup key must not embed the random invocationId; UI retains key across
   retries. MANDATORY before G3 postings (ADR-0007's no-double-post depends).
5. Q0 envelope completion (codex F10 → G2-P5, already before fan-out in the
   cut): closed argument schemas, limit+1 cursor/truncation, freshness/
   provenance; no silent truncation.
6. LifecycleService dead/incompatible (codex F6): align IDs + input schema and
   route lifecycle through it, or formally supersede it in ADR-0010 — one
   lifecycle authority, not two.

### Recorded future work (named, not now)
- Verified-once content-hash cache for per-request artifact re-verification
  (Fable NC1) — dedicated packet before G3 load.
- Trust read model / activity rail packet (Fable NC3) — governed semantic read
  over trust facts; unblocks classification-aware audit UI; prevents raw-SQL
  temptation.
- Runnable app composition outside test fixtures (codex NC1) — demo/deploy
  checkpoint, pairs with the authoring walkthrough.
- Authoring walkthrough packet (both, Dial B): add-one-field → compiled diff →
  approval → activation → rollback, on the existing press; after P6/P7, before
  G3.
- Accounting handoff/export contract doc before pilots (codex NC3).
- Fuzzy-resolver 100-record candidate bound documented (Fable F10) → Q1/search.

## Semantic-contract checklist (merged; the A3 artifact)

Every DECLARED invariant class gets paired positive/negative BEHAVIORAL probes
at the owning layer. Rows (class → where): closed input/DTO types + enum
domains → conformance + metamorphic fixture; uniqueness/normalization (incl.
case-fold + NFKC policy) → fixture; relations (missing/cross-tenant/
cross-environment/ARCHIVED target; service+RLS+FK layers) → fixture + module;
lifecycle/no-delete (incl. archive-restrict, restore conflicts, revision race)
→ fixture; tenant/environment/policy (two tenants AND two environments; DENY
paths) → fixture + module; resolver authority → fixture (PROVEN); searchable
declaration → fixture; classification/redaction/actor attribution → fixture +
conformance; confirmation/idempotency/concurrency → gateway unit + fixture;
trust atomicity + failure/deny evidence → fixture + trust suite; query result
semantics (paging/truncation/archived defaults/Unicode) → fixture; release/
version/determinism (locale/time/cwd variants; consumer suites on output
change) → determinism suite (PROVEN pattern, keep); verification-evidence
honesty (declared kind ⇔ executed oracle) → conformance gate; gate completeness
(full CI at integrated SHA) → doctrine/ledger. Module packets cite checklist
rows, not free-form evidence; reviewers receive the compiled invariant matrix
and verify each declared semantic has a behavioral oracle (codex adjust 6).

## Sequencing decision

PR-1 (Mechanical) → PR-2 (Critical) → PR-3 confirmation slice (Critical) →
then G2-P4 → G2-P5 (completing PR-3.5/Q0) → Catalog (factory-test criterion)
→ Location → PR-3 remainder (idempotency/invocation) with G2-P8 → authoring
walkthrough → G3. Doctrine pass lands with PR-1.
