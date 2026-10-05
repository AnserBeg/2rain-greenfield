# Learnings

## Verify generated freeze metadata before tagging
Date: 2026-07-21
Why: G0-P6a found trailing blank lines in generated metadata after its first tag, requiring a corrected immutable commit.
How to apply: run `git diff --check` and the artifact verifier before tagging; if metadata changes, regenerate all inventories and manifest facts before the final tag. See `docs/execution/packets/G0-P6a.md`.

## Represent empty evidence directories explicitly
Date: 2026-07-21
Why: G0-P6b proved that an empty historical result directory vanished when the X-01 baseline was checked out from Git, breaking its integrity gate.
How to apply: record required empty directories in a manifest or add a non-sensitive sentinel before freezing evidence; verify in a fresh checkout, not only the capture worktree. See `docs/execution/packets/G0-P6b.md`.

## Invoke the pinned package manager inside package scripts
Date: 2026-07-21
Why: G0-P1a's first clean checkout resolved a host pnpm 10.33.2 from a nested bare `pnpm` command instead of the workspace's pinned pnpm 11.9.0.
How to apply: use `corepack pnpm` for recursive package-manager script calls and prove them in a clean checkout. See `docs/execution/packets/G0-P1a.md`.

## Make structural gates fail closed
Date: 2026-07-21
Why: G0-P3 review found that denylisted names, optional package metadata, and source-only scans allowed equivalent forbidden dependencies and authorities to evade the gate.
How to apply: require classified package identity, explicit protected-layer dependency policy, generated-artifact scans, sole-authority ownership/uniqueness checks, and negative fixtures for aliases and ordinary bypass forms; see `docs/execution/packets/G0-P3.md`.

## Bound reviews to the packet threat model
Date: 2026-07-21
Supersedes: Make structural gates fail closed.
Why: G0-P3 review expanded from accidental scaffold violations into unbounded obfuscation defense, growing the checker without product evidence.
How to apply: every packet and review prompt names in-scope failures and deferred adversarial cases; findings outside that boundary are future-hardening notes, not blockers. Graduated into `review-tiers` in G0-P3.

## Verify isolation capabilities at use time
Date: 2026-07-21
Why: G0-P4b review proved that a correctly named PostgreSQL runtime role could still bypass RLS if its `BYPASSRLS` or superuser capability drifted.
How to apply: safety-critical transactions verify both role identity and fail-closed capabilities inside the transaction, with a live capability-drift negative test. See `docs/execution/packets/G0-P4b.md`.

## Freeze semantic ownership, not only schema shape
Date: 2026-07-21
Why: G1-P1 review found structurally valid state, relation, scalar, order, and diagnostic nodes whose authority or canonical meaning was still ambiguous.
How to apply: freeze tests must cover derived authority, ownership topology, equivalent scalar spellings, owner-scoped order, and property-order-independent diagnostics. See `docs/execution/packets/G1-P1.md`.

## Keep diagnostic order independent of prose
Date: 2026-07-21
Why: The v0 comparator used `rule` and `acceptedAlternative` text as tie-breakers, so copy edits could change canonical diagnostic order.
How to apply: Sort frozen diagnostics only by stable subject, canonical path, phase, code, and explicit occurrence index; keep explanatory prose outside identity and ordering.

## Verify every Merkle link, not only each digest
Date: 2026-07-21
Why: G1-P2's first expected-active check verified the supplied storage bytes and manifest hash independently but did not prove the release referenced that manifest or the manifest referenced those bytes.
How to apply: walk and verify every root-to-manifest-to-chunk link, canonical byte encoding, domain hash, semantic digest, and byte length before trusted reuse or transition planning.

## Bind derived evidence to its exact source pair
Date: 2026-07-21
Why: G1-P2 review showed a valid transition for one release pair could be included in a diff constructed for a different base, yielding internally inconsistent approval evidence.
How to apply: before hashing or presenting a diff, verify its transition payload binds the supplied from/to definition digests, release base, and storage semantic/artifact roots; fail closed on a missing or mismatched plan.

## Keep registerable roots off every failure path
Date: 2026-07-21
Why: G1-P2 computed and returned a staged release-manifest artifact when the final output-size check failed even though the result-level root was null.
How to apply: allow collectable unreferenced leaves on failure, but perform final limits and completeness checks before hashing or returning any registerable root manifest.

## Lower selected and compiler-derived storage authority explicitly
Date: 2026-07-21
Why: G1-P2 could pair a selected mapping ID with another mapping's class and omitted compiler-derived state fields from a supposedly complete storage target.
How to apply: resolve selected definitions by canonical ID, carry compiler-derived storage constructs explicitly, and compare both against the normalized source in completeness checks.

## Apply lifecycle admission consistently
Date: 2026-07-21
Why: G1-P2 filtered retired unsupported capabilities from manifest facts but still required their runtime projections.
How to apply: define the admitted active/supported set once conceptually and use it for facts, completeness, and support gates; historical definitions must not create live obligations.

## Sort synthetic diagnostics with source diagnostics
Date: 2026-07-21
Why: G1-P2 appended its truncation marker after sorting, violating the frozen structural order even though the output stayed deterministic.
How to apply: after adding limit, summary, or cascade markers, sort the final emitted diagnostic set by the same versioned structural comparator.

## Keep migration bodies free of transaction-control tokens
Date: 2026-07-21
Why: G1-P3's first PL/pgSQL guard used `BEGIN`, and the accepted G0-P4a loader correctly rejected the migration because the runner exclusively owns transactions.
How to apply: express migration-time guards without transaction-control tokens, and run `loadMigrations` as a focused check before any database suite.

## Validate frozen serialized contracts at runtime
Date: 2026-07-21
Why: TypeScript types do not validate serialized frozen contracts crossing a process or persistence boundary.
How to apply: compare every discriminant, version, and invariant to supported runtime constants, and keep a correlated-mutation negative test.

## Validate structure and derive digests independently
Date: 2026-07-22
Why: G1-P3 review found that hash-consistent bytes could still omit required envelope fields or carry mutually consistent semantic-digest claims unrelated to their payload.
How to apply: validate required runtime shape and recompute semantic digests from canonical payload bytes; use correlated rehashing negatives that leave no registered root. See `docs/execution/packets/G1-P3.md`.

## Ship callable effects with their reconciler
Date: 2026-07-22
Why: G1-P4 debate showed that enabling pointer mutation before receipt-based crash reconciliation would expose ambiguous commits and zombie coordinators.
How to apply: schemas and policies may land noncallable, but withhold runtime mutation grants and APIs until CAS, decisive receipts, reconciliation, and race/fault proofs land together. See `docs/execution/packets/G1-P4a.md`.

## Keep resumable observations out of decisive slots
Date: 2026-07-22
Why: A unique immutable outcome row cannot hold a timeout or infrastructure error without preventing the same attempt from later recording its actual swap or terminal no-swap result.
How to apply: record retryable/paused/reconciling states as append-only phases or history; reserve the one decisive slot for committed effect or proven terminal no-effect. See `docs/execution/packets/G1-P4a.md`.

## Persist reconciliation age across worker lifetimes
Date: 2026-07-22
Why: Process-local timers cannot prove a crash-safe overdue alarm after worker failure or handoff.
How to apply: derive deadlines and completion from durable database facts recorded with PostgreSQL statement-time `clock_timestamp()`; an alarm row is an idempotent projection, never detection authority. See `docs/execution/packets/G1-P4b.md`.

## Use statement time for deadline decisions
Date: 2026-07-22
Why: `transaction_timestamp()` and `now()` are transaction-start values that misclassify a transaction blocked across a deadline. This class recurred after the G1-P4 approval-expiry debate in the G1-P4b overdue derivation.
How to apply: use `clock_timestamp()` for deadline, expiry, and overdue logic and every persisted timestamp it consumes; transaction-start time remains valid for audit-column defaults. Reviewers should check for this class. See `docs/execution/packets/G1-P4b.md`.

## Measure elapsed deadlines with a durable monotonic anchor
Date: 2026-07-23
Why: fresh `clock_timestamp()` reads are statement-time but still steppable wall time, so a backward correction can delay a deadline derived from an earlier persisted wall timestamp.
How to apply: supersedes the elapsed-age part of “Use statement time for deadline decisions”: persist a boot-scoped monotonic anchor, inject wall/monotonic time in regression tests, and use wall time only for timestamp representation. See `docs/execution/packets/G1-P4b-monotonic-reconciliation.md`.

## Take persisted versions from the artifact
Date: 2026-07-23
Status: Adopted 2026-07-28; supersedes “Derive persisted envelope versions from canonical authority.”
Why: G2-P2a copied legacy-compatible versions into a current release envelope; 4c then found current constants misdescribing historical artifacts across a version boundary.
How to apply: readers and writers take language/profile versions from each persisted artifact, never a compile-time constant; when compiler roots or persisted metadata change, run downstream PostgreSQL registration suites before acceptance. See [G2-P2a-fix](docs/execution/packets/G2-P2a-manifest-version.md) and [4c](docs/execution/packets/4c.md).

## Enforce semantic normalization where uniqueness lives
Date: 2026-07-23
Why: P2b emitted raw unique indexes for a compiled Unicode case-fold contract, so application-equivalent case variants remained distinct in storage.
How to apply: drive application normalization and storage indexes from one versioned fold table, verify every mapped scalar across both implementations, and test exact/case/tenant duplicate behavior. See [G2-P2b corrective](docs/execution/packets/G2-P2b-case-fold-unique.md).

## Scope synthetic-secret exceptions to one fingerprint
Date: 2026-07-24
Why: PR-1's full matrix found that gitleaks classified G2-P1's static redaction sentinel as a generic API key even though its test proves the value never persists.
How to apply: verify the value is synthetic, then ignore only its exact commit/file/rule/line fingerprint with an adjacent justification; never exempt a path or rule.

## Put pnpm 11 overrides in the workspace manifest
Date: 2026-07-24
Why: PR-3 found that pnpm 11 silently ignored a root `package.json` `pnpm.overrides` entry after emitting only a warning.
How to apply: declare pnpm 11 dependency overrides under `overrides` in `pnpm-workspace.yaml`, regenerate the lockfile, and verify the resolved graph and audit. See `docs/execution/packets/PR-3.md`.

## Prove every test is reachable from CI
Date: 2026-07-24
Why: PR-4 found test commands and a browser scaffold that existed in the repository but were silently unreachable from every CI-invoked command.
How to apply: discover all test files independently, resolve CI and package-script declarations fail-closed, and retain real-file plus parser canaries. Graduated into AGENTS.md section 6; see `docs/execution/packets/PR-4.md`.

## Allowlist every selection-bearing configuration surface
Date: 2026-07-24
Why: PR-4's first Playwright parser denied three known selection keys but missed `grep`, `grepInvert`, and `shard`, so its claimed fail-closed reachability proof was actually fail-open.
How to apply: when static configuration parsing stands in for executed-file evidence, parse the supported structure, allow only selection-neutral keys plus explicitly interpreted selectors, and fail on every other key or structural form. Retain both synthetic and real-config negative canaries; see `docs/execution/packets/PR-4.md`.

## Use executed evidence for open-ended test runners
Date: 2026-07-24
Why: PR-4 found four fail-open static-parser surfaces, and PR-4b found that Node emits a passing file-level event even when a name filter runs no real test in that file.
How to apply: supersedes “Allowlist every selection-bearing configuration surface” as a completeness mechanism. Accept evidence only from successful declared unfiltered suites and only for real non-skip, non-todo, non-synthetic results; fail on every missing, empty, or unnormalizable artifact. Delivered by `docs/execution/packets/PR-4b.md` and graduated into AGENTS.md section 6.

## Bind evidence to the run that produced it
Date: 2026-07-25
Why: PR-4b round 1 could accept a prior artifact when an aggregate producer was skipped or reordered because evidence proved content but not freshness.
How to apply: begin one run token, stamp it plus observed argv into every producer artifact, and reject missing, stale, unresolvable, or declaration-mismatched evidence before crediting files. See `docs/execution/packets/PR-4b.md`.

## Refuse migrations that would rewrite immutable trust facts
Date: 2026-07-25
Why: PR-5's narrower idempotency key could conflict with receipts admitted by the prior schema, but collapsing them would violate their append-only trust contract.
How to apply: let the new constraint fail inside the migration transaction, and test that rows, prior constraints, and migration history remain unchanged. See `docs/execution/packets/PR-5.md`.

## Require the intended index in plan-shape gates
Date: 2026-07-25
Why: PR-6's relation query still avoided a sequential scan after its new index was dropped because PostgreSQL used the scope-leading primary key; a “no Seq Scan” assertion would have false-greened.
How to apply: parse `EXPLAIN (FORMAT JSON)` structurally under the real security role and require the exact declared index or index condition meant to serve the predicate. See `docs/execution/packets/PR-6.md`.

## Make gates observe, and prove each way they could pass vacuously
Date: 2026-07-25
Supersedes, as the generalization of: Prove every test is reachable from CI; Use executed evidence for open-ended test runners; Bind evidence to the run that produced it; Require the intended index in plan-shape gates.
Why: six consecutive learnings entries were the same defect — a gate that passes without proving anything — and each was recorded as an instance rather than graduated, so every packet rediscovered it. PR-6b alone hit four: substring matching on a plan string, a filter counter read on the wrong bitmap node, and a drift query the schema-owning materializer ran under FORCE RLS with no policy, seeing zero rows and passing trivially.
How to apply: prefer observation (counters, artifacts, persisted effects) over inference (parsing output, reading declarations); enumerate the vacuity vectors before writing the gate and ship a recorded red for each; treat green on a gate never seen red as unproven. Graduated into AGENTS.md section 6.

## Move security-sensitive normalization into an accounted stored shape
Date: 2026-07-25
Why: forced RLS kept a non-leakproof row-side fold out of index conditions, while a stored C-collated fold column made equality predicates ordinary leakproof comparisons.
How to apply: compile the generated expression, collation, equality index, and runtime predicate as one versioned contract; make each versioned fold function create-once and refuse a different existing body before DDL/DML; and run row equality evidence only as the runtime role with nonzero-subject and nonzero-visible-row assertions. A future fold version mints a new function and column and requires an accounted rewrite. See `docs/execution/packets/PR-6b.md`.

## Observe index execution across the whole plan tree
Date: 2026-07-25
Why: PR-6b reviews showed that `Index Cond` text could falsely credit an identifier occurrence, while bitmap plans split the index name onto a child and `Rows Removed by Filter` onto its parent.
How to apply: require both a before/after `pg_stat_user_indexes.idx_scan` delta on the exact expected index and zero rows removed by filter summed across the entire validated `EXPLAIN ANALYZE` tree. Neither signal is sufficient alone; retain a real missing-index negative control. See `docs/execution/packets/PR-6b.md`.

## Refuse changes to versioned database functions instead of detecting repaired state
Date: 2026-07-25
Why: PR-6b's materializer used `CREATE OR REPLACE FUNCTION` before verifying `pg_proc.prosrc`, so the verifier measured the body it had just restored and could pass while stored generated values remained stale.
How to apply: for an immutable versioned function, create it only when absent; when present, compare its raw source before any DDL or DML and reject a mismatch with a named error. Never repair the same version in place. Keep data-level evidence outside the production activation path, and route protection from privileged out-of-band DDL to an operator-level witness. See `docs/execution/packets/PR-6b.md`.

## Test a factory with a second definition, not a patched press
Date: 2026-07-25
Why: Catalog reproduced Party-level behavior with zero compiler, provider, runtime, UI, or migration changes; changing the press would have made the factory test a false positive.
How to apply: Freeze the press during the first fan-out module, stop on any required press edit, and classify the missing contract before continuing.

## Reconcile packet shorthand with the authoritative plan
Date: 2026-07-25
Why: G2-P6's abbreviated outcome named Catalog descriptors without enumerating base unit, while the authoritative domain boundary and G2 walking-slice sections require it; the first review caught the reduced field inventory.
How to apply: treat a packet outcome as a bounded summary, then inventory the selected entity against every applicable plan requirement before freezing definition tests. Preserve scope by adding missing declarative data, never by quietly reducing completeness or patching the press.
## Separate runtime requirements from capability disclosure
Date: 2026-07-26
Why: G2-P7 proved that a non-supported capability requirement either blocks compilation or disappears from emitted facts, contradicting plan §5.5's explicit support-state rule.
How to apply: keep fail-closed runtime requirements, but model supported/preview/planned/unsupported/deprecated/internal product disclosure through a separate compiled declaration seam before claiming the capability.

## Converge wire fences on strict versioned parsing
Date: 2026-07-26
Why: G2-EK1 found three copies of the same predicate fence, including canonical-model's private default check; centralizing any unchanged copy would still have accepted unknown versions and extra authority-bearing properties.
How to apply: accept `unknown` at persisted/runtime boundaries, close the wire shape, dispatch on the serialized node's own version, and observe every caller routing through the shared entry point. See `docs/decisions/ADR-0012-expression-kernel-ceiling.md`.

## Keep observation hooks non-authoritative
Date: 2026-07-26
Why: G2-EK1's first review found that a throwing predicate-receipt observer could block accepted execution or replace an exact unsupported result and its durable failure evidence with a generic execution failure.
How to apply: route evidence observers through failure isolation, and test them by throwing after recording at every call site; instrumentation may report execution but must never decide or interrupt it.

## Put the intended PostgreSQL role in the connection URL
Date: 2026-07-27
Why: G2-P5e found that node-postgres retained the username embedded in `DATABASE_URL` instead of a separate pool `user`; the trusted-transaction fence failed closed with `UnsafeDatabaseRoleError` before any privileged request ran.
How to apply: derive a role-specific connection URL for each least-privilege pool and keep the exact-role assertion as the first trusted-transaction fence. See `docs/execution/packets/G2-P5e.md`.

## Distinguish migration verification from newly applied work
Date: 2026-07-27
Why: G2-P5e's first persistent restart exposed a fresh-database harness assumption: zero migrations were newly applied even though every migration verified successfully.
How to apply: persistent startup must require the complete ordered migration set to verify and may report zero newly applied; keep fresh-database assertions in fresh-database harnesses. The shared runner already has this shape, so the fix belongs in its composition-root caller. See `docs/execution/packets/G2-P5e.md`.

## Enumerate every physical uniqueness enforcer
Date: 2026-07-28
Status: Unadjudicated pending acceptance of packet 1d.
Why: One business key emitted a semantic unique index and a case-insensitive index; changing only one left the other invisibly enforcing the old archive scope.
How to apply: before changing uniqueness semantics, enumerate and test every physical index the key produces; see `docs/execution/packets/1d.md`.

## Lock mutable authorities through the decisive write
Date: 2026-07-30
Why: G3-P3 validated draft, base-unit, and period rows without locks, so a concurrent committed change could invalidate the posted fact after validation.
How to apply: acquire row locks after the domain serializer and retain them through the decisive write; cover child phantoms with a captured complete-set digest rechecked by the transition. See `docs/execution/packets/G3-P3.md`.

## Version every newly consumed authority
Date: 2026-07-30
Why: G3-P3 natural replay read the trust outbox while dependency protocol v2 declared only outbox append authority.
How to apply: when behavior adds a read or write, cut a new exhaustive dependency protocol/root and record before/after; never widen frozen history in place. See `docs/execution/packets/G3-P3.md`.

## Serialize idempotency before reading its receipt
Date: 2026-07-30
Why: Different-stock G3-P3 commands could share a request key, both observe no receipt, then expose a generic receipt constraint failure for the loser.
How to apply: after all domain locks, acquire a scoped request-key lock before receipt lookup and prove one commit, one typed conflict, and no loser evidence under real concurrency. See `docs/execution/packets/G3-P3.md`.

## Bound blocking locks in production and their controls
Date: 2026-07-30
Why: G3-P3's matrix hung behind an idle lock holder in an acyclic wait chain, so PostgreSQL's deadlock detector had no cycle to break and neither the product nor its control could make progress.
How to apply: keep deliberate blocking semantics, but set an explicit lock timeout, translate it to a domain-typed concurrency error, and make every real lock control assert the database timeout rather than an absence of progress. See `docs/execution/packets/G3-P3.md`.

## Key generic machinery on declared properties
Date: 2026-07-30
Why: G3-P6a exposed the same defect twice: omitting `abiFunctionChecks` from an additive strip list made a second module's shared-Item contribution look identity-defining, while enumerating one pending element kind made another `inAttemptOnly` kind fail preparation. Single-module and single-kind tests could not reveal either omission.
How to apply: drive generic comparison, merging, and scheduling from declared semantic properties rather than remembered kind lists; test a second contributor or sibling kind, retain exact-byte duplicate rejection, and keep final verification unrelaxed. See `docs/execution/packets/G3-P6a.md`.

## Generate verification fixtures from compiled constraints
Date: 2026-07-30
Why: G3-P6a's generic boolean verifier always chose `true`, which collided with a legitimately seeded row occupying the `TRUE` member of a compiled partial-unique domain before the intended searchable-exclusion probe could execute.
How to apply: derive small-domain verification values from the compiled constraints of their physical columns, choose outside partial-unique predicates, and fail closed when the predicate shape is unsupported or every value is constrained. Observe both the retained legitimate row and the completed exact scenario in real PostgreSQL. See `docs/execution/packets/G3-P6a.md`.

## Do not infer one capability from another
Date: 2026-07-30
Why: G3-P6a mounted append-only and entity-owned Inventory shapes for the first time; searchable entities were not always creatable, and declared create operations were not always constructible from their input contracts.
How to apply: derive each capability independently from its compiled contract, report exclusions as structured findings rather than silent skips, and retain a terminal diagnostic when no eligible verification witness remains. See `docs/execution/packets/G3-P6a.md`.

## A verification scenario needs execution or a bound derivation
Date: 2026-07-30
Why: G3-P6a showed that compiler emission did not imply runtime arrangeability: 32 of 39 composed searchable-exclusion scenarios targeted either append-only entities or create operations that could not satisfy storage.
How to apply: execute a scenario against an observed subject, or record a durable candidate-bound impact-analysis derivation per unexecuted scenario and report executed and derived counts separately. Never substitute a skip flag, sampling, a time box, or a provider-local validator for the compiler-owned verification contract. See ADR-0020 and `docs/execution/packets/G3-P6a.md`.
## A fixture takes its version from what it is, never from "current"
Date: 2026-07-30
Why: `test/fixtures/g2/module-conformance/definitions.ts` derived its authored `languageVersion` from `LATEST_LANGUAGE_VERSION`, so cutting v4 silently re-authored v3 content at v4 and turned **32 compiler tests red at once** — none of them naming the fixture, so the cost was a debugging pass before the cause was visible. Switching to an `ADOPTED_*` constant would only have narrowed the blast radius: it moves too, one event later.
How to apply: pin any version-specific fixture to a literal (`LANGUAGE_VERSIONS.v3`), and derive nodes built *into* a fixture from that fixture's own exported version, not from a constant. Advancing a fixture is a deliberate edit, like the migration inventory and the surface-debt baseline. The inverse case is legitimate and different: a test that asserts `LATEST_LANGUAGE_VERSION === LANGUAGE_VERSIONS.v4` is a ratchet pinning what the constant *is*, and should fail loudly on the next cut. This is the version-from-artifact rule in fixture clothing; see `docs/execution/packets/Q1-P5.md`.

## A negative control must not probe with a value the language can later gain
Date: 2026-07-30
Why: `negative-contracts.test.ts:76` asserted that an unknown node version fails closed, using the literal `'v4'`. When v4 became real the probe stopped observing its own claim — the document was still refused, but for a different reason (`CANON_VERSION_MIXED`, not `CANON_VERSION_UNSUPPORTED`), so a genuinely unsupported version was no longer covered.
How to apply: probe one past the newest readable version, and re-read every negative control whose subject is a *value* rather than a *shape* when that value space is extended. See `docs/execution/packets/Q1-P5.md`.
## Keep negative fixtures valid until the target rule
Date: 2026-07-30
Why: G3-P4b removed a required evidence field but left canonical query references behind, so normalization failed before the intended inventory conformance rule ran.
How to apply: remove or replace every dependent reference with the mutated declaration, prove the fixture still crosses earlier validation layers, and pin the exact downstream diagnostic. See `docs/execution/packets/G3-P4b.md`.

## Revalidate issued capabilities at every use
Date: 2026-07-30
Why: Q1-P4 sealed a legal-entity scope to one request view but let policy-v1 authority survive a policy-v2 change for the rest of that request.
How to apply: immediately before execution, reauthorize every capability member and compare its issued policy version with live policy; test version advance and an allowed-first/denied-second set independently. See `docs/execution/packets/Q1-P4.md`.

## Pin controls to the first reachable authority
Date: 2026-07-30
Why: Q1-P4 moved capability refusal to the gateway, leaving a provider error assertion aimed at a guard no application path could reach.
How to apply: trace every ingress after moving enforcement, remove unreachable duplicate validation, and make the executed control pin the first refusing layer's typed error and subject. See `docs/execution/packets/Q1-P4.md`.

## Do not mistake declared state machines for runtime enforcement
Date: 2026-07-30
Why: Party, Catalog, Location, and Inventory all declare empty `stateMachines` arrays, while the generic module runtime consumes no state-machine definition at all; the language concept therefore supplies no terminal-state protection today.
How to apply: before relying on a canonical lifecycle declaration, trace it into an executed runtime consumer and prove terminal-state mutation is refused. Treat declaration without consumption as a hollow contract, not enforcement.

## Keep verification authority out of compatibility aliases
Date: 2026-07-31
Why: `ver-agg` passed a v2 physical-family alias into verification-plan lowering, so valid v3/v4 aggregate assertions disappeared even though the original canonical revision retained them.
How to apply: build verification completeness from the authoritative canonical revision; pass compatibility aliases only to the physical families that require them, and prove every active assertion is emitted or fails with its own typed diagnostic. See `docs/execution/current-plan.md` row `ver-agg`.

## Prove verification scenarios execute, not merely emit
Date: 2026-07-31
Why: `ver-agg` first restored aggregate scenarios to the authoritative plan, but the provider still dispatched them through the row-query ingress, so the new scenarios could never execute successfully.
How to apply: trace each scenario through its production dispatcher and require an observed positive or exact typed refusal; pair plan-emission controls with downstream execution controls and a non-refusing negative arm.

## Classify unreachable guards as backstops
Date: 2026-07-31
Why: `ver-agg` credited compile-failure controls to a lowering throw, but earlier fail-closed decode and validation barriers made that throw unreachable through the production compiler entry point.
How to apply: trace the complete ingress order before naming a victim; if earlier authority prevents reachability, retain the guard as defence in depth and record what cannot be observed rather than bypassing validators to manufacture a red.

## Audit from an authority independent of the subject
Date: 2026-07-31
Why: G3-P6a's omission probe enumerated the query catalog it audited, so a dropped query vanished from the probe; derivation admission likewise trusted the producer's eligibility claim.
How to apply: derive mandatory subjects from an independent compiled artifact and recompute exclusion eligibility in a negative control; never let the producer or collection under test certify its own completeness. See `docs/execution/packets/G3-P6a.md`.

## Preserve safe provider diagnostics at translation boundaries
Date: 2026-07-31
Why: Unrecognised PostgreSQL failures were flattened to generic codes, making composed-product failures undiagnosable without temporary instrumentation.
How to apply: retain stable refusal codes while carrying only allowlisted schema metadata (SQLSTATE, relation, constraint, column); inject domain-typed mappings from modules and prove raw messages, DETAIL, rows, queries, and parameters cannot escape. See `docs/execution/packets/5g3-berr.md`.

## Measure process work, and serialize the measurement mechanically
Date: 2026-07-31
Why: A wall-clock compiler budget varied 26% while quiet and doubled under lane contention, producing wrong verdicts about unchanged compiler work.
How to apply: measure process CPU, report saturated hosts as indeterminate, isolate timing gates from load-tolerant suites, and enforce shared/exclusive access with one lock rather than operator memory. See `docs/execution/packets/gate-perf.md`.

## Re-derive a bound when its measurement unit changes
Date: 2026-07-31
Why: gate-perf retained a wall-time-calibrated 5,000 ms numeral after moving the verdict to the smaller CPU-time quantity, silently allowing a 2× compiler regression.
How to apply: take repeated quiet samples in the new unit, derive an anti-flake margin from their spread, and prove the intended regression exceeds the new bound. See `docs/execution/packets/gate-perf.md`.

## Calibrate admission and budget as one instrument
Date: 2026-07-31
Why: gate-perf initially mixed low-load and degraded-host CPU samples, making the new unit appear too noisy to gate; the admission threshold was part of the calibration, not a fixed precondition.
How to apply: group measurements by the admission signal, derive the fence between populations, re-sample under the real exclusive lock, and record self-load indeterminates before deriving the budget. See `docs/execution/packets/gate-perf.md`.

## Separate contention control from measurement calibration
Date: 2026-08-01
Why: exclusive CPU samples and the matrix still disagreed by roughly 30%, while an in-process repeated compile was not a repeatable cold-workload witness.
How to apply: land mechanical isolation independently, but require a stable baseline and independently repeatable regression witness before changing a timing unit or budget. Supersedes the CPU-measurement recommendation in "Measure process work, and serialize the measurement mechanically"; its serialization rule remains binding. See `docs/execution/packets/gate-perf.md`.

## Observe current capacity, not load-average echo
Date: 2026-08-01
Why: the one-minute load average remained elevated while the CPU was 96.4% idle, so a timing gate refused current quiet based on its own decaying prior work.
How to apply: admit timing work from a short direct `/proc/stat` CPU-idle delta; use load average only as historical telemetry. Supersedes the load-average admission guidance in "Calibrate admission and budget as one instrument". See `docs/execution/packets/gate-perf.md`.

## Bound lock conversion, not only acquisition
Date: 2026-08-01
Why: a matrix bounded its initial lock acquisition but converted exclusive to shared with an unbounded call; a live exclusive waiter can win the non-atomic conversion gap and stall the runner indefinitely.
How to apply: bound and execute-control every acquisition and conversion path. Treat terminated holders as released by the kernel; diagnose waits on live holders, not stale lock files. See `docs/execution/packets/gate-perf.md`.

## Preserve operand multiplicity until canonical validation
Date: 2026-08-01
Why: G3-P6b-2 collapsed a repeated legal-entity URL operand to its first value, letting a malformed two-entity request answer as one entity instead of reaching ADR-0031's cardinality refusal.
How to apply: carry every transport value to the canonical argument kernel, render no choice as selected when multiplicity is invalid, and prove the collapse mutation returns a value where the control requires a typed refusal.

## Bound fresh install by separating transitions from verification
Date: 2026-08-01
Why: replaying tenant-invariant semantic scenarios for every historical release made fresh install grow with lineage until it exhausted both time and database space.
How to apply: apply and assert every pairwise transition, verify only the serving shared release, and persist the exact non-serving set; revisit this rule before G6 permits tenant-divergent releases. Graduated to ADR-0040; see `docs/execution/packets/5g3-freshtenant.md`.

## Keep transition authority out of serving paths
Date: 2026-08-01
Why: bounded fresh install needed transition-only admission, but an intermediate active pointer made that narrow authority visible to ordinary request loading.
How to apply: bind transitional authority to its exact workflow identity and step, and make every serving ingress refuse a subject whose only live authority is transitional. See `docs/execution/packets/5g3-freshtenant.md`.

## Close completion evidence behind one durable writer
Date: 2026-08-01
Why: immutable row existence closed an install even though a broadly shaped document could have been inserted without proving the facts it claimed.
How to apply: revoke direct writes, derive the closed document and digest from durable facts inside one database authority, and refuse malformed or incomplete closure before insertion. See `docs/execution/packets/5g3-freshtenant.md`.

## Never invent optional verification prerequisites
Date: 2026-08-01
Why: semantic verification recursively created an optional self-reference, exhausting the call stack in a minimal fixture and filling PostgreSQL storage when a required parent was created before each recursion.
How to apply: arrange only relation inputs declared required, reject cycles in the required-relation path by name, and execute both an optional self-reference and a required-cycle control. See `docs/execution/packets/5g3-arrangecycle.md`.

## Distinguish an unset relation from an absent target
Date: 2026-08-02
Why: restore joined a nullable foreign key directly to its target and interpreted zero rows as an archived target, so an ordinary unset optional relation made an archived record permanently unrestorable while verification's invented parent masked the defect.
How to apply: observe nullable reference presence first, skip only an actual null, and independently lock and validate every non-null target. Control both the null-success direction and the archived-target refusal. See `docs/execution/packets/5g3-restorenull.md`.

## Derive recursive identities from the full path
Date: 2026-08-02
Why: verification named every recursive parent by depth, so two required diamond paths reaching one entity at equal depth generated the same record UUID and collided at the primary key.
How to apply: derive recursive fixture identities from the parent path plus the current compiled edge, never from depth, order, time, or a counter; prove sibling paths persist distinct records. See `docs/execution/packets/5g3-arrangecycle.md`.

## Check historical lineage before freezing a tighter rule
Date: 2026-08-02
Why: ADR-0042 correctly refused unusable resolvers, but the packet discovered only at artifact generation that four historical normalized inputs no longer compiled.
How to apply: compile every retained lineage input under a proposed conformance rule before freezing it; while the output protocol is experimental, name any ruled truncation and the incremental property it removes. Graduated to ADR-0043.

## Require declared queries to have an executable witness
Date: 2026-08-02
Why: three resolve declarations and five search declarations satisfied universal conformance while their lowered storage made the promised lookup impossible.
How to apply: derive query requirements from executable lowered storage, refuse declarations the runtime cannot honor, and independently require every capability that storage can honestly support. See ADR-0042 and `docs/execution/packets/5g3-write-scope.md`.

## Derive conformance from authored and synthesized contracts
Date: 2026-08-02
Why: a schema-only language inventory could not see compiler-synthesized field-origin relations, so downstream consumers ignored a real output choice and demanded two authorities for one physical column.
How to apply: derive obligations independently from the authored schema and every lowered output contract; discharge each exact value only with distinguishing execution, stable refusal, or a digest-bound written decision. See `docs/execution/packets/5g3-langgate.md`.

## Enumerate finite union members independently
Date: 2026-08-02
Why: the language ledger dropped `null` whenever it shared a union with open `string` or `number`, omitting exactly the nullable shapes that motivated the instrument.
How to apply: emit every finite union member before independently traversing non-finite siblings, and retain a missing-axis control grounded in both authored and lowered specifications. See `docs/execution/packets/5g3-langgate.md`.

## Classify failure scope at the live composition boundary
Date: 2026-08-02
Why: `5g3-u4` inherited a stale line citation that pointed at a correctly page-level manifest failure, while the real all-or-nothing behavior lived after surface selection at record-slot dispatch.
How to apply: trace a failure from selection through data resolution to slot dispatch before moving its diagnostic; preserve pre-composition faults as page-level and isolate only failures arising after slot composition. See `docs/execution/packets/5g3-u4.md`.

## Force the branch a negative control claims to cover
Date: 2026-08-02
Why: a no-loading control borrowed a surface with declared status roles, so restoring the fallback `Loading` branch stayed green because the fixture never executed that branch.
How to apply: construct every branch-decisive precondition explicitly, run the exact bad mutation, and reject a red that occurs before or after the claimed branch. See `docs/execution/packets/5g3-u4.md`.

## Put external-resource cleanup outside its owner process
Date: 2026-08-02
Why: six `--rm` PostgreSQL test containers survived their killed harnesses for up to two days and contaminated every later matrix run.
How to apply: pair normal `finally` cleanup with a detached, process-identity-bound guardian; kill -9 the real owner and independently observe the external resource disappear. See `docs/execution/packets/leak-guard.md`.

## Keep every best-of-N cold sample genuinely cold
Date: 2026-08-02
Why: same-process repetition let warmed V8 state hide first-invocation compiler cost, while one noisy cold sample made an unchanged gate indeterminate in practice.
How to apply: take each sample's first invocation in a distinct process, retain the unchanged budget, report every sample, and prove both one-noisy-sample PASS and all-slow-samples FAIL. See `docs/execution/packets/leak-guard.md`.

## Separate historical integrity from current conformance
Date: 2026-08-02
Why: applying a newly tightened search rule to recorded lineage made valid historical releases appear corrupt and would have disabled rollback exactly when rules changed.
How to apply: reproduce history from its recorded bytes and exact root, compile every new head strictly, and let historical defects refuse by name at runtime rather than returning plausible answers. Graduated to ADR-0045 and ADR-0046; see `docs/execution/packets/5g3-searchcap.md`.

## Pin typed refusals to their producing layer
Date: 2026-08-02
Why: release verification accepted an adapter refusal because it shared the posting service's diagnostic code, while a nonempty-message check could not distinguish the layer actually reached.
How to apply: require the exact declared code and reason (or an equally exact source identity), and mutation-prove that the same code from the wrong layer fails. See `docs/execution/packets/5g3-postroute.md`.
## Retain singleton choices in derived language ledgers
Date: 2026-08-03
Why: narrowing relation cardinality and join eligibility to one literal removed both axes from the derived ledger, so a future singleton-for-singleton substitution would not move its digest.
How to apply: derive admitted literal obligations even when an axis has one value, and control a singleton substitution explicitly. See `docs/execution/packets/5g3-langnarrow.md`.

## Admission is not implementation evidence
Date: 2026-08-03
Why: a relation value that survived normalization and accompanied a successfully lowered foreign key was misclassified as honoured even though no lowerer or runtime consumer read that value.
How to apply: to move an obligation out of accepted-but-unhonored, name the downstream consumer and directly observe the declared semantics; successful processing of the surrounding object is not enough. See `docs/execution/packets/5g3-langnarrow.md`.

## A flag keyed on syntactic kind cannot carry a semantic invariant
Date: 2026-08-03
Why: the coverage ledger marked an axis `forced` from its union, boolean and optionality branches, intending "this axis is a real choice" — but `z.literal('x')` lowers to a bare `StringLiteral`, not a one-member union, so narrowing an axis to its last value moved it off every forced branch and deleted it. The flag could not fire for the exact case it existed to protect.
How to apply: when an invariant is "this thing must stay represented", assert it on the thing, not on the branch that produced it — and control the transition (two values to one) rather than the end states. See `docs/execution/packets/lang-singleton.md`.

## Never match a process by its own command line
Date: 2026-08-08
Why: `pkill -f <pattern>` and `pgrep -f <pattern>` match the invoking shell,
because the pattern is in that shell's own command line. `lock-obs` killed its
own shell this way three times in one packet — its launcher, its `foreign_matrix()`
helper, and again in round 3 — and the orchestrator's own `pgrep` returned its
own pid alongside the two lanes it was looking for. Every instance looked like
the target process had died.
How to apply: resolve to a PID first and act on the PID. Where a pattern is
unavoidable, exclude `$$` and the process group explicitly and assert the match
count before acting. A gate that reads the real process table is separately
suspect — see the same packet's machine-load-dependent controls.

## A closed vocabulary duplicated across domain and compiler needs a binding gate
Date: 2026-08-08
Why: Three instances found in one day. `INVENTORY_POSTING_ROLES` exists in five
places -- domain contract, compiler conformance, the persisted movement enum, the
provider's command types, and one physical configuration column per role -- and
`reBaseline` is already in the contract but not in the provider's implemented
union, with no gate binding them. `LEGAL_ENTITY_FAMILY_MAP_V1` has a compiler twin
in `conformance.ts`. `U5b` shipped `FIELD_BEARING_SURFACE_SLOTS` as a restatement
of the runtime's `ownsDataResolution`, and the two disagreed on `record:titleStatus`.
How to apply: when a closed set must exist in two layers, add the deep-equal
assertion in the same packet. The family map has one and drift fails compilation
loudly; the posting roles do not, and a release can describe vocabulary the runtime
cannot execute. Loud duplication is tolerable; unbound duplication is not.

## A language cut silently drops released rules wherever a version is enumerated
Date: 2026-08-08
Why: Cutting canonical `v5` moved no release root and broke no byte pin — the gate
made a `v4` package normalize identically. What it silently dropped were three
released rules, each found only by executing: `languageHasV2Features` lost the
resolve-match rule; the predicate kernel's enumerated node versions rejected `v5`,
making the default `true` precondition unexecutable and declining **every**
operation in the release; and two gates read `languageVersion` from a dispatch
alias that always answers `v2`, so they enforced their invariant only when told the
authored version.
How to apply: on any version cut, grep for every place the version set is written
out by hand and derive it from `SUPPORTED_LANGUAGE_VERSIONS` instead. An
enumeration is a silent opt-out for every version added after it was written, and
a passing byte pin proves nothing about it — the failure is in behaviour the pin
never reaches.

## Capture an exit code inside the log, not beside the command
Date: 2026-08-08
Why: A lane ran `pnpm test > log; echo "MATRIX_EXIT=$?"` and reported exit 0. `$?`
held the exit of the redirect-completed `pnpm test`... except the harness reported
the `echo`'s status, so a run that aborted at `test:integration` with nine steps
never reached was read as a full pass. There was no basis for a
`FULL_MATRIX_PASS_SHA` and one was nearly recorded.
How to apply: append the exit code **inside** the log the matrix writes, and assert
on that line. A green read from a wrapper's status is a false green in the
reporting harness, which no gate in the tree can catch — see also
[[a-probe-s-results-must-be-reproducible]].

## A control can guard the premise of a claim instead of the claim
Date: 2026-08-08
Why: `U5b` recorded that `surface-manifest` `minimumVersion` stays 1 *on the
condition that no tier value ever means "hide"*. Asked to make that condition
executable, the lane pinned the tier vocabulary to an exact set and printed the
recorded argument in the failure message — and the orchestrator accepted it as
closing the condition. It closes the **premise** (a fourth spelling cannot arrive
silently). **Nothing ever reads `requiredRuntimeCapability.minimumVersion`**, so
raising it from 1 to 2 survives every control in the packet.
How to apply: when a claim has the shape *"X holds because Y"*, a control on Y is
not a control on X. Name both, and assert the one the claim is about. The tell is a
failure message that mentions a value the assertion never reads — see also
[[a-fenced-claim-without-a-control-is-never-checked-again]].

## Derivation is not automatically correct — derive from the list that declares the shape
Date: 2026-08-08
Why: The fix for a hand-written version literal derived the admitted set from
`SUPPORTED_LANGUAGE_VERSIONS` — the nearest list — which admitted `v3`, a version
that never declared the legal-entity operand. The literal was too narrow; the
nearest list was too wide. An existing forgery control, written by someone else for
an unrelated reason, refused it.
How to apply: "derive, don't enumerate" is half the rule. The other half is that
the right list is the one that **declares the shape**, not the one nearest to hand.
Pin the fence from both sides and record a red each way — widen it and the forgery
control fires, narrow it to the literal and the version control fires. **Neither
control alone holds it**, which is the tell that a single-sided fence is a guess.

## Run the last three failures' checks before spending a matrix
Date: 2026-08-08
Why: Four matrix runs on one packet. Two found real defects; **two were the lane's
own residue** — a word in a comment tripping a vocabulary guard, and a pinned line
number moved by an earlier fix. After the third, the lane ran the guard sweep plus
full integration and architecture locally *before* re-queuing, and that single pass
caught two more that never became failed runs.
How to apply: before requesting the slot, run whatever the last failures came from
— not just `typecheck` and `lint`. Roughly three minutes of local checks against
~50 minutes of machine time, and the matrix has a much longer preamble than a
typecheck. See also [[the-matrix-needs-a-quiesced-machine]].

## An instrument that cannot separate the hypotheses is not evidence for either
Date: 2026-08-08
Why: A lane added a 30-second CPU-idle sampler to distinguish "these two tests are
slow because the machine was contended" from "the 300s bound is too tight for this
tree." It reported mean 78.2%, min 43.9% — and the lane refused to cite it, because
**the matrix is the dominant load**, so the sampler measures self-load and
contention identically and would have read roughly the same on both runs. The real
evidence was a fixed-SHA comparison: the same two tests, same commit, `>300s`
timeout on one run and 135.8s / 98.8s on the next.
How to apply: before quoting a measurement, ask what it would have read under the
hypothesis you are trying to rule out. If the answer is "about the same," it
discriminates nothing — record it as a limitation, not as proof. **A number in a
report is read as evidence whether or not it is**, which is why the lane writing it
down as a limitation was the correct move rather than a cautious one.

## Echo what was pushed, not what HEAD is
Date: 2026-08-09
Why: The orchestrator ran `git commit && git push origin main && echo "pushed $(git rev-parse --short HEAD)"`
from a shared working directory that was checked out on a **lane's branch**. The
commit landed on that branch, `git push origin main` pushed the unchanged local
`main` ref, and the echo printed the lane's new SHA — so it read as success. One
queue row sat on a packet branch and on no other ref until the lane noticed.
How to apply: assert on the **remote**, not on HEAD:
`git push origin main && git ls-remote origin main`. And never commit from a
working directory you did not verify the branch of — `lanes.md` already says leases
separate paths, not directories. Same class as the wrapper exit status that masked
an aborted matrix: a report derived from the wrong thing.

## Audit every operation a surface repair makes reachable
Date: 2026-08-18
Why: restoring an inert form also restored generic Edit on posted transactions
and opened posted → draft → Post twice. How to apply: enumerate every newly
reachable New, Edit, command and lifecycle path; execute state-boundary twins
through the provider, and make affordances follow the same compiled predicates.
See ADR-0054 and `docs/execution/packets/inventory-form-anatomy.md`.

## Sweep every renderer that owns operator-visible copy
Date: 2026-08-20
Why: `inventory-surface-legibility` audited the slot renderer but missed Task-page
copy in `surface-runtime.ts`, leaving “compiled release” and a canonical ID live.
How to apply: trace page-level and slot-level renderers for every shipped archetype,
then assert the absence of implementation copy on a real product journey.

## Preserve authored copy; normalize identifiers only
Date: 2026-08-20
Why: one label helper corrupted VAT, R&D and iPhone while using transformed display
copy to infer canonical field prefixes. How to apply: preserve authored labels
except contract-declared role suffixes, and derive structure only from compiled
canonical identity; test a display label that differs from that identity.

## Mutate to the cheapest equivalent defect, not only the old spelling
Date: 2026-08-20
Why: restoring `.surface-id` and “compiled release” red while a classless ID and
renamed runtime eyebrow stayed green. How to apply: obtain the forbidden value
independently and assert visible content at its semantic boundary; mutate class,
wording and placement away from the historical markup.

## Uncorrelate fixtures that claim one authority
Date: 2026-08-20
Why: entity, field and surface locals all said `master`, so surface-ID-derived
prefixes passed a test claiming query/record authority. How to apply: make every
non-authoritative identifier opaque and divergent, then exercise each changed
branch directly so the wrong authority produces a different observation.

## Translate refusals at an owned seam
Date: 2026-08-20
Why: `web-refusal-taxonomy` first imported a PostgreSQL-provider error into web,
breaching the existing provider-neutral transport boundary.
How to apply: translate a provider refusal into an owner-neutral typed error at
the provider port; downstream transports consume only the owning-layer seam.

## Preserve concurrent evaluation when translating one source
Date: 2026-08-20
Why: an `async` loader wrapper converted a synchronous throw into rejection, so
policy ran when the original `Promise.all` expression stopped before calling it.
How to apply: preserve call order and original handlers; name each timing class
the controls directly observe instead of claiming promise precedence in general.

## Hold sibling promises pending when testing a join
Date: 2026-08-21
Why: an already-rejected pair did not prove first-rejection settlement.
How to apply: reject each input first, hold its sibling, and observe settlement
before release. Limit: this proves no-wait, not same-turn order through wrappers.
## Measure dependency fences before chartering paths
Date: 2026-08-20
Why: two correct stock-balance stops were caused by charters that fenced the
family-registration files before checking the already-pinned legal-entity map.
How to apply: trace every required registration and generated-contract dependency
before assigning owned paths; fence by measured intent, then name the bounded files.

## Make conformance exemptions earned and two-sided
Date: 2026-08-20
Why: ADR-0007 sanctioned provider-written read models, but generic conformance
could not admit one without an explicit exemption category.
How to apply: resolve every exemption from a pinned contract, name its maintainer,
and ship the refusing twin that rejects authored behavior in the exempted category.

## A database type is not the platform's canonical value contract
Date: 2026-08-20
Why: PostgreSQL accepted a raw MD5 digest as `uuid`, and privileged arithmetic
controls read the projection green, but the generic record runtime refused that
identifier because it was not UUIDv4. Only the ordinary gateway/browser path
observed the mismatch.
How to apply: provider-generated values must satisfy the canonical runtime
contract, not merely the database type. Read a generated row back through the
ordinary gateway and assert the exact canonical shape; rebuild must reproduce
the same value.

## A refusing twin must inspect the full emitted catalog
Date: 2026-08-20
Why: the provider-written refusal reused the narrower set built to prove required
active `o0` CRUD. An `o1` record effect and a transition effect whose entity was
resolved only during lowering therefore entered the operation catalog without
the promised compile-time refusal.
How to apply: derive refusing-twin ownership over every authored lifecycle and
tier the compiler emits, resolving indirect carriers such as state-machine
transitions. Keep the narrower admissibility set separate; it answers a different
question. Prove each carrier with a mutant that removes only its ownership arm.

## Pin every storage-shaping property before omitting authored maintenance
Date: 2026-08-20
Why: scalar field checks admitted a provider-written balance carrying an authored
business key whose physical unique index contradicted the provider's row identity.
How to apply: qualify read models against every lowerer-affecting field property,
return explicit validity, and make each malformed specimen prove the full
maintenance/form requirement returns—not merely that some diagnostic exists.

## Carry exact ABI qualification through every required companion
Date: 2026-08-21
Why: posted stock required a “valid” movement companion, but that boolean proved
only logical field shape and admitted a business key that PostgreSQL could not
materialize on the partitioned movement fact table.
How to apply: when admission depends on a companion, validate every downstream
storage-shaping property on both subjects and test the companion’s exact red plus
the dependent subject’s complete returned requirements.

## Qualify every authored construct that shapes a provider ABI
Date: 2026-08-21
Why: exact movement fields still admitted an extra declared relation whose
column, foreign key and index made the posting provider reject the storage target.
How to apply: enumerate fields, declared relations and every other authored
construct family consumed by lowering; qualify every provider-maintained input
exactly, and explicitly prove that each unpinned construct is benign.

## Bind a control's expected red to the assertion that carries its claim
Date: 2026-08-26
Why: `relation-requiredness-relaxation`'s fail-closed control mutated the renderer
allowlist so it refused EVERY element kind, so the test died on its earlier
admission assertion (`expected: 0, actual: 14`) and never reached the unknown-kind
claim; a generic `strictEqual|deepEqual` expected pattern accepted the unrelated
failure. The control demonstrated the OPPOSITE of the property it was written for,
and the lane had cited "verify why a red fired" one round earlier.
How to apply: run every new mutation and read WHICH assertion fails before
committing it; leave any precondition the test asserts ahead of the claim intact,
and make `expected` name a token unique to the claimed assertion rather than a
generic assertion-failure shape. See `docs/execution/packets/relation-requiredness-relaxation.md`.

## Size the process to the risk that exists, not the risk the architecture is designed for
Date: 2026-09-04
Why: six weeks in, packets averaged four to six review rounds with zero PASS verdicts, records
ran 700-900 lines, the local matrix serialized every lane through one Docker slot with false
reds, and four of eight packets between the purchase order and the goods receipt existed to
protect released data that no tenant holds. The method caught real defects; its cost was
process that never executed its own convergence rules, and immutability applied before there
was anything to keep immutable. Measured in `program-reviews/2026-09-01-inventory-ledger.md`.
How to apply: `AGENTS.md` (2026-09-04) — one vertical per lane worked continuously, CI as the gate,
one arm on the Critical set only, one-page records, pre-tenant re-baselining (ADR-0066), and a
doctrine freeze: no new rule without deleting one. Graduated to `AGENTS.md`.

## Preserve lifecycle read-back when refreshing derived record sections
Date: 2026-09-05
Why: RECEIPT's blanket post-operation refresh queried an archived Party as active, hiding a successful archive; it also made stock replay depend on unrelated query inputs.
How to apply: scope derived-section refresh to the receiving commands that need it; retain ordinary operation read-back. The unchanged Party archive and stock replay browser assertions caught both regressions. See `docs/execution/packets/RECEIPT.md`.

## Separate current authorization from historical retry evidence
Date: 2026-09-05
Why: the real receiving gateway's unchanged retry conflicted after grant restoration because the version-5 digest includes the policy revision.
How to apply: authorize every retry against current policy, but reconstruct a historical digest using its immutable recorded authorization evidence; never rewrite its business input or persisted digest. Exercise revocation, restoration and same-key retry together. See `docs/execution/packets/RECEIPT.md`.

## Refresh protected task displays independently of retry state
Date: 2026-09-15
Why: RAIN-META-SALES P1 reproduced cached root/child disclosure after read revocation, including a committed-withheld response.
How to apply: reload actual display dependencies through governed reads; redact the complete response on failure while preserving committed status, receipts and frozen execution state. See [P1/P2 correction](docs/execution/packets/RAIN-META-SALES.md).

## Bind confirmation to the exact prepared generation
Date: 2026-09-15
Why: RAIN-META-SALES P2 reproduced an old review form dispatching replacement inputs from the same task session.
How to apply: bind an immutable normalized preparation to a server-issued identity, reject stale confirmation before dispatch, and use deterministic barriers to prove delayed validation cannot overwrite newer or confirmed state. See [P1/P2 correction](docs/execution/packets/RAIN-META-SALES.md).

## Retain plain entity reads beside derived document queries
Date: 2026-10-04
Why: VALUATION slice-two CI refused release admission after shipment and invoice gets gained read models; verification deliberately executes plain queries only.
How to apply: preserve the original plain get identity for every costed entity and its declared probes; use a separate derived display query and assert both in the compiled artifact in the metadata contract. See [VALUATION](docs/execution/packets/VALUATION.md).
