# G1-P4b — human-approved activation kernel and crash reconciler

Status: active
Tier: Critical
Base: `dbf871dd68bbb5b4ec2abb9e2b2b7a4d407eda87`
Frozen candidate: `c95302d340d31697384f0c27f1beaaed99c0f113`
(`REVISE` after the user-authorized observability verification; not
evidence-ready)

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

### Preliminary implementation notes

- Migration 0005 adds the per-tenant approver/executor/control authority epoch,
  real append-only executor and deny-only control event streams, swap receipts,
  generation-bound verification receipts, append-only reconciliation starts,
  and durable reconciliation alarms. Its deferred fact-set constraints reject
  any committed P4b `SWAPPED` outcome that lacks exactly one matching receipt,
  history record, and invalidation outbox row.
- The trusted PostgreSQL service accepts only a prebound activation-attempt ID.
  It locks that attempt and the governing authority epoch, rebuilds the approval
  and transition binding from canonical rows, checks expiry with
  `clock_timestamp()` and a 3-second skew margin, and performs the pointer CAS
  plus all swap facts in one transaction. Cancellation uses the same attempt
  serialization. Rollback is the same call path with a fresh approval for the
  earlier immutable release. The runtime acquires the immutable attempt row
  through a trusted-context security-definer lock function, without granting
  raw attempt mutation authority.
- Reconciliation is receipt-driven and pointer-read-only: a receipt resumes
  verification, an unchanged original generation remains retryable through the
  activation call, and a missing receipt plus an advanced fence records
  `LOST_RACE` while holding the attempt and pointer locks. Database uncertainty
  remains `RECONCILING`. A callable activation/reconciliation entry writes one
  serialized start receipt with PostgreSQL time and the versioned max age;
  every later worker derives the deadline from that fact and inserts the alarm
  before finishing overdue recovery. Approval creation alone writes no start.
  Only connection loss, explicit database retry/timeout conditions, and
  ambiguous database failures enter reconciliation; SQL, constraint, binding,
  and programming defects remain visible.
- Post-swap verification records only pointer read-back, artifact availability,
  and release-kernel invariants. It locks and compares the exact generation
  before committing a verdict, so supersession records `SUPERSEDED`. G1 has no
  nonblocking verification class and therefore no warning verdict.
- The P5 seam exports the versioned generation event, names the future
  at-least-once dispatcher owner, and supplies a maximum-fence consumer helper.
  The helper rejects duplicate/reordered fences, requests authoritative reread
  on a gap or doubt, and defines fence-tagged derived-cache discard behavior;
  it is explicitly not request-pinning authority.

### Preliminary focused evidence

- PASS: canonical schema check (`5 applied, 5 verified`, drift clean), frozen
  install, formatting, typecheck, lint, build, and dependency-boundary scan (53
  files).
- PASS: the focused activation matrix executes all 12 real-PostgreSQL scenarios
  (13/13 TAP tests including the parent), including complete-fact cardinality
  assertions for each same-pointer race, a real commit-response TCP disconnect,
  separate child/parent processes and pools, exact no-receipt/advanced-fence
  `LOST_RACE`, and a PostgreSQL outage recovered by a fresh coordinator that
  inherits and persists the overdue alarm.
- PASS: full PostgreSQL (38/38), architecture (23/23), compiler (21/21),
  integration (4/4), and unit (18/18) tests. The browser scaffold has one
  intentional skip because product browser journeys are out of scope at G1.

### Pre-adjudication candidate gates

The orchestrator independently reran the complete declared gate set at
`94fa8a4e96d78d20d6eeeb0ca540cdef57032ef2` with a clean worktree:

| Gate | Result |
|---|---|
| Frozen install | PASS — all 13 workspace projects already up to date |
| Typecheck | PASS |
| Lint | PASS |
| Format | PASS |
| Build | PASS |
| Dependency boundaries | PASS — 53 files scanned |
| Migration/schema drift | PASS — 5 applied, 5 verified; drift clean |
| Unit | PASS — 18/18 |
| Compiler | PASS — 21/21 |
| Integration | PASS — 4/4 |
| Architecture | PASS — 23/23 |
| PostgreSQL | PASS — 38/38, including focused P4b 12/12 scenarios and 13/13 TAP tests |
| Browser | PASS — one intentional scaffold skip |
| Diff/lease/worktree | PASS — `git diff --check`; authorized paths only; clean tree |

The pre-candidate writer sandbox could not access Docker or child processes;
the orchestrator's first real focused run then exposed masked PostgreSQL errors
and was red 0/11. The writer corrected the trusted attempt lock, PostgreSQL
append-only insert mechanics, fixture isolation, and commit-disconnect timing
before freezing `830763d`. No red gate was hidden as candidate evidence.

### Review evidence and convergence stop

- Initial candidate `830763d00e32c3c4bd78d2b9f79fd9aef253537e`
  passed the complete gate set.
- Fresh naive Codex `gpt-5.6-sol` xhigh round 1: **REVISE**. It found two
  in-scope material issues: reconciliation age was process-local rather than
  durable across worker crashes/handoffs, and the no-receipt/advanced-fence
  `LOST_RACE` branch lacked a material PostgreSQL test. It reported no future
  work.
- The writer fixed exactly those findings in candidate
  `94fa8a4e96d78d20d6eeeb0ca540cdef57032ef2`, added the adjudicated durable-age
  learning, and the orchestrator reran every gate above.
- Fresh naive Codex `gpt-5.6-sol` xhigh round 2: **REVISE**. Finding 2 is
  closed, with non-vacuous no-receipt/no-outcome/advanced-fence evidence and
  correct attempt/pointer serialization. Finding 1 remains open at one crash
  boundary: successful swap, verification, or terminal recovery can commit,
  then the worker can crash before the separate overdue-alarm transaction.
  The current outage test inserts the alarm before enabling successful
  recovery, so it does not exercise that commit/crash interval. No direct fix
  regressions or future-work findings were reported.
- The user-authorized cap of two `REVISE` rounds is reached. Per
  `review-tiers`, no third review/fix hunt is started. Fable was not launched
  because the required Codex PASS was not reached on the identical SHA.

### User-adjudicated observability fix and scoped verification

The user adjudicated the remaining finding valid but low-materiality and
authorized one narrow fix round. Critical-tier writer `gpt-5.6-sol` xhigh
added a read-only reconciliation inspection derived from the immutable start,
durable max-age, and durable outcome/verification facts. Alarm presence is
reported separately and remains idempotent under the existing per-attempt
primary key. A focused PostgreSQL fault test drops the terminal-outcome commit
response, proves the alarm row is absent, and uses a fresh pool/service to
derive `OVERDUE_COMPLETED`. No migration was changed.

The orchestrator independently reran the complete declared gate set at frozen
candidate `c95302d340d31697384f0c27f1beaaed99c0f113`:

| Gate | Result |
|---|---|
| Frozen install | PASS — all 13 workspace projects already up to date |
| Typecheck | PASS |
| Lint | PASS |
| Format | PASS |
| Build | PASS |
| Dependency boundaries | PASS — 53 files scanned |
| Migration/schema drift | PASS — 5 applied, 5 verified; drift clean |
| Unit | PASS — 18/18 |
| Compiler | PASS — 21/21 |
| Integration | PASS — 4/4 |
| Architecture | PASS — 23/23 |
| PostgreSQL | PASS — 39/39, including focused P4b 13/13 scenarios and 14/14 TAP tests |
| Browser | PASS — one intentional scaffold skip |
| Diff/lease/worktree | PASS — `git diff --check`; four authorized fix files only; clean tree |

The one fresh naive Codex `gpt-5.6-sol` xhigh verification returned
**REVISE** against the exact charter: "does this fix make the overdue condition
durably derivable and crash-proof, and did it change anything outside that
concern?" It found one concrete in-scope false-negative: outcome and
verification `recorded_at` use PostgreSQL `transaction_timestamp()`. A recovery
transaction can begin before the deadline, block on the pointer lock across
the deadline, then insert and commit after it. The inspection treats the
transaction-start timestamp as completion and permanently reports
`COMPLETED_WITHIN_MAX_AGE`. The new fault test is non-vacuous for the original
post-commit/pre-alarm crash window, but starts the outcome transaction only
after the deadline and therefore does not cover this crossing case. The
reviewer confirmed that the alarm is non-authoritative and idempotent, that no
unrelated change was introduced, and reported no future-work findings.

The orchestrator confirmed the timestamp semantics and reachable lock path.
The authorization was exactly one fix round followed by one scoped Codex
verification, so no second fix/review cycle was started. Fable was not launched
because Critical-tier sequencing requires a Codex PASS on the identical SHA.

G1-P4b remains `active`, not `evidence_ready`. The transaction-crossing-deadline
finding requires user direction before any further fix. The ledger therefore
remains `active`, doctrine coverage is not advanced, and G1-P5 has not been
started.

## Test it yourself

No UI exists in this packet. These commands complete in under ten minutes:

```bash
cd /home/rvham/2rain-greenfield-wt/g1-p4b
git merge-base --is-ancestor c95302d340d31697384f0c27f1beaaed99c0f113 HEAD
corepack pnpm check:schema
node --import tsx --test test/postgres/release-activation.test.ts
```

Expected: 5 migrations apply and verify with clean drift; the focused P4b
suite reports 13/13 scenarios and 14/14 TAP tests, including the durable-age
fresh-coordinator, no-receipt/advanced-fence, and post-commit/no-alarm cases.
Passing tests do not override the scoped verification finding above.
