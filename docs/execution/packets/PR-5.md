# PR-5 — Idempotency scope

Status: evidence_ready — full matrix green; Critical Codex and Fable reviews PASS
Tier: Critical
Branch: `packet/pr-5`
Base: `17d175a7b5f2df903dcf9db4afeca5524babb56d`
Frozen reviewed candidate: `7393eeed91bfb5f8e353ec9bd83ce2a065354ead`
Review: PASS — fresh naive Codex `gpt-5.6-sol` xhigh, then Fable max on the identical SHA

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

The full matrix ran from a clean tree at exact frozen candidate
`7393eeed91bfb5f8e353ec9bd83ce2a065354ead`. PostgreSQL passed on its first
attempt; no WSL2 container retry was needed.

| Gate | Result |
|---|---|
| frozen install | PASS — pnpm 11.9.0; all 13 workspace projects already current |
| format | PASS |
| lint | PASS |
| typecheck | PASS |
| dependency boundaries | PASS — 94 files scanned |
| build | PASS |
| unit | PASS — 27/27 |
| compiler | PASS — 49/49 |
| integration | PASS — 42/42 |
| agent | PASS — 1/1 |
| architecture | PASS — 51/51 |
| demo-release check | PASS |
| contracts | PASS — 6/6 |
| schema | PASS — 10 applied / 10 verified; no drift |
| PostgreSQL | PASS — 62/62 on the first attempt, including mixed-case concurrent receipt contention |
| locale | PASS — 1/1 |
| browser | PASS — 5/5 |
| observability inline producer | PASS — 5/5 |
| executed-file reachability | PASS — 49/49 files from 9 producer artifacts |
| security | PASS — 215 commits clean; 1 expected finding in the disposable negative fixture |
| patch and tree cleanliness | PASS — `git diff --check main...HEAD`, empty worktree diff, and no tracked or untracked residue |

The matrix used reachability run token
`f65729e5-282c-4c51-90f1-a22da2d2ca76`. Focused runs and the earlier complete
matrix at `f5f6fd1` were development evidence only and did not substitute for
this exact-candidate run.

| Commit | Purpose |
|---|---|
| `e8885ec7a8263f6ac4c2881aab4ddf798e894eb9` | Narrow receipt PK, lookup, lock, and RLS; add refusal and real-provider evidence; regenerate the schema snapshot |
| `f5f6fd1a3fbcb4416ef0421764a6004bca74de4d` | Record implementation and development evidence |
| `7393eeed91bfb5f8e353ec9bd83ce2a065354ead` | Canonicalize UUID lock identity and prove mixed-case concurrent retries serialize |

## Review evidence

Both reviewers received the same bounded Critical charter: accept the ruled
four-column identity; trace PK, lookup, advisory lock, and both RLS policies;
decide whether concurrent retries can execute twice; prove a principal
mismatch returns neither payload nor a second mutation; verify migration
refusal preserves immutable guards, foreign keys, CHECK, FORCE RLS, and grants;
verify two-tenant isolation and persisted-effect assertions; and reject scope,
dependency, golden, fixture, hard-delete, or assertion regressions. The threat
model was an honest retry after timeout, activation, or recompile plus two
concurrent retries. PR-6, key minting/expiry, G3 natural-key idempotency,
reachability internals, compiler/release correctness, performance, style,
pending plan decisions, and adversarial key forgery were explicitly excluded.

Fresh Codex round 1 reviewed
`f5f6fd1a3fbcb4416ef0421764a6004bca74de4d` and returned **REVISE** on question
2. PostgreSQL `uuid` equality normalizes case, but the advisory lock hashed raw
UUID text, so upper- and lowercase spellings of one key could enter module DML
under different locks. This was the first finding in the packet's hard-tripwire
class. The one authorized bounded fix lowercased the UUID lock components and
principal comparison, and strengthened the real contention test to send one
uppercase and one lowercase key.

Fresh Codex round 2 reviewed
`7393eeed91bfb5f8e353ec9bd83ce2a065354ead` and returned **PASS**, with no
in-scope material findings. Questions 1–7 all passed. Fable max then independently
reviewed the identical unchanged SHA and returned **PASS** on all seven
questions. Its only observation was non-material: the focused scope evidence
was added to the two existing owned PostgreSQL test files instead of a new
optional file. No finding remained to disposition as future work or dismissal.

## Test it yourself

From the repository root, these commands take under ten minutes:

```bash
cd /home/rvham/2rain-greenfield
git switch packet/pr-5
git merge-base --is-ancestor 7393eeed91bfb5f8e353ec9bd83ce2a065354ead HEAD
node --import tsx --test --test-name-pattern="definition-only module is served" test/postgres/module-runtime.test.ts
node --import tsx --test --test-name-pattern="migration 0010 refuses" test/postgres/trust-substrate.test.ts
corepack pnpm check:schema
```

Expect the ancestry command to exit zero. The first probe reports 1/1 and runs
the real provider journey: cross-principal and different-input retries conflict
without another business row; activation and recompile retries return the
original result; and uppercase/lowercase concurrent retries leave exactly one
module row, one change document, and one receipt. The second reports 1/1 and
proves a conflicting 0009 history makes 0010 fail atomically without removing
either receipt. The schema command reports 10 applied / 10 verified and no
drift.

## Draft ledger row (do not commit to `ledger.md`)

```markdown
| PR-5 | Idempotency scope | G2 corrective | Critical | evidence_ready | `7393eeed91bfb5f8e353ec9bd83ce2a065354ead` | [packet](packets/PR-5.md); durable receipt identity narrowed across PK, lookup, advisory lock, and RLS; principal/digest mismatch returns a typed conflict; activation/recompile replay; real mixed-case concurrency leaves one persisted effect; migration refuses conflicting immutable history; full matrix green at schema 10/10 and PostgreSQL 62/62; fresh Codex xhigh PASS and Fable max PASS on the identical SHA. |
```

## Checkpoint

PR-5 is evidence-ready on reviewed candidate
`7393eeed91bfb5f8e353ec9bd83ce2a065354ead`. The packet has not been merged and
the ledger has not been edited; both await user acceptance and an integrated
SHA.

The program-review trigger check found no new trigger. PR-5 is a bounded
correction inside the already-reviewed G2 trust/idempotency domain, not a stage
boundary, imminent fan-out, first zero-dev-code module, or newly stabilized
correctness domain. The converged G2-P3 whole-app review remains current. Stop
here; do not start PR-6 without explicit user selection.
