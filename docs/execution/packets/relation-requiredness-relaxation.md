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

## Gates and SHAs

*(filled in at freeze — see the checkpoint block)*
