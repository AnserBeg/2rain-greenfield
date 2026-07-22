# G1-P4b — human-approved activation kernel and crash reconciler

Status: active
Tier: Critical
Base: `dbf871dd68bbb5b4ec2abb9e2b2b7a4d407eda87`
Frozen candidate: pending

## Goal and scope

Make the G1-P4a approval and pointer contracts callable only as one complete,
crash-safe activation kernel: exact live-policy CAS, atomic swap evidence,
receipt-driven reconciliation, generation-bound verification, compatible
rollback, and the frozen P5 invalidation contract.

Owned paths:

- `db/migrations/0005_release_activation_kernel.sql`
- `db/schema.snapshot.json`
- `packages/platform-runtime/src/release-activation.ts`
- `packages/platform-runtime/src/index.ts`
- `packages/postgres-provider/src/release-activation-service.ts`
- `packages/postgres-provider/src/release-approval-service.ts` only for a
  narrowly required shared trusted-record helper
- `packages/postgres-provider/package.json`
- `test/postgres/release-activation.test.ts`
- `test/postgres/release-approval.test.ts` only for regression expectations
  affected by migration 0005
- `test/postgres/releases.test.ts` only for migration-0005 schema/grant
  expectations
- `test/architecture/release-activation-boundary.test.ts`
- `test/architecture/release-persistence-boundary.test.ts` migration-list
  expectation only
- `docs/execution/packets/G1-P4b.md`
- `docs/execution/ledger.md`
- `docs/execution/doctrine-coverage.md`
- `learnings.md` only for an adjudicated reusable lesson

The writer may add one narrowly named activation-kernel helper or focused test
fixture beneath the owned package/test directories when it preserves these
boundaries. Any need to change an accepted migration, the compiler, immutable
release repository, trusted request-context source, or unrelated package is a
stop-and-bridge request.

Out of scope: storage migration execution, leases/backfills, fleet rollout or
dispatcher implementation, approval UI/public API, request pinning, rich
application verification, G1-P5, and unrelated hardening. PITR recovery
incarnation, artifact-GC roots, G7 approval fan-out/ADR amendment, and G2
shared-schema coexistence remain tracked doctrine work rather than P4b code.

Runnable exit: activation and reconciliation are callable together. No public
UI/API is added; rollback is another exact human-approved activation. The
repository remains buildable and P4b stops at user acceptance.

## Binding activation transaction

One PostgreSQL transaction must serialize the attempt and commit all of these
facts or none:

- an exact pointer CAS on tenant, environment, stable pointer identity,
  expected release including explicit null, expected fence, and the live
  authorization/policy epoch from the real substrate (or conflicting locks on
  every governing authority row);
- exactly one fence increment;
- one unique swap receipt for the prebound attempt;
- one immutable activation-history row; and
- one versioned, generation-tagged invalidation outbox row.

An ordinary policy read inside the transaction is not sufficient. Revocation
or an eligibility-changing policy bump must conflict with or invalidate the
CAS. Advisory locks may throttle work but are never correctness authority.

## Attempt lifecycle and reconciliation

The swap receipt is decisive:

- receipt exists: this attempt swapped; resume post-swap work even after a
  later generation supersedes it;
- no receipt and the exact pointer identity/release/fence remains: retry the
  same attempt's CAS;
- no receipt and the fence advanced: record terminal lost race only in a
  transaction that re-verifies both facts; and
- database unavailable: remain `RECONCILING`, never guess and never consume
  another approval.

`RECONCILING` has a durable max-age alarm. Stale pointer, expiry, invalid
binding, obsolete policy version, definitive blocking-check failure,
cancellation, approver revocation, and pre-CAS live-policy deny are terminal
and consume the approval only after authoritative no-swap proof. Infrastructure
errors, timeouts, ambiguous commit, executor unavailability, and rollout pause
remain resumable. Cancellation/terminal-outcome insertion and CAS serialize on
the attempt so mutually contradictory decisive outcomes cannot commit.

Immediately pre-CAS the kernel rechecks the approving human's current
eligibility and the executing principal's current mechanical authority using
real persisted authority state. Current policy may deny but cannot create a
human approval. Expiry uses PostgreSQL `clock_timestamp()` with a margin above
the bounded backward-clock step; once observed, expiry is durably terminal so
clock reversal cannot revive it.

## Verification, rollback, and fences

Safety-critical checks are blocking pre-CAS. G1 post-swap verification is
observational, read-only, idempotent, and limited to pointer read-back,
artifact availability, and release-kernel invariants. Every verdict commit
checks the exact pointer generation: a superseded generation records
`SUPERSEDED`, never failure. `SWAPPED_WITH_WARNING` is allowed only for a check
classified nonblocking before activation; required failure records
`SWAPPED_VERIFICATION_FAILED` while the pointer remains authoritative.

Every generation-specific coordinator effect checks the fence. The reconciler
may retry reads and verification, deliver invalidations, and raise incidents;
it never moves the pointer. Rollback activates a prior immutable release with
a new approval through the same CAS path and never rewrites history or business
transactions. G1's transition-readiness port fails closed unless the exact-pair
receipt carries the canonical no-storage-transition verdict allowed by the
versioned compatibility policy.

## Frozen P5 invalidation contract

The named activation-invalidation dispatcher owns at-least-once delivery;
consumers are idempotent. PostgreSQL guarantees one committed outbox row, not
exactly-once external delivery. The versioned event contains tenant,
environment, pointer identity, old/new release, fence, attempt/history IDs,
outbox/dedup identity, and schema version.

Consumers maintain a per-pointer maximum fence, reject `fence <= lastSeen`,
and reread the authoritative pointer on a gap or doubt. Any cached derived view
is tagged with the fence read from the pointer in the same snapshot as its
artifact reads and is dropped when below the highest invalidated fence. Cache
invalidation is not request-pinning authority; G1-P5 must validate against the
pointer.

## Required proof matrix

Focused PostgreSQL/service tests must cover:

- different targets racing from one base and the same target under different
  approvals;
- concurrent retries of one approval and FIRST activation from null;
- the same tenant in different environments and two tenants concurrently;
- rollback racing forward activation and a zombie attempt after later fences;
- commit-disconnect ambiguity using a TCP proxy or `pg_terminate_backend`;
- terminal failure/cancellation racing CAS;
- approver revocation and policy-version bump racing CAS;
- verification racing supersession;
- duplicate and reordered outbox delivery; and
- separate web/worker processes and pools.

Every same-pointer race proves one fence increment, one receipt, one history
row, one outbox row, and one winner. Tests also prove durable expiry,
reconciliation max-age alarms, no ambient tenant/release fallback, fail-closed
rollback readiness, and that the reconciler cannot mutate a pointer.

## Gates

- `corepack pnpm install --frozen-lockfile`
- `corepack pnpm typecheck`
- `corepack pnpm lint`
- `corepack pnpm format`
- `corepack pnpm build`
- `corepack pnpm check:boundaries`
- `corepack pnpm check:schema`
- `corepack pnpm test:unit`
- `corepack pnpm test:compiler`
- `corepack pnpm test:integration`
- `corepack pnpm test:architecture`
- `corepack pnpm test:postgres`
- `corepack pnpm test:browser`
- `git diff --check dbf871dd68bbb5b4ec2abb9e2b2b7a4d407eda87...HEAD`

## Review charter

Gates must be green before review. In scope: the design above, the complete
race/crash matrix, real non-vacuous authority checks, and database constraint
enforcement. Threat model: races, crashes, ambiguous commits, and stale/zombie
coordinators in honest code; not hostile input. Out of scope: migration
execution, fleet implementation, approval UI, rich application verification,
and findings unrelated to this packet; valid unrelated issues become
future-work rows and are not chased.

Decisive questions: does the atomic transaction admit exactly one winner with
all five facts; can every ambiguous/crashed attempt reconcile without guessing;
can revocation, expiry, cancellation, supersession, or a zombie cross its
fence; is rollback the same governed path; and does the invalidation contract
give P5 a sound monotonic consumer seam without claiming pinning authority?

Critical tier requires a fresh naive Codex `gpt-5.6-sol` xhigh review to PASS,
then Fable max on the identical unchanged SHA. Any code fix creates a new SHA
and fresh review. At most two `REVISE` rounds are permitted before stopping and
surfacing the result.

## Evidence

Pending implementation, frozen candidate, gates, reviews, and user checkpoint.
