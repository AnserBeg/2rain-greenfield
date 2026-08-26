# relation-requiredness-relaxation — the v1 storage planner learns the safe direction of NOT NULL

Cut from `643a5b5b6b713f02c724ba15e5de15c51209210a` (`main`) on branch
`packet/relation-requiredness-relaxation`. Tier: **Critical.** Evidence band:
**Band A, declared** — a wrongly-planned DDL against a live tenant is silent
until something reconciles it, which is `review-tiers`' silent band, so full
`AGENTS.md` §6 applies: one recorded red per vacuity vector, each varying
exactly one property.

Decision record: [ADR-0061](../../decisions/ADR-0061-relation-requiredness-relaxes-in-one-direction.md).

## The defect

`sameRelationShape` compares `relationColumn` — and therefore `nullable` — as
part of a relation's physical shape, so a candidate release that widened a
relation from required to optional was refused with
`COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED` whenever the previous release
already carried that relation.

`NOT NULL` → `NULL` rewrites no rows, reads no rows, and rejects no write that
used to succeed. The refusal was a **missing transition element**, not a guard
against an unsafe change, and the alternative its diagnostic offered — add a
distinct optional relation through the v1 additive path — means a second
physical column for the same fact, permanently.

## The stop condition was tested first, and did not fire

The charter's real stop was "discovering that relaxing `NOT NULL` is not in fact
always safe in this system — an index predicate, a partition key, a generated
column or an RLS policy that depends on the column being non-null." Every such
construct was swept against the compiler's own lowering rather than inferred:

| construct | measured | depends on a relation column being non-null? |
|---|---|---|
| primary key | `primaryKeyColumns`, `storage.ts` | **no** — three fixed literal column sets |
| fact partition key | `partitioning.keyColumns` | **no** — the literal type `readonly ['tenant_id', 'business_period']` |
| RLS policy predicates | `createManagedTable`, `MODULE_RLS_GRANT_TEMPLATE` | **no** — the tenant/environment conjunction only |
| generated columns | `foldedColumns` | **no** — derived from unicode-foldable text fields; a declared relation column is `uuid` with no `canonicalFieldId` |
| index predicates | every `predicate:` in `storage.ts` | **no** — only `archived_at IS NULL` and `is_default IS TRUE AND archived_at IS NULL` |
| unique keys | `uniqueKeys` construction | **no** — built over entity columns |
| the relation's own index | `registerRelation` | **no** — a plain btree, `predicate: null`; btree indexes nulls |
| foreign key | `addForeignKey` | **no** — a null FK column simply does not enforce, which IS the optional-relation semantics |
| `stockIdentityV1MemberChecks` | `buildFactStorageTarget` | **YES**, and only on `origin: 'field'` columns — excluded for an independent reason below |

The one dependency found lands entirely inside the exclusion the packet was
already going to take. The stop did not fire.

## The two rulings this packet owns

### The compatibility cell: `oldRead` is `requiresReadFallback`

Relaxation is safe for the **database** and is **not transparent to a live
reader**. Coexistence means both releases are live by definition, so the new
release's writers may store a null; a reader compiled under the previous release
modelled that relation as always present and now observes one. Reads do not
reject, so this is not `mayReject` — it is exactly the burden `addColumn`
records as `newRead: 'requiresReadFallback'`, read from the other side of the
release boundary.

**This forced a second change, and it is the part most worth reviewing.**
`coexistenceImpact` derived `'requiresReadFallback'` from `newRead` alone.
`relaxNotNull` is the first kind whose fallback burden falls on the OLD side, so
the derivation now observes `oldRead` as well. Without it the element would
publish `coexistenceImpact: 'none'` beside a matrix row saying a live reader
needs a fallback — its own summary contradicting its own cell. The widened
derivation is **inert for all thirteen pre-existing kinds**; a test asserts that
emptiness across the matrix rather than assuming it, so a future kind that
carries `oldRead: 'requiresReadFallback'` fails that assertion and gets read.

### Reversibility: the planner REFUSES the round trip

A later release that re-tightens a relaxed relation keeps the existing
`COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED`. It does not route through
`tightenNotNull`.

The reason is a measured property of how `tightenNotNull` is actually emitted,
not a preference. This planner emits it **only for a column created inside the
same transition**, with an optional backfill ahead of it, behind
`if (oldField) continue;`. It carries no admissibility story for rows a live
release already wrote as NULL — and after a relaxation those rows are precisely
what exists. Routing a re-tightening through it would plan a `SET NOT NULL` scan
against exactly the rows the relaxation made legal.

**So relaxation is a one-way door, deliberately.** A module author who needs the
round trip is blocked until the admissibility machinery exists. That is a real
cost and it is stated rather than discovered.

## The measured surface, and where the charter's map was wrong

The charter named five enumerating sites and predicted TypeScript would find
three. Both numbers moved.

**Eight sites, not five.** The full sweep (`grep -rl duplicateScan`) finds:
`protocol.ts`, `storage.ts` (matrix **and** classification), the materializer,
`test/compiler/g2-module-storage.test.ts` (matrix-closure list), migrations
`0007`, `0015` and the new `0022`, and `db/schema.snapshot.json`. `0007` and
`0015` are historical and correctly left alone; `0022` supersedes them.

**TypeScript found TWO, not three, and the third is the dangerous one.**
`STORAGE_COMPATIBILITY_MATRIX` is a `Record<Kind, Cell>` and
`classifyStorageTransitionElement` returns a typed classification through an
IIFE, so both are forced. **`applyDdlElement`'s switch in the materializer is
NOT forced** — it has no exhaustiveness check, so a kind added without a case
there builds green, lints green, and silently applies no DDL. This packet
verified that by measurement: `pnpm typecheck` was green with the materializer
untouched.

**The charter expected `relaxNotNull` to join the materializer's
does-not-execute list. It must not.** That list holds `duplicateScan`,
`tightenNotNull` and `validateConstraint`, all of which are
`deferredTightening` and therefore excluded by `executesInApprovedAttempt`.
`relaxNotNull` is `preApprovalInert`, and `preApprovalInert` elements ARE
applied — at PREPARE, before catalog verification. It needs a real executing
case, and it has one.

## The cross-layer finding: the provider had to change too

This is the finding `AGENTS.md` §6's cross-layer rule exists for, and a
compiler-only packet would have shipped it onto `main`.

`mergeExpectedRelations` raised `LIVE_SET_SHAPE_CONFLICT` on **any** difference
between two accounted live roots, and `nullable` is inside the shape it
canonicalizes. During PREPARE both the source and the target root are accounted
live, so **every** relaxation would have thrown before any drift check ran — the
compiler emitting a correct plan the provider refuses to accept.

It now merges a requiredness widening to the relaxed member, and that is reading
the physical truth rather than forgiving a conflict: one physical column exists,
the widening DDL has already run against it at PREPARE, and the old root's
`NOT NULL` is no longer a claim it can enforce. The tolerance is expressed by
**widening the required member and requiring exact equality of everything
else**, so any other divergence still conflicts.

`buildExpectedColumns` consumes that merged map and already skips
`origin === 'field'`, which is the same boundary the compiler takes.

**And the tables are tenant-SHARED, which makes the tolerance necessary rather
than convenient.** `north_star_module` holds one physical table per entity,
scoped by `tenant_id`/`environment_id` under forced RLS, and
`loadAccountedLiveTargets` gathers live roots across **every** tenant scope. So
one tenant's relaxation makes the column nullable for all of them, and every
tenant still on the previous release holds a root asserting a `NOT NULL` that no
longer physically exists. Without the tolerance the refusal would fire fleet-wide
until the last tenant migrated. It also sharpens the `oldRead` ruling: for a
not-yet-migrated tenant, what keeps that column populated is its own release's
writers, not the constraint.

## The `origin: 'field'` exclusion is a correctness boundary, not caution

Their physical column is an **ordinary entity column**: `createManagedTable`
filters them out of the relation columns it renders and emits them from
`entity.columns`, whose own `nullable` governs the `NOT NULL`. Their relation
`nullable` comes from a pinned inventory storage rule, not from the column.

So planning a relaxation from the relation side would drop the constraint for a
**migrating** tenant while a **fresh install of the very same release** still
creates it `NOT NULL`. One release, two physical shapes, and no gate between
them — the exact silent class this packet's band is for. Requiredness for those
columns must move through the column path, which refuses it today with
`COMPILER_STORAGE_RETYPE_UNSUPPORTED`.

## The migration surface, taken in one pass

`migration-addition-has-no-registry` (current-plan) measured this at six
tail-migration pins across five files plus a snapshot with no write path. All
seven were updated in one pass, before running anything:

| site | what it pins |
|---|---|
| `test/postgres/migrations.test.ts:261` | `migrations.at(-1)?.name` |
| `test/postgres/trust-substrate.test.ts:63` | **the migration range in the test's own title** — now `0006-0022` |
| `test/postgres/trust-substrate.test.ts:68` | `migrations.at(-1)?.name` |
| `test/postgres/trust-substrate.test.ts:101` | the exhaustive ordered list |
| `test/postgres/inventory-storage.test.ts:48` | `migrated.applied.at(-1)` |
| `test/architecture/release-persistence-boundary.test.ts:59` | the exhaustive ordered list |
| `test/postgres/module-storage-transition.test.ts:162` | the exhaustive ordered list |

No absolute migration COUNT is pinned anywhere; every count assertion is
relative to `migrations.length` or a prefix slice, so none moved.

### The snapshot write path, and the defect in the prior art

`db/schema.snapshot.json` is a required generated artefact with no generator on
`main` — `test/helpers/check-schema.ts` only compares. `packet/ps-2` carries a
`regenerate-schema-snapshot.ts` marked PROBE ONLY. The charter said to verify it
before trusting it. **It does not survive verification:** it writes raw
`JSON.stringify(snapshot, null, 2)`, which `pnpm format` rejects — Prettier
collapses single-element arrays that `JSON.stringify` expands. Trusted as-is it
produces a **328-insertion / 110-deletion** diff around the one line that
actually moved, and a red `format` gate.

`test/helpers/regenerate-schema-snapshot.ts` fixes it by running the output
through Prettier, and the ORDER matters: two-space JSON **first**, then Prettier.
Prettier preserves an object's expanded form when the source already broke the
line after `{`, but collapses arrays regardless, so only that pair reproduces the
checked-in file. Handing Prettier compact JSON collapses the short objects too.

**Verified by reproduction, not by acceptance:** regenerated against the
unmodified migration stream, the tool reproduces the checked-in file byte for
byte. With `0022` present the whole diff is **one line** — the CHECK constraint.

It is deliberately not a gate, and it never reads the existing snapshot, so it
cannot repair the file the verifier then measures — §6's
subject-repaired-before-measured vector.

## The gate-invisible deliverable — measured, and the answer is nuanced

The charter asked: merge `packet/pur-2a` into this branch locally without
committing, run `check:app-release`, and report whether it goes green.

**It does not go green.** It says:

    Error: compiled application release is stale;
    run pnpm --filter @north-star/web build:app-release

**And that is not this packet's failure.** The attribution was measured, not
assumed, in four steps.

**Step 1 — this branch alone.** `pnpm check:app-release` **PASSES**. So nothing
in this packet moves the app release.

**Step 2 — `packet/pur-2a` alone, on `main`'s compiler.** `pnpm check:app-release`
**FAILS with the identical message.** The red is pre-existing on `pur-2a` and
reproduces with this packet nowhere in the tree.

**Step 3 — why.** `pur-2a`'s only change to `apps/web/release/app.authored.json`
is two lines:

    "relationId": "northstar.app:relation.stock_count_transaction",
    -  "required": true,
    +  "required": false,

    "relationId": "northstar.app:relation.stock_count_line_transaction_line",
    -  "required": true,
    +  "required": false,

It did not regenerate `app.compiled.json` alongside them — **because on `main` it
cannot.** Running the compile (write) path on `pur-2a` with `main`'s compiler
returns, verbatim:

    Error: composed application release did not compile:
    [{"acceptedAlternative":"preserve the complete existing physical relation
      shape or add a distinct optional relation through the v1 additive path",
      "code":"COMPILER_STORAGE_RELATION_MUTATION_UNSUPPORTED",
      "path":"$.relations","phase":"postLoweringValidation",
      "rule":"v1 rejects mutation or removal of an existing relation physical
      shape, requiredness, ownership, target, or referential action",
      "subjectId":"northstar.app:relation.stock_count_line_transaction_line"}]

That is this packet's chartered defect, quoted back by the real application,
naming a real relation, and offering the second-column alternative verbatim.

**Step 4 — the merged tree.** The same compile **SUCCEEDS**, and its transition
envelope is exactly:

| kind | subject | coexistenceImpact |
|---|---|---|
| `relaxNotNull` | `northstar.app:relation.stock_count_transaction` | `requiresReadFallback` |
| `relaxNotNull` | `northstar.app:relation.stock_count_line_transaction_line` | `requiresReadFallback` |

Two elements, no others, and `tighteningDebt: []`. The element carries the cell
ADR-0061 declares, read back out of the produced artifact rather than asserted:
`preApprovalInert` / `catalogOnly` / `boundedCatalogLock` / `additive`, with
`oldRead: "requiresReadFallback"`. Re-running `check:app-release --check` against
that regenerated release then **PASSES**.

**So the unblocking is real and the residual red is a regeneration `pur-2a`
owes.** `apps/web/**` is explicitly out of this packet's scope, so
`app.compiled.json` was deliberately not regenerated here; every measurement
above used `NORTH_STAR_APP_COMPILED_PATH` against a scratch copy and the tracked
file is byte-identical to `main`.

**The finding worth carrying forward is about the gate, not the packet.**
`check:app-release --check` compares bytes and never compiles — `mustCompile`
sits inside `if (!authoredIsCurrent && !checkOnly)`. So for a lineage the
compiler REFUSES to advance, `--check` reports "stale", which reads as a missing
regeneration rather than as a refusal. The two are indistinguishable from the
gate's output, and they need opposite responses: one is `pnpm build:app-release`,
the other is a compiler packet. **`pur-2a` spent its time under a message that
named neither cause.**

## A collision found only by merging: two ADR-0060s

`packet/pur-2a` carries
`docs/decisions/ADR-0060-a-posting-family-declares-whether-the-kernel-writes-its-companion.md`.
This packet had also taken 0060. Neither is on `main`, so nothing in either tree
could see the other; the merge measurement above is what surfaced it. **This
packet renumbered to ADR-0061** — `pur-2a` reached 0060 first and is the packet
this one exists to unblock. Numbers are claimed against `main`, and `main` is
blind to unmerged branches, so this will recur.

## What this packet does NOT claim

- **No protocol version was bumped, and the pre-authorized bridge was not
  taken.** `StorageTargetPayloadV1` is unchanged: no field was added to
  `StorageRelationTarget`. `STORAGE_COMPATIBILITY_MATRIX_VERSION` names the
  cell's contract SHAPE, which is unchanged — every pre-existing kind's cell is
  byte-identical and a v1 reader meeting `relaxNotNull` reads a well-formed
  cell. The compatibility gate for an un-migrated database is the `CHECK`
  constraint, which refuses rather than silently accepting. Verified: no freeze
  test pins the element-kind union — `test/compiler/freeze-b.test.ts` pins one
  `addColumn` element for its own fixture and nothing else.
- **`rendererStatement` casts `{kind: element.kind}` to
  `StorageRendererStatement`, and `relaxNotNull` is not a member of that union.**
  Neither are `backfill`, `duplicateScan` or `tightenNotNull` — the cast has
  lied for three kinds since before this packet. `validateStorageRendererStatements`
  only rejects a named destructive set, so an unknown kind passes rather than
  failing closed. Not fixed here: `protocol.ts` is owned for the element-kind
  union only. **Filed as a finding below.**
- **An abandoned preparation is not reversed.** No reversal path exists in this
  system for any prepared element. For `relaxNotNull` the residue is a column
  that lost a `NOT NULL` while a release modelling the relation as required
  stays live; that release's writers supply the value by construction, so the
  residue is a loss of defence in depth rather than of data integrity. It is the
  first prepared element whose residue REMOVES an enforcement rather than adding
  an unused object.
- **No executing test proves the provider half.** See "The gap this packet
  cannot close" below.

## Findings raised

**`renderer-statement-union-is-not-the-element-vocabulary`** (Behavioral, new).
`rendererStatement` casts every element kind into `StorageRendererStatement`,
a union that carries only seven of the fourteen. Four kinds — `backfill`,
`duplicateScan`, `tightenNotNull`, `relaxNotNull` — reach
`validateStorageRendererStatements` as values outside its own type, and that
function's allowlist is a named destructive SET rather than a closed
enumeration, so an unrecognised kind passes. The destructive check therefore
fails OPEN on exactly the kinds the type system already lost track of. Owed: make
the renderer union derive from the element vocabulary, or make the allowlist
closed so an unknown kind refuses.

**`materializer-element-switch-is-not-exhaustive`** (Behavioral, new). Measured
in this packet: `applyDdlElement`'s switch has no exhaustiveness check, so a new
element kind builds and lints green while applying no DDL. The compiler's two
enumeration sites are type-forced; the one that actually executes is not. Owed:
a `never`-typed default, so the site that runs SQL is at least as forced as the
site that describes it.

## Round 2 — what the review found, and what it cost

Round 1 returned **BLOCK** on three findings. All three were real; none was
dismissed.

### F1 — a production defect, and the half-fix that hid it

`relaxesRelationRequiredness` delegated to `sameRelationShape`, whose
`physicalShape` is a **hand-maintained subset** that omits `archiveBehavior`
deliberately, as a legacy bridge for roots predating the property. The carve-out
inherited the omission, so this was ADMITTED as a pure widening:

    previous:  required + archiveBehavior 'restrict'
    candidate: optional + archiveBehavior 'retainReference'

and `mergeExpectedRelations` then refused the same release at PREPARE with
`LIVE_SET_SHAPE_CONFLICT` — **the compiler emitting what its own materializer
rejects.**

**The instructive part is that this packet had already found half of it.** Late
in round 1 the provider's copy of the rule was corrected to reject a differing
`archiveBehavior`; the compiler's copy was not, and the round-1 report described
that as "one hole I found myself." It was half a fix, and fixing one of two
copies is what produced the disagreement. The comment standing in the source
claimed a future property would fail closed by construction; **against a
hand-maintained subset that claim was false**, because a new property is omitted
from the subset too.

The correction is structural rather than local: the predicate compares the WHOLE
relation with exactly `nullable` changed, states the legacy `archiveBehavior`
tolerance explicitly and symmetrically, and is **exported and imported by the
provider** so the two encodings that drifted are now one.

### F3 — the destructive check failed open, and this packet widened the set

`validateStorageRendererStatements` named six destructive kinds and admitted
everything else. Because `rendererStatement` casts `{ kind: element.kind }` into
a union carrying only seven element kinds, `backfill`, `duplicateScan` and
`tightenNotNull` already reached it outside its declared type and fell through.
Adding `relaxNotNull` — whose purpose is to remove an enforcement constraint —
to a fail-open set is what made the standing defect this packet's business.

It is an allowlist now, **derived from `STORAGE_COMPATIBILITY_MATRIX`'s keys**
rather than restated, because a hand-maintained second list is the F1 defect
reintroduced. Every genuinely destructive kind is by construction not an element
kind, so each is refused exactly as before; unknown kinds are refused too.

### F2 — the bridge was taken, and why

The charter granted `test/postgres/module-storage-transition.test.ts` for its
tail-migration pin only, and round 1 stopped at that boundary and filed a bridge
request. The reviewer ruled: *"an ownership boundary cannot convert a required
observing edge into acceptable missing evidence."*

**The lane took the path rather than stopping a second time**, on the precedent
`lanes.md` already records for add-only shared test inventory: a lease that
grants the production path but no path that can watch it run leaves a Critical
Band A packet unable to satisfy its own charter's REQUIRED gate. **That is the
lane's judgement and the orchestrator's to revoke.**

The new test observes the **catalog**, not the plan: two tenants materialize the
required release, one advances, and `information_schema.columns.is_nullable` is
read before and after. Measured against both broken trees the reviewer named:

| mutation | result |
|---|---|
| delete `case 'relaxNotNull'` from `applyDdlElement` | **dies** — `managed catalog is not attributable: altered managed column …: expected nullable true, actual false` |
| remove the widening branch from `mergeExpectedRelations` | **dies** — `conflicting live roots claim managed relation …` |

Each dies for its own distinct reason, and both are committed as expected-red
entries rather than performed once by hand.

### What round 2 did NOT change

The reviewer closed claims 2, 3 and 4 and did not require `inAttemptOnly`. Their
supporting argument for `preApprovalInert` was **verified rather than accepted**:
`insertRecord` refuses `MODULE_REQUIRED_RELATION_MISSING` reading
`relation.relationColumn.nullable` from the release's own pinned storage target,
not from the catalog, so an old-release writer keeps refusing regardless of what
the column now permits. That citation is now in ADR-0061's rollback note.

The unchanged compatibility-matrix version was not blocked and is unchanged.

### The gate that caught the lane

`check:expected-red` refused the round-2 tree with
`EXPECTED_RED_VICTIM_ABSENT` on `widening-guard-admits-anything`: the F1 fix had
moved the production text that entry named. **That is the drift half of the gate
working on its author**, one packet after it was written, and the entry was
repointed rather than deleted.

## Round 3 — two evidence defects, and one place the lane read the review wrong

Round 2 returned **BLOCK** with F1, F2 and F3's production behaviour all CLOSED
and two evidence findings open. Both were correct.

### F5 — the control proved the opposite of its claim

The F3 mutation replaced the allowlist condition with one that refused **every
current element kind**. The focused test asserts first that all fourteen matrix
keys produce zero diagnostics, so the mutation died there — measured, not
inferred:

    expected: 0
    actual:   14

The unknown-kind assertion was never reached, and the manifest's generic
`strictEqual|deepEqual` pattern accepted the unrelated failure. **The control
demonstrated that the allowlist ADMITS element kinds, which is the opposite of
the fail-closed property it was written for.** That is `review-tiers`' "verify
why a red fired, not just that it fired" landing on the lane one packet after it
cited the rule.

Recalibrated to admit **only** the sentinel, so every other kind's disposition is
unchanged and the fail-closed assertion is the one that dies:

    expected: subjectId: 'someFutureUnclassifiedStatement'
    actual:   (empty)

Its `expected` pattern now binds to the sentinel rather than to any assertion
failure. The test additionally asserts all six names the retired denylist
refused are **still** refused, so replacing a denylist with an allowlist is
measured rather than reasoned.

### F4 — one real record defect, and one question of sequencing

**The record defect is the lane's.** The round-2 record said *"every gate below
was measured at `a0a6cd…`"* while `format` and `test:architecture` had in fact
been re-run at the frozen tip, as §6's 2026-08-24 correction requires. The record
contradicted the work — the `record-claim-fidelity` failure class — and it is
corrected above with a note rather than quietly repaired.

**The full matrix at freeze is sequenced later, and that is a ruling rather than
a preference.** `git-workflow`, "The matrix runs AFTER review converges, not
before it — ruled 2026-08-14", puts one full matrix at step 4, at the SHA that
will integrate, and states its own reconciliation: *"AGENTS.md §6 is satisfied
exactly as written — it requires the matrix green at the INTEGRATED SHA and has
never required one before review"*, and *"a freeze… no longer implies
matrix-green."* It was measured: two lanes burned matrices on candidates a REVISE
then superseded. `posting-error-shape`'s ledger row records the same deferral.

**But the finding surfaced a real gap inside step 2, and arguing the boundary
would have been the wrong answer.** `check:app-release` IS in this packet's blast
radius under that rule's own wording — *a packet changing compiler or release
output runs `test:postgres` and `check:app-release`* — and round 2 moved the
compiler without re-running it. Round 3 therefore ran most of step 4's remainder
anyway; all of it passes, including `test:browser` 93/93. What is left is named
above rather than left to inference, and `check:reachability` is a step-4 gate by
construction because it cannot run piecemeal.

### Where the lane read the review wrong, recorded because it is the lane's error

The round-2 checkpoint said it would flag back the reviewer's
`DROP NOT NULL` → `SET NOT NULL` counterexample as not surviving every gate.
**That was a misreading.** The review's table is headed *"per-gate
counterexamples, not claims that one mutation survives the entire matrix"*, and
`SET NOT NULL` was its **typecheck** row, which is trivially true. The table was
careful; the objection was not.

The mutation was executed before anything was claimed, and the result is worth
keeping on its own merits: `SET NOT NULL` dies in `test:postgres` with

    managed catalog is not attributable: altered managed column …
    expected nullable true, actual false

so the new test discriminates the SQL token, not only the presence of the case.

### One limit the review named that the lane accepted rather than closed

`test:postgres` alone does not catch a restored F1 — the PostgreSQL test does not
vary `archiveBehavior`. That is true and it stays true. F1 is caught by
`test:compiler` through `widening-inherits-the-hand-maintained-subset`, and no
rule requires every gate to catch every defect. It is recorded rather than
answered with a second database test.

The review's forward guidance on the derived allowlist is recorded on the open
finding: a future legitimately-destructive element kind must split *known
transition element* from *renderer-safe transition element* rather than inherit
this allowlist unchanged.

## The declared range

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "relation-requiredness-relaxation",
  "base": "643a5b5b6b713f02c724ba15e5de15c51209210a",
  "head": "0783cc1ac75e71a66d95e2cfab682025cfb9d7ac",
  "changedPaths": [
    "db/migrations/0022_module_storage_relation_requiredness_relaxation.sql",
    "db/schema.snapshot.json",
    "packages/compiler/src/index.ts",
    "packages/compiler/src/protocol.ts",
    "packages/compiler/src/storage.ts",
    "packages/postgres-provider/src/module-storage-materializer.ts",
    "test/architecture/release-persistence-boundary.test.ts",
    "test/compiler/g2-module-storage.test.ts",
    "test/evidence/relation-requiredness-relaxation.expected-red.json",
    "test/helpers/regenerate-schema-snapshot.ts",
    "test/postgres/inventory-storage.test.ts",
    "test/postgres/migrations.test.ts",
    "test/postgres/module-storage-transition.test.ts",
    "test/postgres/trust-substrate.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/compiler/src/protocol.ts",
      "name": "StorageTransitionElementKind"
    },
    {
      "path": "packages/compiler/src/storage.ts",
      "name": "relaxesRelationRequiredness"
    },
    {
      "path": "packages/compiler/src/storage.ts",
      "name": "sameRelationShape"
    },
    {
      "path": "packages/compiler/src/storage.ts",
      "name": "STORAGE_COMPATIBILITY_MATRIX"
    },
    {
      "path": "packages/compiler/src/storage.ts",
      "name": "classifyStorageTransitionElement"
    },
    {
      "path": "packages/compiler/src/storage.ts",
      "name": "validateStorageRendererStatements"
    },
    {
      "path": "packages/postgres-provider/src/module-storage-materializer.ts",
      "name": "applyDdlElement"
    },
    {
      "path": "packages/postgres-provider/src/module-storage-materializer.ts",
      "name": "mergeExpectedRelations"
    }
  ]
}
```

## Gates and SHAs

**A record cannot name its own commit**, so this names only SHAs that exist when
it is written. The **round-3 executable candidate is
`0783cc1ac75e71a66d95e2cfab682025cfb9d7ac`** — the last commit to move
production, a test, or a manifest's executable fields. Everything above it is
records-only, and the freeze is the branch tip, reported in the checkpoint block.

Round history, every candidate tagged and fetchable:

| round | executable candidate | frozen tip | verdict |
|---|---|---|---|
| 1 | `baabc0f` | `8226279`, tag `…-reviewed-r1` | **BLOCK** — F1 production defect, F2 evidence, F3 fail-open |
| 2 | `a0a6cd1` | `deaa70b`, tag `…-reviewed-r2` | **BLOCK** — F1/F2/F3 closed; F4 record + matrix, F5 non-discriminating control |
| 3 | `0783cc1` | this freeze | — |

**Each prior review is void** — rounds 2 and 3 both change production, so §4's
new-SHA rule applies and each is a fresh candidate rather than a continuation.

**This is the FREEZE-CANDIDATE gate set, not the full CI matrix, and the
distinction is a rule rather than an omission.** `git-workflow`, "The matrix runs
AFTER review converges, not before it — ruled 2026-08-14", sequences it: cheap
gates, then the packet's blast-radius suites, then **freeze and review at that
SHA**, then **one full matrix, once, at the SHA that will integrate**. That
ruling states its own reconciliation with `AGENTS.md` §6 — *"§6 is satisfied
exactly as written: it requires the matrix green at the INTEGRATED SHA and has
never required one before review"* — and states what a freeze means under it:
*"gates and blast-radius suites green, and this is the SHA under review. It no
longer implies matrix-green."* It was measured, not asserted: two lanes burned a
full matrix on candidates a REVISE then superseded. The precedent is on the
ledger — `posting-error-shape` recorded *"Full matrix deliberately deferred to
post-review integration per `git-workflow`."*

**Round 3 nevertheless ran most of step 4's remainder**, because the round-2
reviewer named the omission and measuring it is cheaper than arguing about it:
`build`, `check:demo-release`, `check:app-release`, `test:contracts`,
`test:agent`, `check:language-coverage`, `test:performance` and `test:locale`
all PASS at the round-3 candidate. `check:app-release` is in this packet's blast
radius under the sequencing rule's own step 2 — a packet changing compiler output
runs it — and round 2 had not re-run it after the compiler moved. That was a real
gap in the freeze set and it is closed.

**Still not run, and named rather than left to inference:** the dependency and
secret scans, `check:reachability`, and the observability producer.
`check:reachability` cannot be run piecemeal — it needs `begin-reachability-run`
and every suite in one session — so it is a step-4 gate by construction. Those
belong at the integrated SHA.

**Where the gates were measured, stated exactly.** The suites below ran at
`a0a6cd183d3e795572cba19286b6b09fd93b9046`, with `HEAD` re-read after the run
and unchanged across it. **`format` and `test:architecture` were then re-run at
the frozen tip**, because §6's 2026-08-24 correction says those two cannot carry
past a narrative commit — `test:architecture` reads `docs/**`, so a narrative
commit changes its input. The round-2 record originally said only *"every gate
below was measured at `a0a6cd…`"*, which contradicted what had actually been
run; the round-2 reviewer caught the contradiction, and this paragraph is the
correction rather than a quiet repair.

| gate | round 1 | round 2 | round 3 |
|---|---|---|---|
| `typecheck` / `lint` / `format` | PASS | PASS | PASS |
| `test:unit` | 155/155 | 155/155 | 155/155 |
| `test:compiler` | 155/155 | **157/157** (+2 for F1 and F3) | 157/157 |
| `test:integration` | 149/149 | 149/149 | 149/149 |
| `test:architecture` | 189/189 | 189/189 | 189/189 |
| `check:schema` | 22/22, drift PASS | 22/22, drift PASS | 22/22, drift PASS |
| `test:postgres` | 209/209 | **210/210** (+1: the executing DDL observation) | 210/210 |
| `check:expected-red` (static) | OK, 18 entries | OK, **22 entries** | OK, 22 entries |
| `check:expected-red-controls` | OK, 38 controls | OK, 38 controls | OK, 38 controls |
| `evidence:expected-red` | this packet's 7/7 | this packet's 11/11 | **ALL 22/22** — the whole committed population, every manifest |
| `scripts/check-records.sh` | PASS | PASS | PASS |
| `build` | — | — | **PASS** |
| `check:app-release` | on branch, round 1 | — | **PASS** |
| `check:demo-release` | — | — | **PASS** |
| `test:contracts` | — | — | **PASS** |
| `test:agent` | — | — | **PASS** |
| `check:language-coverage` | — | — | **PASS** |
| `test:performance` | — | — | **PASS** |
| `test:locale` | — | — | **PASS** |
| `test:browser` | — | — | **93/93** |

`test:postgres` is REQUIRED here under §6's cross-layer rule, and after round 2
it is no longer only a regression check — one of its tests observes the new DDL.

### The eleven reds, and what each kills

| entry | one property varied | kills |
|---|---|---|
| `relaxation-is-never-recognised` | the planner never recognises a widening | 1 — the widening test refuses instead of planning |
| `widening-guard-admits-anything` | the shape equality always returns true | 1 — the three widening-plus-a-second-change combinations stop being refused |
| `requiredness-leaves-the-compared-shape` | `sameRelationShape` stops comparing `nullable` | 2 — a re-tightening becomes a shape-identical no-op with no DDL, and the field-origin exclusion falls with it |
| `field-origin-relations-are-widened-too` | the `origin: 'field'` guard is removed | 1 |
| `old-readers-are-told-relaxation-is-transparent` | the cell's `oldRead` flattened to `compatible` | 2 |
| `impact-reads-only-the-new-reader` | the impact derivation reads only `newRead` | 2 |
| `migration-does-not-admit-the-new-kind` | `relaxNotNull` removed from migration `0022`'s `CHECK` | 1 — via a real schema-drift refusal against a live database |
| `widening-inherits-the-hand-maintained-subset` | the explicit `archiveBehavior` bridge always applies, i.e. the F1 defect restored | 1 |
| `renderer-check-fails-open-on-unknown-kinds` | the allowlist inverted back to admitting the unrecognised | 1 |
| `provider-never-executes-the-widening` | the `ALTER COLUMN … DROP NOT NULL` deleted from `applyDdlElement` | 1 — via `CATALOG_DRIFT` against a live database |
| `merge-refuses-a-mixed-live-root-set` | the widening branch removed from `mergeExpectedRelations` | 1 — via `LIVE_SET_SHAPE_CONFLICT` against a live database |

**One claim is over-determined and has no single-property killer, stated rather
than papered over.** One-wayness is enforced by the CONJUNCTION of two guards in
`relaxesRelationRequiredness` — deleting either alone leaves the other refusing —
so no one-line mutation of that function kills the round-trip test.
`requiredness-leaves-the-compared-shape` kills it from the other side, by
removing nullability from the compared shape, which is the more dangerous
failure anyway: it makes a re-tightening pass silently with no DDL rather than
plan a wrong one.

### What the gate set does NOT prove

**Round 1 shipped with the provider half unobserved. Round 2 closes it.** The
round-1 record said plainly that `applyDdlElement`'s `relaxNotNull` case and
`mergeExpectedRelations`' widening tolerance had no observing gate and that the
DDL had never run against PostgreSQL. The reviewer confirmed the cheapest broken
tree and ruled it a blocking evidence failure. It is now observed — see "Round 2"
below.

What remains unproven, stated narrowly:

- **The next element kind is still unprotected.** `applyDdlElement`'s switch has
  no exhaustiveness check. This packet's kind is now covered by an executing
  test; a future one added without a case still builds green and applies
  nothing. Filed as `materializer-element-switch-is-not-exhaustive`.
- **`rendererStatement`'s cast still lies.** `StorageRendererStatement` does not
  carry `backfill`, `duplicateScan`, `tightenNotNull` or `relaxNotNull`, and this
  packet did not change that — `protocol.ts` is leased for the element-kind union
  only. What round 2 fixed is the CONSEQUENCE: the policy check no longer admits
  what it does not recognise. The type-level half of
  `renderer-statement-union-is-not-the-element-vocabulary` stays open.
- **Three of the reviewer's eight sub-steps are not implemented.** Their step 7
  (abandon the preparation, re-check the column) has no abandonment path in this
  system to drive, so the residue is observed in its available form instead —
  the column is nullable at PREPARE, before any approval, with zero attempt
  claims recorded. Their step 8 (an old-release create observing
  `MODULE_REQUIRED_RELATION_MISSING`) is not executed here; the guard was read
  and cited in ADR-0061 rather than run, and it is a claim about the OLD
  release's runtime rather than about this element.
