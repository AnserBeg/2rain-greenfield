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

## Derive persisted envelope versions from canonical authority
Date: 2026-07-23
Why: G2-P2a copied legacy-compatible compiler-input versions into a current persisted release envelope, causing downstream PostgreSQL registration to reject it.
How to apply: derive cross-layer persisted envelope language/profile versions from canonical constants; when compiler roots or persisted metadata change, run downstream PostgreSQL registration suites before acceptance. See [G2-P2a-fix](docs/execution/packets/G2-P2a-manifest-version.md).

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
