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
