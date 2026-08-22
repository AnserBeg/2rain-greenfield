# posting-error-shape — the posting error classifier refuses non-SQLSTATE codes

Cut from `6eb0751694b10608ac028ed3edb75d81804cc385` (`origin/main`) on branch
`packet/posting-error-shape`. Tier: **Critical** — a one-line change on the
posting write path that moves a pinned error contract, and whose failure mode
is a silently wrong answer. Evidence band: **Band A, declared.** A
misclassification is discovered at incident time by whoever reads a stored or
logged classification and takes it as true — `review-tiers`' silent band —
so full §6 applies: one recorded red per vacuity vector, each varying one
property, plus the admission twin.

Program review R1 finding R8; hard prerequisite of `PUR-2`.

## The defect

`postgresCode` (`inventory-posting-service.ts`) read any string `error.code`
without a shape check, so `translateInventoryPostingError`'s fall-through
relabelled **any** error carrying a string `code` as
`INVENTORY_POSTING_STORAGE_REJECTED` and discarded its cause. ADR-0049 ("A
real defect found on `main`") records the live observation:

    INVENTORY_POSTING_STORAGE_REJECTED: PostgreSQL rejected inventory posting
    (PS0_RECEIPT_OPEN_QUANTITY_EXCEEDED)

Node's `ERR_*` errors have the same shape, so `ECONNREFUSED` mid-posting read
as a storage rejection. G4 posts through this engine; every future incident
would begin from a wrong diagnosis.

## The fix, and its salvage disposition

**RE-EXPRESS**, from the PS-0 probe. Source: branch `packet/ps-0` at
`9b59e094e0ac67893fe4205b60f63a4878e0eb6f`, `postgresCode` in
`packages/postgres-provider/src/inventory-posting-service.ts`, where the guard
is marked `PS-0 PROBE ONLY — NOT FOR MERGE`. The guard expression is taken
as the specification and re-expressed against current `main`:

    return code !== undefined && /^[0-9A-Z]{5}$/u.test(code) ? code : undefined;

- **Carried:** the admission predicate — exactly five characters from
  `[0-9A-Z]`, the SQLSTATE alphabet.
- **Not carried:** the `PS-0 PROBE ONLY — NOT FOR MERGE` marker and its
  probe-context comment; replaced by a production comment stating the
  constraint. Nothing else in the probe branch was consulted or taken; the
  branches (`ps-0`/`ps-1`/`ps-2`) stay parked and are not rebased or revived.
- **Why RE-EXPRESS rather than PORT:** the source is a preserved probe branch
  of this repository, not the prior repository, and what crosses is a
  one-line predicate used as a specification with all evidence rebuilt fresh
  here. A PORT admission record in `docs/decisions/salvage/` is the
  prior-repo instrument; the provenance that record would carry is this
  section.

The guard admits all 20 distinct SQLSTATEs asserted across `test/postgres/**`
and `packages/postgres-provider/src/**` (including `23505`, `55P03`, `P0001`,
`40P01`, `25P01`, `57P03`) and refuses all three observed misdiagnosis shapes
(`ECONNREFUSED`, `ERR_STREAM_DESTROYED`, `PS0_RECEIPT_OPEN_QUANTITY_EXCEEDED`).

## Consumers, enumerated

`postgresCode` has exactly two consumers, both in
`inventory-posting-service.ts`:

1. **`translateInventoryPostingError`** — the P0001 base-unit branch, the
   55P03 lock branch, and the `if (code)` fall-through. `'P0001'` and
   `'55P03'` both match the guard, so those branches are unchanged for real
   SQLSTATEs; the fall-through now routes non-SQLSTATE codes to the existing
   `return error` path — a path the translator already takes today for
   errors with no string `code`, so callers see no shape they have never
   seen.
2. **The `23505` replay branch** (`#post`'s savepoint catch):
   `postgresCode(error) !== '23505'`. Exhaustive case analysis over the
   guard's output domain: a string `'23505'` maps to `'23505'` under both
   old and new code (it matches the guard); every other string mapped to
   inequality before (`s !== '23505'`) and maps to inequality after
   (either `s` or `undefined`); a non-string was `undefined` before and
   after. The branch's behaviour is therefore **unchanged for every
   possible input** — stated here as the packet requires, not left implied.
   The empty string is the one value whose `postgresCode` result changes
   (`''` → `undefined`) while every consumer's behaviour is unchanged:
   `if (code)` treated `''` as falsy already, the equality branches compare
   against non-empty literals, and the P0001/55P03 equalities fail for both.

The provider-mapping bridge
(`inventory-provider-error-mappings.ts`) calls the translator with
`code: input.metadata.sqlstate` and its single mapping declares
`sqlstate: 'P0001'` — a real SQLSTATE the guard admits, so the mapping's
behaviour is unchanged and the pre-authorized bridge was **not needed**.
The two test files carrying their own local `postgresCode` helpers
(`test/postgres/inventory-posting.test.ts:4476`,
`test/postgres/stock-serializer.test.ts:1177`) are separate functions this
change does not touch.

## A structural finding: what can actually reach the 23505 catch

The charter names the vector "the `23505` replay branch reached with a genuine
duplicate-key error." Constructing it produced a structural finding worth
recording:

- The natural-effect claim is the **companion table's primary key** on
  `(tenant, environment, legal entity, source_type, source_id, source_line,
  source_revision, posting_role)`, inserted by the fact-reservation trigger
  during `insertMovement`.
- `findNaturalReplay`'s pre-read (before the insert) filters on **exactly the
  same tuple**. Any committed row that would conflict on the claim is
  therefore visible to the pre-read, which resolves it first.
- Same-content concurrent postings serialize on the **stock-identity advisory
  locks taken before the pre-read** (same item×location ⇒ same lock), so the
  loser's pre-read runs after the winner's commit and sequential/racing
  service calls can never reach the catch with matching content.
- The catch is therefore a defense for claims landing **between the pre-read
  and the insert** — an out-of-band writer, exactly what the control
  constructs.
- Inside the catch, the `racedReplay !== null` arm (replay resolved) demands
  the found movements carry an **accepted posting receipt** joined through the
  trust outbox. A claim that bypassed the service carries none, and a claim
  that went through the service is serialized ahead of the pre-read. **The
  deterministically reachable genuine-23505 outcome of the branch is its
  typed refusal** `INVENTORY_POSTING_IDEMPOTENCY_CONFLICT: existing natural
  effects have no accepted posting receipt`, and that is what the control
  pins. The `racedReplay !== null` arm and the
  `a natural effect identity was claimed by a different posting` refusal
  remain belt-and-braces arms this packet found no reachable construction
  for; they are exercised by no test before or after this packet. This is a
  test-constructibility observation, not a behaviour change — the guard
  alters no caller's control flow.

## Controls

Four committed tests in `test/postgres/inventory-posting.test.ts`, three pure
and one against a real database:

- **A — non-SQLSTATE passthrough** (`posting error translation: a
  non-SQLSTATE code keeps its own error identity`): each of the three
  observed misdiagnosis shapes, built by one helper varying only the `code`
  string, must come back by identity from the translator. `ECONNREFUSED` is
  entirely uppercase, so relative to the admitted twin it varies **length
  only**.
- **B — five-character charset refusal** (`…a five-character non-SQLSTATE
  code…`): `'2350x'` varies exactly one property from the admitted `'23503'`
  — the final character leaves `[0-9A-Z]` while length stays five.
- **Twin — admission** (`…a SQLSTATE-shaped code is relabelled as a storage
  rejection`): `'23503'` must still produce the full
  `INVENTORY_POSTING_STORAGE_REJECTED` contract (code, exact message,
  `details.sqlstate`). A guard that refuses everything is the cheapest
  vacuous pass; this is its refutation.
- **Replay — genuine duplicate key** (`posting error replay: a genuine
  duplicate-key error reaches the 23505 replay branch`): holds an
  uncommitted natural-effect claim on a module-role transaction, starts a
  real posting of the same command, **observes the posting block on the
  claimant's transaction id via `pg_locks`** (attempt-bounded observation,
  no timing measurement), then commits. The posting's companion insert
  raises a real PostgreSQL 23505, and the catch must produce the typed
  no-receipt refusal rather than the raw storage error. Path attribution:
  the observed block is only possible after the pre-read passed (it cannot
  see an uncommitted claim) and at the insert (the only statement that waits
  on the claimant), so a green run proves the catch path; the pre-read path
  cannot produce one.

## Expected-red manifest — the recorded reds

`test/evidence/posting-error-shape.expected-red.json`, four entries through
`scripts/check-expected-red.sh` (ADR-0058), each measured mutation-first and
restored, kill sets exact. Observed on this tree (2026-08-22):

| entry | mutation (one property) | kills | restored |
|---|---|---|---|
| `shape-guard-removed` | guard deleted (`return code;`) — the exact pre-fix defect | A, B | 3 passing |
| `shape-guard-refuses-everything` | guard walls (`return undefined;`) | Twin, Replay (raw `duplicate key value violates unique constraint` surfaces) | 4 passing |
| `shape-guard-length-only` | `/^.{5}$/u` | B alone | 3 passing |
| `shape-guard-charset-only` | `/^[0-9A-Z]+$/u` | A alone | 3 passing |

Per-check attribution: entries 3 and 4 delete one half of the predicate each
and exactly one control dies, so neither half is decorative and each control
dies alone. Entry 1's run keeps the twin green (a survivor demonstrating the
mutation is discriminating); entry 2's run keeps A and B green. The kill of
Replay in entry 2 is the charter's fourth vector: a genuine duplicate-key
error, produced by a real constraint in a real database, mis-read by a walled
guard, surfacing raw — the exact failure the exact-equality argument says
cannot happen while `'23505'` is admitted.

The mutation set is self-chosen (`review-tiers`: worth strictly less than an
independent replay); the manifest is committed, so an independent replay can
re-derive every red with `bash scripts/check-expected-red.sh --run
shape-guard-removed shape-guard-refuses-everything shape-guard-length-only
shape-guard-charset-only`.

## What this packet does NOT claim

- No test observes a **production** `ECONNREFUSED` mid-posting (that would
  need a database dying mid-transaction on cue); the misdiagnosis shapes are
  constructed errors. The genuine-PG-error half of the evidence is the
  Replay control's real 23505.
- The `racedReplay !== null` (replay-resolved) arm of the catch and the
  `claimed by a different posting` refusal are **not exercised** by any test,
  before or after this packet — see the structural finding.
- The full `test:postgres` suite green at the fix proves no observed
  behaviour change **where the suite reaches**; the exhaustive-case argument
  for the replay branch is analysis, not observation, and is stated as such.
- `module-runtime-interpreter.ts`'s `providerErrorProperty` is the same sniff
  shape with no `if (code)` fall-through; its diagnostics gap stays with
  queue row `5g3-berr` (ADR-0011 bans module-specific glue there). Out of
  scope here.

## Gates and SHAs

Executable candidate: `7b525b38a504592b37c6378cb5b59ce99bc82013` (fix +
controls + manifest, one commit). Measured at that SHA in the packet worktree
`/home/rvham/2rain-greenfield-pes`:

- `typecheck` PASS, `lint` PASS, `format` PASS.
- `check-expected-red.sh` static: OK (9 entries, 2 manifests).
- `evidence:expected-red` (four packet entries): all four reds reproduced
  and restored — table above.
- `test:postgres`: **208/208 pass, 0 fail, 0 cancelled** (`suiteSucceeded:
  true` in `test-results/reachability/postgres.json`; duration 738s). The
  suite counted 204 before this packet; the four new controls account for the
  growth, and the posting file's executed real-result count moved 2 → 6.
  Notably the two pre-existing `INVENTORY_POSTING_STORAGE_REJECTED`
  assertions (both paired with `sqlstate === 'P0001'`) and the `55P03`
  lock-timeout assertion stayed green — the guard reds nothing that existed.
- `test:architecture`: **178/178 pass, 0 fail**, exit code 0 captured
  without pipe masking. The PRESS006 line-37 pin over this file is
  unaffected (the edit sits at line ~3877 and shifts nothing above it).
- Full matrix: **deliberately not run** — it runs once, after review
  converges, at the SHA that will integrate (`git-workflow`, 2026-08-14
  sequence). Integration is a `--no-ff` merge of the packet into `main`.

Stops: none.
