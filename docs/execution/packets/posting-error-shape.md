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
  vacuous pass; `shape-guard-refuses-everything` refutes it, and
  `admission-excludes-only-the-twin-sqlstate` shows this control dying alone
  over the whole file when only its own SQLSTATE is withdrawn.
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

`test/evidence/posting-error-shape.expected-red.json`, **six** entries through
`scripts/check-expected-red.sh` (ADR-0058), each measured mutation-first and
restored. **The "population" column is load-bearing and is stated for every
row**, because the runner computes a kill set only over the tests its own
command runs: a `namePattern` narrows that command without narrowing anything
the entry claims.

| entry | mutation (one property) | population run | kills | survivors |
|---|---|---|---|---|
| `shape-guard-removed` | guard deleted (`return code;`) — the exact pre-fix defect | 3 translator tests | A, B | Twin |
| `shape-guard-refuses-everything` | guard walls (`return undefined;`) | 4 (translator + replay) | Twin, Replay (raw `duplicate key value violates unique constraint` surfaces) | A, B |
| `admission-excludes-only-the-twin-sqlstate` | `23503` withdrawn from the admitted set; every other SQLSTATE still admitted | **the whole file, 6 tests** | **Twin alone** | the other 5, including one-way-doors |
| `replay-branch-stops-recognizing-23505` | the catch compares against `'23506'` | 4 (translator + replay) | Replay alone *within that command* | A, B, Twin |
| `shape-guard-length-only` | `/^.{5}$/u` | 3 translator tests | B alone | A, Twin |
| `shape-guard-charset-only` | `/^[0-9A-Z]+$/u` | 3 translator tests | A alone | B, Twin |

**Die-alone attribution, written from the measurement and no further.**

- **A** and **B** each die alone within the three-test translator command
  (`shape-guard-charset-only`, `shape-guard-length-only`), which also proves
  neither half of the predicate is decorative.
- **The Twin dies alone over the file's entire population** — 6 tests run, 1
  killed, 5 green. That run carries a second fact the focused runs cannot:
  the surviving one-way-doors test reaches this same guard with **three
  genuine PostgreSQL errors**, and the two routes are different, so the
  record states them separately:
  - **Base-unit `P0001`** (`assertBaseUnitBound`) — a real trigger error
    from a direct module-role `UPDATE`, which **the test then hands to the
    exported `translateInventoryPostingError` itself**. It proves the guard
    admits a real SQLSTATE arriving from the database; it does **not**
    traverse `PostgresInventoryPostingService.#post`.
  - **Forced-rollback `P0001`** and **held-lock `55P03`** — both raised
    inside `postAdjustment` and translated by the **service's own outer
    catch**, asserted as `INVENTORY_POSTING_STORAGE_REJECTED` with
    `details.sqlstate === 'P0001'` and as `INVENTORY_POSTING_LOCK_TIMEOUT`
    with `details.sqlstate === '55P03'`. These two are the production-path
    admissions.

  *Corrected in round 3: the earlier wording put the base-unit specimen on
  "a real posting path" alongside `55P03`, which overstated its route. The
  arm was right, and the distinction survives because a genuine error
  reaching the translator by an explicit test call proves less about the
  service than one the service catches itself.*
- **The Replay control's singleton is measured within its four-test command
  only.** The round-2 arm separately read the file for another victim of that
  mutation and found none; that is a reviewer's reading, not a run, and it is
  recorded as such rather than promoted to a measurement.

*Both singleton entries came out of review, and the second round of the same
finding is the part worth recording.* The original four entries killed the
Twin and the Replay control **only as a pair**, while the record claimed each
control dies alone. Round 1 caught that. The first repair added a mutation
admitting only `'23505'` — which produced a singleton **only because its
`namePattern` excluded the one-way-doors test**, whose `P0001` and `55P03`
expectations that mutation also breaks. Round 2 caught *that*: the kill set
was exact within the command, and the command had been chosen so the other
victim could not appear. **The fix was to change the mutation, not the
population** — withdrawing admission from the twin's own `23503` alone, then
measuring over the whole file, where the excluded victim would have shown up
had one existed.

**The general lesson, since this class survived one correction:** an entry's
kill set is only as strong as the population it was computed over, so the
population belongs in the claim. A singleton over a hand-picked command is not
a singleton.

The mutation set is self-chosen (`review-tiers`: worth strictly less than an
independent replay), except that **two of its six entries were specified by
review rather than by the lane, and one of those was then re-specified by
review a second time** — recorded because who chose a mutation is part of what
the table is worth, and because the lane's own first attempt at the Twin's
singleton was the weaker one. The manifest is committed, so an independent
replay re-derives every red with `bash scripts/check-expected-red.sh --run`
(all 11 entries across both manifests) or by naming this packet's six.

**A gate limitation this packet works within rather than around, recorded at
the orchestrator's instruction.** `scripts/check-expected-red.sh` computes a
kill set over the command it runs, and an entry's `namePattern` narrows that
command without constraining what the entry claims — so a focused entry's
exactness is exactness *within its own selection*. The orchestrator is filing
this against ADR-0058. This packet's obligation is only that its claims match
what its runs prove, which is why the table above states every entry's
population and why the Twin's entry runs the whole file. **No machinery was
added here to compensate for the gate.**

## What this packet does NOT claim

- No test observes a **production** `ECONNREFUSED` mid-posting (that would
  need a database dying mid-transaction on cue). **The three misdiagnosis
  specimens — `ECONNREFUSED`, `ERR_STREAM_DESTROYED`,
  `PS0_RECEIPT_OPEN_QUANTITY_EXCEEDED` — are constructed `Error` objects, and
  that is the packet's one constructed half.** The genuine-PostgreSQL half is
  larger than an earlier draft of this bullet said, and is now stated in
  full: the Replay control's real `23505`, plus the one-way-doors survivor's
  three genuine errors — a base-unit `P0001` handed to the exported
  translator by the test, and a forced-rollback `P0001` and held-lock
  `55P03` translated by the posting service's own outer catch. *(Corrected in
  round 4; the earlier wording called the Replay `23505` "the
  genuine-PG-error half", which contradicted the corrected route section
  above once the whole-file run was recorded.)*
- **The residue: a SQLSTATE-SHAPED foreign code is still admitted, and this
  packet cannot close that.** The guard tests shape, and shape alone cannot
  separate a five-character `[0-9A-Z]` Node code from a real SQLSTATE,
  because such a code sits **inside the legal SQLSTATE value space**.
  Orchestrator-verified, the guard admits `EPIPE`, `EBUSY`, `EBADF`,
  `EINTR`, `ELOOP`, `ENXIO`, `EPERM`, `EROFS`, `ESRCH`, `ETIME` and `EXDEV`;
  `EPIPE` is the realistic one on a posting connection. (`ECONNREFUSED` is
  refused at 12 characters, and every `ERR_*` code by its underscore.)
  **Tightening the pattern is not the fix** — a narrower pattern would refuse
  legal custom `ERRCODE`s, which are exactly as SQLSTATE-shaped. **Closure is
  provenance-based, not shape-based:** ask whether the error actually came
  from the server — its `severity` property — or whether the driver typed it
  as a `DatabaseError`. That is a different question from the one this guard
  asks, and it belongs to the row that owns it:
  **`posting-error-provenance`, filed on `main` at `c6cce1c`**, which is the
  packet that changes the guard. **Ruled not to block `PUR-2`:** this packet
  removes the misdiagnosis class that was actually observed, and the residue
  is a narrower, unobserved successor.
- **A known imprecision in the production comment, deliberately NOT edited.**
  The comment beside the guard names `ECONNREFUSED` as its example of a
  refused Node code, which is true, while `EPIPE` — also a Node code — is
  admitted, so the comment reads as a stronger claim than the guard makes.
  It is left byte-identical on purpose: Fable's clearance rests on
  `git diff --stat 7b525b3 <tip> -- packages/` returning empty, and editing a
  comment would break that for a wording fix. Routed to
  `posting-error-provenance` with the residue itself.
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

**A record cannot name its own commit**, so this section names only SHAs that
already exist when it is written. The **executable candidate is
`cca8d02f8403d4423d4855bafaab639a915e2bf3`** — the last commit to move
production, a test, or a manifest's executable fields. Every commit above it
is records-only, and the **freeze is the branch tip**, retrievable with
`git ls-remote origin packet/posting-error-shape` and reported in the
checkpoint block.

Round history, every candidate fetchable and tagged:

| round | candidate reviewed | verdict | what it found |
|---|---|---|---|
| 1 | `8c41712` (executable `7b525b3`), tag `…-reviewed-r1` | REVISE | two controls had no singleton red; C1, C2, C4 closed |
| 2 | `7bad8d4` (executable `c36e0c6`), tag `…-reviewed-r2` | REVISE | the admission singleton was produced by a `namePattern`, not by its mutation; Q2 closed |
| 3 | `28be329` (executable `cca8d02`), tag `…-reviewed-r3` | REVISE | the base-unit `P0001` was described as a posting path; Q1 closed |
| 4 | `2f97b9c`, tag `…-reviewed-r4` | REVISE | a stale scope sentence, and a **fabricated SHA** in a review-log row |
| 5 | `b2c23d2`, tag `…-reviewed-r5` — **Fable max confirm** | REVISE | the SQLSTATE-shaped residue (`EPIPE` and kin admitted; shape cannot close it) and the comment's `ECONNREFUSED` example reading stronger than the guard |

**Production has been byte-identical since the first candidate**, through
every round — and it stays that way through this closing correction, which is
docs-only by ruling precisely so the clearance holds:

    $ git diff --stat 7b525b3 cca8d02 -- packages/
    (empty)

Rounds 1 and 2 are rows in the round-history table above; this paragraph used
to restate them and drifted from it, so it is gone. **Every reviewed
candidate is tagged and pushed to `origin`** —
`posting-error-shape-reviewed-r1` through `-r5` — and each tag was verified
to resolve to the SHA its row names.

Gates in the packet worktree `/home/rvham/2rain-greenfield-pes`:

- `typecheck` PASS, `lint` PASS, `format` PASS.
- `check-expected-red.sh` static: OK (11 entries, 2 manifests).
- `evidence:expected-red` over this packet's six entries at `cca8d02`: **all
  six reproduced and restored.** The Twin's entry is the one that moved —
  `EXPECTED_RED_RESTORED admission-excludes-only-the-twin-sqlstate 6 passing`
  then `MUTATION_RED ... 1 killed`, so the gate itself now measures the
  singleton across the file's whole population rather than a selection. The
  other five are unchanged from the round-2 run (`shape-guard-removed` 2
  killed of 3; `shape-guard-refuses-everything` 2 of 4;
  `replay-branch-stops-recognizing-23505` 1 of 4; `shape-guard-length-only`
  1 of 3; `shape-guard-charset-only` 1 of 3). At round 2 a full run over both
  manifests reproduced all 11 reds including the five `scoped-create-operand-impl`
  entries.
- `test:postgres`: **208/208 pass, 0 fail, 0 cancelled** (`suiteSucceeded:
  true` in `test-results/reachability/postgres.json`), measured at `c36e0c6`
  and carried to `cca8d02` because **the suite's inputs are byte-identical** —
  `git diff --name-only c36e0c6 cca8d02 -- test/postgres packages/ test/helpers db/`
  is empty, and the only non-doc change is the manifest JSON, which no suite
  reads. Round 1 measured the same 208/208 at `7b525b3` in 738s. The
  suite counted 204 before this packet; the four new controls account for the
  growth, and the posting file's executed real-result count moved 2 → 6.
  Notably the two pre-existing `INVENTORY_POSTING_STORAGE_REJECTED`
  assertions (both paired with `sqlstate === 'P0001'`) and the `55P03`
  lock-timeout assertion stayed green — the guard reds nothing that existed.
- `test:architecture`: **178/178 pass, 0 fail** re-measured at `cca8d02`,
  exit code 0 captured without pipe masking; identical at all three
  candidates. The
  PRESS006 line-37 pin over this file is unaffected (the edit sits at line
  ~3877 and shifts nothing above it).

Stops: none. **Review rounds: 4, every one REVISE, and not one of them found
a production or control defect** — the guard and the four controls have been
unchanged since round 1 closed C1, C2 and C4. What the rounds found, in order:
a missing singleton red; a singleton manufactured by test selection rather
than by its mutation; one specimen's route described as a posting path when
the test calls the translator itself; and a scope sentence left stale by the
previous correction together with a SHA in a review-log row that resolved to
no object. **The lane wrote that SHA before the commit existed**, which is
recorded here rather than quietly repaired, because a record naming an
unfetchable artifact is the failure the whole `ls-remote` discipline exists to
prevent.
`review-tiers`' convergence questions place the round-1 finding in the
control rather than in production, and the correction is the narrowest one
available — two singleton mutations plus a claim rewritten from the
measurement, with no production byte moved.
- Full matrix: **deliberately not run** — it runs once, after review
  converges, at the SHA that will integrate (`git-workflow`, 2026-08-14
  sequence). Integration is a `--no-ff` merge of the packet into `main`.
