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
