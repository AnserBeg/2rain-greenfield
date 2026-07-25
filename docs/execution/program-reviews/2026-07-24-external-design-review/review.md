# External design review — seven derived-decision problems

Provenance: independent external AI review, 2026-07-24. Reviewed ONLY the seven problem
summaries in `/home/rvham/novel-problems-review.md` (no repository access), per that
document's framing. Reproduced verbatim from the session transcript by the orchestrator.
Where it says "you missed X," it means X was absent from the summary; discount where the
repo already covers it (the orchestrator noted three such cases: element reference-counting
is specified in converged-verdict A11; uniqueness already lowers to a storage constraint;
the artifact re-hash cache was already recorded as future work).

---

## Independent review

Reviewed only the seven summaries as written — no repo context, per the framing. Where I
say "you missed X," I mean X isn't mentioned in the summary; if it exists elsewhere,
discount accordingly.

### Problem 1 — Superset coexistence + union-of-live-roots

**VERDICT: SOUND-WITH-AMENDMENTS**

Superset coexistence is right and is not exotic — it's the expand/contract (parallel
change) pattern from Refactoring Databases (Ambler & Sadalage) generalized from 2 versions
to n. Union-of-live-roots is the correct validity domain; pairwise is provably wrong the
moment |live roots| > 2, and you identified that correctly. Element identity as convergence
key rather than plan digest is the right call and is the same insight as Kubernetes
server-side apply's field ownership: many actors declaring desired state over one object,
reconciled at field granularity.

That comparison exposes the gap. SSA tracks which claimants own each field, so when a
claimant leaves, its solely-owned fields become removable. Your model computes a union but
doesn't appear to reference-count it. Without per-element claimant sets you can never answer
"is this column still needed?" — which is precisely why tightening debt won't get paid.

Does tightening debt force payment? No. A debt record that names blocking roots, surfaced
in a report, with "ship the cleanup family" as an admission requirement, is a lint warning.
Nothing bounds how long a root stays live. The named prior art that solves this is F1's
online schema change (Rae/Shute et al., VLDB 2013): correctness there depends on bounding
version skew via schema leases — a server that doesn't renew stops serving, so you can never
have version N and N+2 simultaneously. Your design has unbounded skew by construction. A
tenant parked on R1 for eighteen months makes every intervening tightening permanently
uncollectible, and "nullable forever" becomes the steady state.

Additive changes still unsafe under old-release traffic that the summary misses:

- **RLS policies.** In PostgreSQL multiple PERMISSIVE policies OR together. If the live-root
  union includes a prepared, never-activated candidate whose policy is permissive, you have
  widened access for every tenant on every other release. This is a tenant-isolation hole
  created by preparation alone. Fix: release-emitted policies must be RESTRICTIVE only, with
  a single kernel-owned permissive base; and a table's policy set is owned immutably by the
  release that introduced the table.
- **Triggers and STORED generated columns.** Both are additive DDL that changes old-release
  write semantics and (for generated columns) force a table rewrite.
- **Volatile column defaults** — table rewrite. Non-volatile defaults are metadata-only since
  PG 11; volatile must be banned outright.
- **Partial unique indexes** (`UNIQUE ... WHERE archived_at IS NULL`) — collides old-release
  writers that don't share the new release's archival semantics.
- `ADD FOREIGN KEY ... NOT VALID` still takes SHARE ROW EXCLUSIVE on both tables — so a new
  table referencing a shared one is not lock-free.
- **Plan regression.** A new index changes plans for old-release queries.

The invariant that actually makes additive-superset safe, and which should be stated as law
rather than left implicit: the interpreter must never emit `SELECT *` and never emit `INSERT`
without an explicit column list. Everything else follows.

On declaring retype UNSUPPORTED: honest, but it's a real functional hole for an ERP —
widening a money or quantity column is routine. And the premise is wrong: a dual-write
mechanism does exist (a trigger), and pgroll (Xata) productizes exactly this for Postgres —
per-version views over one physical table plus trigger-backed dual-write. I think you're
right to reject the trigger half (release-versioned mutable behavior living in the database
is a second authority lineage, which is what killed the predecessor), but you should reject
it explicitly and by name rather than claiming no mechanism exists. Consider adopting the
view half without the trigger half: each release's read/write surface is a per-release view
over the superset table. Views are catalog-only, content-addressable per root, and turn
coexistence from a discipline into a structural guarantee. Separately, carve out a whitelist
of provably no-rewrite type changes (`varchar(n)→varchar(m>n)`, `varchar→text`) rather than
banning the whole class.

**Strongest remaining failure mode:** unbounded root skew makes the superset monotonically
grow and the debt permanently uncollectible. **Smallest change:** give every activated root a
coexistence horizon (an absolute deadline recorded at activation). Refuse admission of any
new release into an environment containing a root past its horizon. That converts a report
line into a forcing function, and it's F1's lease idea at release granularity.

### Problem 2 — Provenance by recomputation

**VERDICT: SOUND-WITH-AMENDMENTS**

Recomputing expected shape from content-hash-verified artifact bytes rather than trusting
ledger columns is correct, and it's the same principle as reproducible-build verification and
Nix derivations: trust the inputs' hash, not the builder's claim. Never trusting
shape-columns is the right instinct and I'd keep it.

But recomputation defeats the buggy materializer, not the compromised one. A compromised
materializer doesn't fabricate shape columns — it inserts a receipt pointing at a
genuinely-compiled artifact it authored itself. Recomputation then succeeds and the rogue
object is "accounted for." The trust anchor has to be the human approval, not the receipt
table, and it has to be unforgeable by the materializer role — which means an asymmetric
signature over (approval → release root), verified with a public key the materializer cannot
use. Signing isn't an alternative to recomputation; it's the missing half. Name: in-toto/SLSA
attestation shape, or plain Ed25519 with the signing key in a KMS held by the approval
service.

What can still hide:

- **Rows, not objects.** Authorization is deliberately live and unpinned — so the
  highest-value target in the system (authz tables) has no content-addressing, no drift
  detection, and no conformance story anywhere in these seven problems. A rogue row is
  invisible to a schema verifier.
- **Database-global objects.** A per-schema sweep misses `pg_event_trigger`, roles and role
  memberships, `ALTER ROLE/DATABASE ... SET search_path`, `ALTER DEFAULT PRIVILEGES`,
  extensions, publications/subscriptions (a logical replication publication is a silent
  exfiltration channel), foreign servers and user mappings, and SECURITY DEFINER functions.
  Your real finding — an internal ledger schema invisible to every verifier — is the same bug
  class one level up.
- **The verifier itself.** If it shares a process or connection pool with the materializer, a
  compromise lies about results. It needs its own process, role, credential, and signed
  output.
- **TOCTOU:** create → verify → alter → revert.

Is exhaustive object coverage maintainable? Only if it isn't a hand-maintained kind list.
Enumerate via `pg_depend`/`pg_describe_object` and require every OID in non-system namespaces
to be claimed by exactly one verifier. Then pin a catalog "kind inventory" fixture so a
PostgreSQL major upgrade introducing a new relkind fails at build time rather than becoming a
3 a.m. fail-closed outage. Also distinguish blast radius: unknown-kind must block activation,
never serving. That single distinction is what keeps fail-closed from becoming an operational
tax.

**Strongest remaining failure mode:** a compromised materializer self-justifying via a
self-authored artifact chain. **Smallest change:** a superuser-owned DDL event trigger
appending every DDL statement to an append-only log in a schema the materializer role cannot
write. Cheap, unbypassable by a non-superuser, and gives drift detection a second,
independently-privileged witness — which is what defeats both self-justification and TOCTOU.

### Problem 3 — Approval composed with online migration

**VERDICT: SOUND-WITH-AMENDMENTS**

Pre-approval inert DDL is defensible, and the principled line is sharper than the one you
drew: approval governs observable behavior change, not physical bytes. An unreferenced
nullable column on a table no live release reads or writes is unobservable; approving it
would be ceremony. That reasoning holds.

But it doesn't survive contact with your own example. `CREATE INDEX CONCURRENTLY` on an
existing populated table is semantically inert and a production event affecting every tenant
on that shared table. Availability is observable. You have three axes and then collapse them
into a pre/post-approval binary using semantic + data effect — so operational risk, the axis
that actually matters for shared tables, doesn't gate anything.

The clean fix is two approval kinds, not a finer classification: an operational-window
approval (may this run against shared production now?) and an activation approval (may this
release become live?). They have different approvers, different lifetimes, and different
failure semantics. Pre-approval preparation then requires the first but not the second, which
is both honest and how every real change-management process already works.

Is the inert line crisp enough to freeze? Not yet. Missing edges: volatile defaults (rewrite —
ban); STORED generated columns (rewrite + affects old writers); `ADD FOREIGN KEY ... NOT VALID`
(SHARE ROW EXCLUSIVE on both tables); and `CREATE INDEX CONCURRENTLY`, which is
non-transactional and on failure leaves an INVALID index — a state that is neither applied nor
absent. `indisvalid` must be part of the declared shape or your catalog postcondition rule
silently accepts a broken index.

Terminal vs reconciling is the right split but the mechanism is more complicated than it needs
to be. PostgreSQL has transactional DDL: end each DDL step by inserting its step receipt in the
same transaction as the DDL. Then "did it commit?" is answered by reading a row, not by
inferring from catalog shape. Catalog inspection stays as a cross-check, but the atomic marker
is the primitive. `CREATE INDEX CONCURRENTLY` is the sole exception and needs the `indisvalid`
rule above.

The backfill admissibility invariant (new-release reads correct with residual un-backfilled
rows; completeness never load-bearing) is the best single decision in this problem. Keep it.

Cross-tenant lock blast radius: this is your top availability risk and it is not fully
engineerable away. Standard mitigations — small `lock_timeout` (100–500ms) with jittered retry,
one object per transaction, never take DDL locks in a transaction that has already done work,
and an idle-in-transaction watchdog — bound the acquisition, and the killer is lock queue
convoying: a blocked ACCESS EXCLUSIVE request queues ahead of all subsequent readers, so a
30-second blocker stalls every tenant on that table. The Braintree and GoCardless
zero-downtime-Postgres playbooks are the canonical write-ups.

**Strongest remaining failure mode:** one tenant's authoring causes another tenant's latency
incident, with no contractual expression of that fact. **Smallest change:** publish it as an SLA
rather than pretending otherwise — a declared per-environment maintenance semantics. If that's
commercially unacceptable, the constraint to revisit is not this design but "one shared
database": large tenants get their own schema or database, and the shared table stays for the
long tail.

### Problem 4 — Conformance that resists self-attestation

**VERDICT: SOUND**

Content-derived scenario fingerprints plus real-provider proof digests is the right structural
answer, given an untrusted-author threat model — which you have, because tenants and AI author
modules. If tests always ran in platform-controlled CI on platform-controlled infra, the digest
chain would be ceremony and "require real tests" would suffice. State which model you're in;
you're in the untrusted one, so keep the machinery — but also attest the runner identity, not
just the provider.

One requirement you wrote is a standard technique described longhand: "the gate must FAIL if
either a declaration or an enforcement layer is removed" is mutation testing. Don't hand-write
removal probes. Run Stryker against the compiler and interpreter, map each invariant class to
mutation operators, and require a per-class mutation score. That makes negative probes automatic
and non-forgeable, and it replaces a large amount of bespoke gate logic.

The class that still slips through: concurrency. Your probes are sequential; your fingerprints
are content-derived from static semantics. Case-insensitive uniqueness can be "fixed" by a
read-then-write check in the interpreter that passes every sequential probe and still admits
`P-001`/`p-001` under two concurrent inserts. That is the same bug you already found, surviving
the new gate. Same for allocation, idempotency, and lost-update invariants.

Two fixes, both small:

1. Uniqueness invariants must lower to a storage constraint, never application-level
   read-then-write. Case-insensitive → unique index on a normalized expression or a generated
   normalized column. Make the compiler refuse the application-level form.
2. For every uniqueness/allocation/idempotency invariant, the required proof must include a
   concurrent probe: N parallel attempts, exactly one success. Linearizability/anomaly checking
   is the mature version (Jepsen's Elle, or Porcupine) if you want it later.

Second class: invariants about absence. "Confidential field never reaches an unauthorized
surface" cannot be proved by enumerated negative probes — your own search-leak example is
exactly this, and the surfaces multiply (error messages, audit payloads, agent tool schemas,
exports, search index, logs). Enumerating them is a losing game. Use canary values: inject a
unique token per confidential field in a test tenant and assert it never appears in any egress
channel. One generic fixture covers the entire class.

Determinism doesn't need to be a declared class — build twice in different environments and
diff. That's a CI job.

**Strongest remaining failure mode:** an invariant enforced correctly under sequential test and
violated under concurrency. **Smallest change:** the concurrent-probe requirement above, plus
the compiler refusing application-enforced uniqueness.

### Problem 5 — Registration is data, not code

**VERDICT: SOUND-WITH-AMENDMENTS**

The bet is correct for the stated goal, and it's well-precedented — but the precedents split in
a way that should worry you.

Salesforce runs metadata-driven multi-tenancy at enormous scale on shared tables — and avoids
runtime DDL entirely by using a universal data table with pivot-table indexes (i.e., the EAV you
banned). ServiceNow does the opposite: real tables, real runtime DDL, an interpreter over a
metadata dictionary, zero per-module code — on instance-per-customer infrastructure. SAP (ABAP
dictionary + CDS views) and Dataverse sit in between.

So: Salesforce does shared tables and avoids DDL. ServiceNow does DDL and avoids sharing. You
are doing both, and that combination is the one nobody ships — because it's the combination
where one tenant's authoring is another tenant's lock wait. That's the same conclusion Problem 3
reaches from the availability side, arrived at independently. It's the strongest signal in this
whole review that the shared-physical-table constraint deserves re-examination for large tenants.

The hybrid you asked about exists and is clean: generate types, interpret behavior. Emit
TypeScript types and typed clients for UI/agent consumers at build time; they are never consulted
at runtime, so they cannot become a second authority. You get static safety at the edges and keep
interpretive authority at the core. This is the right line and I'd draw it explicitly.

Real costs, and where it breaks:

- Artifact re-hashing per request — you flagged it; the fix is the obvious one (verify once at
  release load, cache by content address, immutable in-memory release view). Not a long-term risk.
- Query planning is the real one, and it's Postgres's planner, not yours. A naive interpreter
  emits universal SQL with optional predicates (`WHERE ($1 IS NULL OR col = $1)`), which is
  catastrophic for plan quality, and PG's generic-vs-custom plan heuristic makes it worse. Rule:
  emit shape-specialized SQL — one SQL text per distinct query shape, cached by shape hash. This
  is the single most important implementation rule for interpreter performance at ERP scale, and
  it also fixes `pg_stat_statements` observability for free.
- Debuggability: stack traces point into the interpreter. Mitigate with a SQL comment carrying
  (release root, query id) on every emitted statement.
- Where it breaks down: not CRUD. It breaks on (a) cross-entity transactional invariants that
  aren't declaratively expressible — which is exactly Problem 7's Tier B, so you've already seen
  the boundary; (b) bulk/batch work (MRP, period close, costing rollups) where per-row
  interpretation dominates and you need set-based lowering; (c) reporting and user-defined derived
  fields.

If you want the shape to copy for the query side, it's Apache Calcite (parse → logical relational
algebra → rule-based rewrite → physical SQL). There is no Calcite for TypeScript, so hand-rolling
is defensible — but hand-roll that architecture, not an ad-hoc SQL string builder.

**Strongest remaining failure mode:** plan quality degradation that appears only at customer data
volumes, with no per-module escape hatch to fix it. **Smallest change:** shape-specialized SQL
with a per-shape plan cache from day one, plus a declarative "query hint / index directive" in the
language so a pathological query has a declarative remedy that doesn't require platform code.

### Problem 6 — Resolver authority

**VERDICT: SOUND**

The cheapest correct decision in the set. Rejecting uniqueness-derived authority is not dogmatic,
and there's a better argument for it than "it's implicit inference": uniqueness is a contingent
property of the current data extent; authority is an intentional property of the identifier's
social contract. Employee names are unique in a 40-person company. That doesn't make "Bob" an
identifier. Use that framing — it survives contact with skeptics in a way the "no inference" rule
alone doesn't.

Three amendments:

1. Authority is a property of (key, scope), not key. "Line 10" is authoritative within an order.
   An identifier declaration must name its uniqueness scope, and the resolver must return
   ambiguous if the caller hasn't bound that scope — even when exactly one row matches globally.
2. The binary is fine; the missing piece is elsewhere. Don't add a third tier. Separate resolution
   from confirmation: advisory with exactly one candidate returns `SINGLE_CANDIDATE` (not
   `RESOLVED`, not `AMBIGUOUS`), and the operation declares whether confirmation is required, based
   on its own reversibility and blast radius. Reading Acme's address needs no confirmation; posting
   a $2M order does. Two orthogonal declarations composed at call time — that's what keeps the
   assistant usable instead of interrogative. Make the confirmation a typed token bound to
   (record id, operation, nonce), which is the same primitive as Problem 7's idempotency key.
3. The failure mode you haven't closed: the agent is the caller. If advisory resolution returns a
   candidate list to the LLM, the LLM will pick one — reimplementing the naive auto-select you just
   banned, one layer up. The guardrail must be structural: advisory resolution returns opaque
   handles plus display text, and the operation gateway refuses any handle not accompanied by a
   human-attested confirmation event (or an explicitly configured autonomous policy for that
   operation). Otherwise the whole decision is advisory in the wrong sense.

**Strongest remaining failure mode:** #3. **Smallest change:** opaque handles + gateway-enforced
confirmation binding.

### Problem 7 — Tier A/B/C, reservation, idempotency

**VERDICT: SOUND-WITH-AMENDMENTS (framing), with the taxonomy needing a real test and Tier C
needing to die or expire.**

Is A/B/C real? B vs A is real only if you can state the test that separates them, and you haven't.
Here's one that's crisp and predicts your own list correctly: Tier B owns a conservation law — an
invariant spanning multiple rows that must hold at commit, requiring a serialization point that
declarative composition cannot express. Inventory (quantity conserved across movements),
reservation (allocated ≤ available), accounting (debits = credits), gapless document numbering.
Tier A has no conservation law — per-row validity and workflow only. Adopt that definition and the
taxonomy stops being a rationalization.

Tier C is a rationalization. "Controlled signed extension for genuinely novel algorithms" is an
escape hatch that will absorb everything awkward, and signed code running inside the transaction is
platform behavior that isn't in the release — a second authority lineage, which is the exact disease
that killed the predecessor. Either delete it or rename it "not-yet-Tier-B" with a mandatory expiry
and a promotion path.

Contract shape for reservation. Don't invent one. The abstraction is a generic scarce-resource
subledger, and the cleanest published contract is TigerBeetle's two-phase transfers: reserve =
pending transfer with a timeout; consume = post-pending; release = void-pending; expiry = automatic
void; client-supplied unique transfer ids. Map it:

- Balance key = (resource_type, resource_id, + declared scope dimensions: location, lot, owner).
  Declared by the consumer, opaque to the capability.
- Postings: append-only, `(balance_key, dimension, delta, holder, source_ref, idempotency_key)`
  where dimension ∈ {on_hand, reserved, inbound, …}.
- Derived: `available = on_hand + inbound_committed − reserved`.
- Consumers declare only: their resource dimensions, their holder identity, and their
  partial/backorder/expiry policy. None of them touches postings. Work orders, sales orders, and
  rentals differ only in holder type and expiry policy — which is the test that the abstraction is
  real.
- The invariant the capability owns: `available ≥ 0` at commit, serialized on a per-balance-key
  anchor row.

On your rule "no editable balance column is ever a peer source of truth" — correct in spirit, but a
naive reading forbids the only thing that performs. Deriving `available` by scanning postings dies at
ERP volumes. The resolution: a materialized anchor row that is written only by the capability, only
in the same transaction as its posting, and periodically proven by recomputation from the ledger with
an alarm on mismatch. It's a derived cache with a proof obligation, not a peer authority. Say that
explicitly or someone will build the scan. Bonus: with an anchor row you can enforce
`CHECK (reserved <= on_hand + inbound)` as a real storage constraint — consistent with your
typed-columns instinct.

Idempotency — the structure that actually works:

1. Every mutating operation carries a client-supplied idempotency key. The compiler fail-closes
   operations that don't declare one — same discipline as resolver authority.
2. Unique index on (tenant, environment, operation, key). The operation's first act is to INSERT that
   row in the same transaction as the effect. There is no other correct primitive; anything with a
   separate check has a window.
3. Store a request fingerprint. Same key + different fingerprint = 409, never a silent replay of the
   old result.
4. Store the response so retries return an identical result, not just "already done."
5. Natural-key idempotency as belt-and-braces, and for a movement ledger this is the one that actually
   matters: unique `(source_type, source_id, source_line, revision, posting_role)`. A buggy client that
   regenerates its idempotency key still cannot double-post.
6. Concurrent duplicates need no extra machinery — PG blocks the second insert on the index until the
   first commits, then it gets a violation and returns the stored response. Bound the wait with
   `statement_timeout`.
7. Never "check exists, then insert." That's the read-then-write race that produced your
   case-insensitive-uniqueness bug.
8. Outbound side effects go through a transactional outbox keyed by the same idempotency key, or
   "atomic with audit" is true while the email still double-fires.

What breaks first at scale:

- Hot balance-key contention. One popular SKU at one location = one row lock = serialized throughput.
  Standard remedies in order: take the anchor lock last and hold it briefly; then sharded counters (N
  sub-rows per balance key, allocator picks a shard, available = sum, periodic reconciliation); then
  single-writer queue per key. This is the seat/ticket-inventory problem and the sharded-counter answer
  is proven.
- Partitioning. The movements table becomes your largest, and your own additive-only constraint means
  you cannot convert a huge table to partitioned later without a rewrite. Partition by (tenant, period)
  on day one. This is a decision your constraints force now, before the first movement is posted.
- Reservation expiry sweeps need a partial index on `expires_at WHERE status='held'`.

## Overall

**Most likely to be regretted:** shared physical tables + compiler-owned runtime DDL (Problems 1, 3, 5
jointly). Two independent lines of reasoning land here — the cross-tenant lock blast radius, and the
Salesforce/ServiceNow split where the industry picks exactly one of {shared tables, runtime DDL} and
you've taken both. It puts one tenant's authoring on the critical path of every other tenant's
availability, permanently. Runner-up: Tier C signed extensions, for reintroducing the dual lineage that
killed the predecessor.

**Most genuinely valuable:** Problem 4's executable verification. It's the only mechanism that keeps
"one definition lowers to ALL projections" from being a slogan, and the escapes you found
(case-insensitive unique, dropped archive-restrict, unconstrained enums, leaky non-searchable fields)
are a preview of what an unverified version of this platform ships continuously. Best
value-per-unit-cost: Problem 6 — small, correct, and it forecloses a whole class of agent misbehavior
for almost nothing.

**What the framing is blind to:**

1. **Authorization has no story in any of the seven.** Keeping it live and deny-capable is right, but
   that makes it the one high-value surface with no pinning, no content-addressing, no drift detection,
   and no conformance. That's the gap an attacker uses.
2. **Erasure.** No hard deletes + additive-only + append-only ledgers + one shared database = unbounded
   growth and no GDPR/right-to-erasure path. For an ERP with EU customers this is a legal blocker, not
   an ops annoyance. Crypto-shredding (per-subject key, delete the key) is the standard answer and it
   changes your storage model, so it must be designed before launch, not after.
3. **Temporality.** ERPs need effective-dating (prices, costs, FX rates, BOM versions) and as-of
   reporting. Nothing in the language or the seven problems mentions it, and it is the single most
   common reason platforms like this sprout per-module code later. Make bitemporality a language
   primitive or declare it an explicit non-goal.
4. **Gapless document numbering** is legally required in many jurisdictions, is a
   conservation-law/Tier-B concern, and is absent from the capability list.
5. **Approval comprehension.** You've engineered the approval protocol thoroughly and the approval UX
   not at all. If an AI-authored module presents a human with 4,000 lines of compiled projections and
   DDL, approval becomes rubber-stamping and every guarantee in Problem 3 evaporates. The diff renderer
   is a security control and deserves the same rigor as the executor.
6. **Restore.** PITR restores a schema state that may match no live root. You need a rule: after
   restore, replay materialization to the union of live roots before serving.
7. **Rollback is your best untold story.** Additive-only + CAS pointer means release rollback is a
   pointer swap with the schema untouched. That's a headline benefit and the strongest justification
   for the additive-only constraint — state it, and add a rollback conformance scenario so it stays
   true.
