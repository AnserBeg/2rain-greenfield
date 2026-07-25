# PR-5 — Idempotency scope

Status: active — implementation and focused provider evidence green; full matrix and Critical review pending
Tier: Critical
Branch: `packet/pr-5`
Base: `17d175a7b5f2df903dcf9db4afeca5524babb56d`
Frozen reviewed candidate: pending
Review: pending — fresh naive Codex `gpt-5.6-sol` xhigh to PASS, then Fable max on the identical SHA

## Authority and outcome

PR-5 corrects PR-3's durable O0 receipt identity from seven dimensions to the
binding four:

```text
(tenant_id, environment_id, action_id, idempotency_key)
```

`principal_id`, `release_id`, and `release_content_hash` remain immutable
recorded attributes of the first accepted mutation. They no longer let a retry
miss its receipt. The PostgreSQL primary key, receipt lookup, transaction-level
advisory lock, and both receipt RLS policies narrow together.

A hit by the recorded principal with the same canonical input digest returns
the stored result without invoking module DML. Release ID and content-hash
changes are normal replay conditions. A principal mismatch or input-digest
mismatch returns the existing typed `TrustEvidenceError` with stable code
`SEMANTIC_OPERATION_IDEMPOTENCY_CONFLICT`; it neither returns
`mutation_result` nor invokes module DML.

No compiler, release-kernel, UI, dependency, lockfile, golden, fixture payload,
or product module source changed. PR-6 indexing and request-path SLO work remain
out of scope.

## Four-layer correction

1. Migration `0010_semantic_operation_receipt_scope.sql` replaces the
   seven-column primary key with the four-column identity.
2. `findIdempotencyReceipt()` filters only on those four columns and returns
   the recorded principal for the conflict check.
3. `lockIdempotencyBinding()` hashes the same four values, so concurrent
   retries serialize before lookup or module DML.
4. Receipt SELECT and INSERT policies now scope visibility to tenant and
   environment. Cross-principal visibility is intentional so the provider can
   detect the hit; the provider checks principal identity before returning the
   stored payload. Tenant and environment remain enforced by forced RLS.

The input digest remains a recorded binding checked on every hit. Release ID
and content hash remain validated and recorded on the first insertion but are
not replay identity or conflict dimensions.

## Migration refusal and immutable evidence

Migration 0010 never updates or deletes a receipt. It drops the old primary key
and adds the narrower constraint in the migration runner's transaction. If
0009-era data has duplicate four-column identities, PostgreSQL raises unique
violation `23505`; the whole migration rolls back. The old primary key, all
receipt rows, and the nine-entry migration history remain unchanged. There is
no arbitrary survivor and no silent destruction of audit evidence.

This repository has no persistent program database. The repository-wide
PostgreSQL search shows every provider suite entering through
`test/helpers/postgres.ts::withEphemeralPostgres`; that helper runs the pinned
container with `--rm` and a PostgreSQL data-directory `--tmpfs`, then forcibly
removes it in `finally`. `check:schema` uses the same helper and applies all
migrations from scratch. There is no checked-in Compose service or deployed
database composition. Therefore 0010's program path is a duplicate-free fresh
database, while the refusal probe preserves the safe behavior for any external
database carrying conflicting historical rows.

The generated `db/schema.snapshot.json` changed in exactly four semantic
places: the primary-key constraint, its unique-index definition, and the two
receipt RLS expressions. No column, foreign key, CHECK constraint, immutable
rule, FORCE RLS flag, grant, or unrelated object moved.

## Executable scenarios

The real PostgreSQL provider journey proves all seven required cases:

- a second principal in the same tenant and environment receives the typed
  conflict, has no `mutationResult` on the error, and leaves one business row;
- a fresh view after activating a different release ID with the same content
  hash replays the byte-equivalent result and leaves trust and business-row
  counts unchanged;
- a fresh view after activating a recompiled release with a different content
  hash also replays and leaves counts unchanged;
- the same key with a different canonical input digest returns the typed
  conflict and leaves one business row;
- a real PostgreSQL transaction holds the narrowed advisory lock until two
  provider requests are visibly waiting on it. Releasing the barrier produces
  equal results, one module row, one business change document, and one receipt;
- the same action/key succeeds independently in two tenants, and forced RLS
  exposes only each context's own tenant receipt; and
- UPDATE and DELETE remain rejected by the existing immutable-write guard test
  for `semantic_operation_receipts`.

The concurrency barrier observes PostgreSQL's advisory-lock wait state and
uses `process.hrtime.bigint()` only as a fail-safe deadline. It does not sleep
and infer ordering from elapsed wall time. One request spells the UUID
idempotency key in lowercase and the other in uppercase; both wait on the same
canonicalized lock identity, matching PostgreSQL `uuid` equality.

A separate migration probe creates two valid 0009 receipts that differ only by
principal, attempts 0010, and proves `23505`, both immutable rows retained, the
seven-column primary key restored by rollback, and schema history still at
nine. The clean upgrade test proves a duplicate-free database applies all ten
migrations and matches the checked-in snapshot.

## Authorized bridges

The orchestrator authorized three migration-state paths omitted from the
initial lease:

- `db/schema.snapshot.json`, regenerated from ten applied migrations;
- `test/postgres/module-storage-transition.test.ts`, advanced to the 0010
  migration inventory and 10 verified migrations; and
- `test/fixtures/g2/party/runtime-harness.ts`, advanced to 10/10.

The existing `test/architecture/*` pre-authorization admitted 0010 to the
reviewed migration inventory. These bridges are mechanical and do not consume
review or hard-tripwire budget.

## Retained development reds

The first format check was red on the expanded provider test; repository
Prettier resolved it. The first real-provider journey then failed with
PostgreSQL `42883` (`operator does not exist: text = uuid`) because one new
combined persisted-effect assertion reused a UUID parameter against the trust
document's text `record_id`; explicit casts made both types honest and the
journey passed.

The first two inline snapshot-generator attempts failed before starting
PostgreSQL because `tsx` exposes local CommonJS-transpiled modules through a
dynamic default namespace under `node -e`. The third invocation resolved that
namespace explicitly, applied 10/10 migrations, and regenerated the snapshot.

The first boundary run correctly rejected the initially proposed duplicate
collapse with `AUTH006_HARD_DELETE` on `DELETE FROM`. Work stopped for a design
ruling. The orchestrator ruled that immutable receipts must never be collapsed:
the primary-key unique violation is the migration guard. After replacing the
collapse with transactional refusal, the boundary gate passed and the focused
refusal test proved zero rows removed.

The first Critical Codex review returned `REVISE` on question 2: PostgreSQL
normalizes UUID values for primary-key equality, while the advisory lock hashed
their original text. Concurrent honest retries using lower- and uppercase
spellings of the same key could therefore take different locks and enter module
DML twice. This is the packet's first in-class finding, so the hard-tripwire rule
permits this one bounded fix. Lock UUID components and the recorded-principal
comparison now use lowercase canonical text, and the real contention journey
uses opposite-case key spellings. No other in-scope finding was reported.

## Full-matrix evidence

Pending frozen-candidate run.

## Review evidence

Pending the required fresh Codex xhigh PASS and Fable max confirmation on the
identical unchanged SHA.

## Test it yourself

Pending final candidate SHA. The final commands will run the named real-provider
journey and the duplicate-refusal migration probe in under ten minutes.

## Draft ledger row (do not commit to `ledger.md`)

Pending final reviewed SHA and verdicts.

## Checkpoint

Pending full matrix and Critical review chain. Do not start PR-6.
