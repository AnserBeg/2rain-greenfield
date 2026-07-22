# G1-P4a — release activation contracts and approval substrate

Status: active
Tier: Critical
Frozen candidate: pending

## Goal and scope

Freeze the PostgreSQL schemas, immutable contracts, real approval-authority
substrate, and trusted server-side approval service that the activation kernel
will consume. This packet deliberately exposes no callable activation path:
G1-P4b must land the pointer CAS and its crash reconciler together.

Owned paths:

- `db/migrations/0004_release_activation_contracts.sql`
- `db/schema.snapshot.json`
- `packages/platform-runtime/src/release-activation.ts`
- `packages/platform-runtime/src/index.ts`
- `packages/postgres-provider/src/release-approval-service.ts`
- `packages/postgres-provider/package.json`
- `test/postgres/release-approval.test.ts`
- `test/postgres/releases.test.ts` (scope the legacy immutable-rule count to
  the six G1-P3 release tables only)
- `test/architecture/release-persistence-boundary.test.ts` (migration-list
  expectation only)
- `test/architecture/release-activation-boundary.test.ts`
- `docs/execution/packets/G1-P0.md`
- `docs/execution/packets/G1-P4a.md`
- `docs/execution/ledger.md`
- `docs/execution/doctrine-coverage.md`
- `learnings.md`

The writer may add a narrowly named activation-contract/provider helper or
focused test fixture under those same package/test directories when it keeps
the ownership boundary intact. Any need to change the compiler, immutable
release repository, trusted request-context implementation, or an accepted
migration is a stop-and-bridge request.

Out of scope: pointer mutation from application code, activation/rollback,
reconciliation, migration execution, leases/backfills, fleet rollout,
approval UI/public API, request pinning, and rich application verification.

Runnable exit: migrations and the approval service are executable and tested,
but an architecture gate proves there is no callable activation/CAS path.

## Binding design

### Persistence and isolation

- `ActiveReleasePointer` has one stable identity per tenant/environment, a
  nullable release, and a monotonic fence. Migration 0004 backfills null rows
  for every existing environment and installs the environment-creation
  invariant for future rows.
- The pointer is designed as the first runtime-updatable platform table.
  Forced RLS has distinct `SELECT` and `UPDATE` policies; the update policy
  uses both `USING` and `WITH CHECK` against the trusted tenant, environment,
  and principal context. P4a grants runtime `SELECT` only. P4b owns enabling
  `UPDATE` together with the trusted CAS service and crash reconciler.
- A database trigger permits only a release change with
  `new.fence = old.fence + 1`; it rejects pointer identity changes, skipped or
  repeated fences, and every other mutation shape.
- Release approvals, activation attempts, phase receipts, transition
  preparation receipts, activation history, decisive outcomes, and reserved
  outbox records are immutable/append-only. Runtime grants are `SELECT` and
  `INSERT` only where needed; update/delete attempts are rejected with the
  migration-0003 guard pattern.
- Each approval prebinds exactly one immutable attempt identity. Each attempt
  has at most one decisive outcome row under a database uniqueness constraint.

### Real authority and approval creation

- The substrate stores real per-principal approver eligibility and a
  monotonic per-tenant policy version. Every eligibility-affecting change,
  including one-principal revocation, atomically advances the version. Tests
  exercise live grants and revocations; no stub may certify current-policy or
  maker-checker behavior.
- `createApproval` is a trusted server-side application service. Its caller
  supplies identities, not authority or digest assertions. The service reads
  the current pointer, target release, canonical preparation/evidence record,
  and current authority policy; it recomputes and stores the approval binding.
- The immutable binding includes tenant/environment, minted target release ID
  and content root, pointer identity, expected release (including explicit
  null) and fence, prebound attempt identity, evidence/capability/diff/
  transition/compiler/renderer/policy versions, approving human, issuing
  actor, initiating human, optional `sourceDecisionId`/`rolloutId`, and a
  mandatory expiry. Omitted expiry uses the versioned platform default.
- The approving human must be currently eligible and different from the
  release maker. The service rejects caller attempts to substitute canonical
  roots, expected pointer facts, policy versions, or preparation evidence.
- First activation uses an explicit versioned null-base binding. It does not
  fabricate a non-null `ReleaseDiffEnvelope.fromManifestRoot`; its
  deterministic no-storage-transition verdict covers the initial case.

### Compatibility and outcome contracts

Compatibility has three distinct contributors: compiler static facts,
executor applied-state evidence, and a versioned compatibility policy. Only
the policy decides allow/deny. Irreversible does not mean incompatible;
forward-recovery-only classes exist. A no-op storage verdict is necessary but
never sufficient and still passes through the versioned policy.

The immutable exact-pair `TransitionPreparationReceipt` reserves:

- nullable source root plus target root;
- transition scope (`tenantLocal` or `sharedDatabase`);
- storage-domain identity and schema generation;
- compiler facts, executor evidence, compatibility policy version, and policy
  verdict.

The attempt model keeps pointer outcome, verification outcome, and workflow
disposition orthogonal. Stable versioned codes include nonterminal `PAUSED`,
terminal `CANCELLED`, and `SWAPPED_THEN_SUPERSEDED` without collapsing one
dimension into another.

| Condition | Classification | Approval disposition |
|---|---|---|
| stale pointer/base or lost race | terminal | consumed |
| expired approval | terminal | consumed |
| invalid binding/evidence | terminal | consumed |
| obsolete policy version | terminal | consumed |
| definitive blocking-check failure | terminal | consumed |
| cancellation | terminal | consumed |
| approver revocation | terminal | consumed |
| pre-CAS live-policy deny | terminal | consumed |
| infrastructure error | resumable | retained |
| timeout or ambiguous commit | resumable / reconciling | retained |
| executor unavailable | resumable | retained |
| rollout pause | resumable / paused | retained |

P4b must use the receipt as the decisive fact after an ambiguous commit. This
packet defines that state vocabulary but does not implement any transition.

### Fleet and recovery seams

- Approval/history contracts distinguish `approvingHuman`, `issuingActor`,
  `initiatingHuman`, and `executionPrincipal`. Reconciler and dispatcher work
  uses a defined SYSTEM service-principal kind per ADR-0010; automation never
  appears as a human actor.
- `sourceDecisionId` and `rolloutId` preserve decision lineage. The future
  rollout-control hook is deny-only immediately before CAS.
- Outcome and outbox envelopes are explicitly versioned. P4b owns committing
  and dispatching the event.
- P4b must freeze the P5 invalidation contract and may not expose activation
  without its crash reconciler. It also owns enabling the pointer `UPDATE`
  privilege in the same packet as that CAS/reconciliation path.

## Required proof

Focused PostgreSQL and application-service tests must prove:

- existing-environment backfill and future-environment pointer creation;
- exact `+1` fence enforcement and rejection of every other update shape;
- pointer RLS `UPDATE` isolation with both `USING` and `WITH CHECK`;
- production runtime has no pointer `UPDATE` privilege; focused RLS and trigger
  tests use a temporary admin grant that is revoked afterward;
- append-only enforcement and restricted grants;
- one decisive outcome per attempt;
- every approver eligibility change advances the tenant policy version;
- approval binding is recomputed from canonical records;
- current-policy eligibility and maker-checker rejection;
- default and explicit mandatory expiry;
- versioned first-activation binding with a null base; and
- no callable activation, rollback, pointer-CAS, or reconciler API.

Full candidate gates and Critical-tier review evidence will be recorded after
the implementation is frozen.

## Writer implementation notes (preliminary)

- Migration 0004 backfills and trigger-creates one nullable, fenced pointer
  per environment; forced RLS installs `SELECT`/`UPDATE` policies but grants
  the runtime only `SELECT`. An exact-swap trigger requires fence `+1`, and a
  delete-reject rule preserves pointer identity. P4b owns granting `UPDATE`
  with its CAS and crash reconciler.
- Approver eligibility is an append-only event stream. A database trigger
  serializes each tenant and assigns the next policy version; the only mutation
  entry is a migration-owner function with no runtime `EXECUTE` grant.
- Immutable preparation, compatibility receipt, approval, prebound SYSTEM
  attempt, phase/history/outcome, and reserved outbox records use exact scoped
  foreign keys, bytea digests, append-only rules, and narrow runtime grants.
- `PostgresReleaseApprovalService.createApproval` accepts identities and actor
  lineage only. One trusted transaction locks the authority snapshot, reads
  the current pointer and immutable release/preparation/receipt, recomputes
  the versioned compatibility result, enforces live eligibility and
  maker-checker, bounds mandatory expiry, and stores approval plus its one
  prebound attempt. P4b revalidates the immutable pointer binding before CAS.
- No application method, production SQL, or runtime privilege can mutate the
  active pointer. The only successful pointer update in P4a is a focused
  database-constraint test under a temporary admin-installed runtime grant
  that the test revokes afterward.

Preliminary focused writer gates: schema migration/drift PASS (4 applied, 4
verified); focused PostgreSQL PASS (9/9); focused activation/persistence
architecture PASS (7/7); typecheck, lint, and format PASS. Full declared gates
remain pending until the candidate is frozen; this is not review evidence.

## Review charter

Threat model: races, crashes, ambiguous commits, and stale/zombie coordinators
in honest code; not hostile input.

In scope: the binding design above, the P4b race/crash contract it must safely
support, substrate reality (no vacuous authority checks), database constraint
enforcement, approval identity recomputation, and the absence of a callable
activation path.

Out of scope: migration execution, fleet implementation, approval UI/public
API, rich application verification, and unrelated hardening. Critical tier
requires one fresh naive Codex xhigh review followed by Fable max on the
identical unchanged SHA. At most two `REVISE` rounds are permitted.

## Gate evidence

Pending.

## Review evidence

Pending.

## Test it yourself

Pending frozen-candidate commands.
