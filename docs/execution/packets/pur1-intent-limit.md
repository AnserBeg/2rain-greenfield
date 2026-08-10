# pur1-intent-limit — a surface admits one operation per intent

Status: evidence ready
Tier: Critical
Branch: `packet/pur1-intent-limit`
Base: `712f04c` (`main`)

## What kind of constraint it is: a DISPATCH constraint

The row and the charter both framed this as a likely rendering assumption that
hardened into a contract. **It is not.** The limit was load-bearing on the
**write** path, and the evidence is a chain of four, not an argument:

1. `apps/web/src/surface-runtime.ts:228` said so in its own header —
   *"Resolves a browser intent to one pinned operation; no operation ID is
   accepted."*
2. `:244-247` did it: `binding.operations.find((candidate) =>
   candidate.intent === intent)`. `intent` was the **only** selector.
3. All three posting forms carried it and nothing else —
   `<input type="hidden" name="intent" value="command">` in
   `renderCapabilityCommand`, `renderLifecycleForm` and `renderSections`.
4. **`test/architecture/surface-data-binding.test.ts:32` pinned it**:
   `assert.doesNotMatch(joined, /submission\.operationId/)`. The rule was
   executable, not commentary.

So `byIntent`'s uniqueness is what made `intent -> operation` a *function*.
The rendering side is real but secondary: `renderCommandBar` did `.find()` and
`mutationIntents` is a set-membership test with no arity. Had the map simply
been re-keyed, the command bar would have rendered two buttons that both
posted `intent=command`, and the `find` would have returned whichever sorted
first — **pressing Cancel would have released the order.** That is the
silently-wrong-answer class, not a layout question.

The charter predicted where the answer would be: *"the reason will be in
whatever consumes `byIntent` downstream."* The consumer is
`submitSurfaceRuntimeIntent`.

## The shape chosen, and what rejected the others

**Chosen: key the binding by operation id, and move the write path's addressing
unit from the intent to the operation.** A submission names its operation; the
runtime resolves it against `binding.operations`; the intent is read off the
resolved operation.

**The property that made the old ban look necessary is preserved exactly.** The
set of reachable operations is unchanged — it is `binding.operations`, and an
id absent from it is refused. What moved is only the *selection within an
already-authorized set*, from the server's sort order to the control the user
pressed. The compiled binding is still the sole authority for what is
invocable; the wire selects, it does not name.

**Candidate 1 as literally stated — re-key the map and let the slot render all
commands — is wrong, and this was measured rather than reasoned.** Keying alone
leaves `submitSurfaceRuntimeIntent` resolving by intent. The executed red below
is that measurement: with the fixture bound and the pre-change runtime in
place, *nothing* renders.

**Candidate 2 — distinct intents for release and cancel — rejected on two
counts.** First, it is not derivable: `operationIntent()`
(`surface-contract.ts:659`) maps **effect kinds**, and release and cancel are
the same kind (`transitionStateEffect`, or two `registeredCapabilityEffect`s).
Distinguishing them means reading module-authored transition names. Second,
`SurfaceOperationIntent` is a **closed platform vocabulary** spelled in four
places — the type, `operationIntent()`, the wire parser that used to live at
`surface-runtime.ts:698`, and `mutationIntents` in the registry. Growing it per
module transition is ux-grammar's one rule inverted: *users customize content,
never grammar*. It also does not generalise — a document with three
transitions needs three more.

**Candidate 3 — many per intent with a declared rendering rule — is not an
alternative; it is the half of the answer that is not dispatch.** It ships here
as `INTENT_RENDERED_ARITY` rather than as a competing shape, because admitting
two of anything still requires the write path to tell them apart.

## The refusal stays named, and only where a control exists

`INTENT_RENDERED_ARITY` (`surface-contract.ts`) is the whole of what lifted:

| intent | arity | the control that decides it |
|---|---|---|
| `command` | many | one named button per command |
| `create`, `update` | 1 | the form role's single Save button |
| `archive`, `restore` | 1 | one lifecycle button, chosen by `record.archived` |

A second operation on any of the four still throws `INVALID_SURFACE_BINDING`.
**The limit lifted where a control exists and nowhere else** — the alternative
would be quiet permissiveness, which the charter correctly called worse than
the limit.

*Corrected on revision:* this said the refusal keeps *"the same message"*. It
does not. The text moved from a hard-coded `O0` to `${operation.tier}`, so a
tier-`o1` duplicate now names `o1` instead of misreporting it as `O0`. The new
message is more accurate and the old claim was simply false — which matters
because "unchanged" is exactly the kind of assertion a reader stops checking.

All four intents are executed as a table against
`readCompiledSurfaceDataBinding`, asserting `SurfaceProjectionError` and
`code === 'INVALID_SURFACE_BINDING'`, each with an admission twin.

## The executed red

Source reverted to `main` with `git checkout main -- apps/web/src/{surface-contract,surface-runtime,component-registry}.ts`,
tests committed first at `3d0fd54`, run through the lock wrapper:

```
✘ a record command bar renders every granted command as its own operable control
    Locator: locator('[data-platform-slot="record:commandBar"] .command-bar')
    Expected: visible ... element(s) not found
✘ a posted operation id outside the surface binding is refused
    Expected: 200   Received: 422
✓ an intent rendered by one control still refuses a second operation by name
```

Restored: **3 passed**. Full `test:browser`: **70 passed**.

Two things this red says that the row did not:

- **The refusal is not partial.** The row read *"a document that can be
  released but not cancelled from its own surface."* `readCompiledSurfaceDataBinding`
  throws for the **whole binding**, and `surface-runtime.ts:113` renders a
  page-level `QUERY_UNSUPPORTED` at 422. A purchase order carrying both would
  have had **no record screen at all** — not a screen missing a button.
- **The third arm was vacuous until it was fixed.** It first passed against the
  reverted source, because with two commands bound *everything* 422s. It now
  posts a **bound** id and requires a 200, so the three refusals are
  attributable to the id rather than to a dead surface.

## Controls

`apps/web/test/browser/surface-data-binding.spec.ts` — three arms on an
in-process server over a fixture package compiled through the real normalizer
and compiler. Two `registeredCapabilityEffect` operations on one entity, which
needs no purchasing entity, no mount and no language cut.

1. two granted commands render two enabled, distinctly-named submit controls;
   pressing the **second** runs the second, observed three ways — the executor
   records which operation id it received, the record read-back names the
   capability that ran, and the feedback banner names the resolved operation;
2. an intent rendered by one control still refuses a second operation, observed
   as the rendered page (`create`);
3. ids outside the binding are refused (another entity's operation, an
   unregistered one, and the empty string — so the retired wire vocabulary is
   not a fallback), with the bound-id 200 companion.

`test/integration/surface-data-binding.test.ts` — the two controls that carry
the properties, rather than a page that happens to agree with them:

- **the four-intent refusal table.** For `archive`, `create`, `restore` and
  `update` in turn: duplicate that operation, call
  `readCompiledSurfaceDataBinding`, and assert `SurfaceProjectionError` with
  `code === 'INVALID_SURFACE_BINDING'` and the intent named in the message —
  each with its admission twin asserting exactly one such operation binds
  un-duplicated. Arm 2 above observes `QUERY_UNSUPPORTED`, which is what the
  runtime renders for *any* unreadable binding, so it cannot distinguish a
  per-intent exemption, a bare `throw`, or the other three intents going
  unchecked. This can;
- **`semanticOperationRequestFor` tested directly** — the envelope's
  `operationId` is the resolved operation's, its key set is closed, it is
  frozen, and an `input` carrying its own `operationId` cannot reach it.

`apps/web/test/surface-runtime-contract.test.ts` — the arity table pinned
against the renderer each entry names as its authority, plus its vacuity red
(a permissive table, and a `find` re-imposed in the command bar).

## The merge, and the control that had to be built twice

`main` gained `5g3-sm`'s v5 cut while this packet was in review, and the merge
is the payoff rather than the tax: with v5, a release and a cancel are both
`transitionStateEffect` and `operationIntent` maps both to `command` — the
exact collision this packet lifted. **No pre-merge tree can exercise the
packet's own premise.** One parent can author transitions and cannot bind two;
the other can bind two and cannot author them.

Two conflicts, both resolved as complementary:

- `surface-contract.ts` — main's `KNOWN LIMIT` comment said an entity carrying
  a release AND a cancel *"binds neither and refuses by name"* and named the
  rendering question as owed. That comment is this packet's charter, so it is
  **deleted rather than relocated**.
- `component-registry.ts` — `renderCapabilityCommand` takes both halves:
  `5g3-sm`'s effect-sensitive explanation and this packet's `operationId`
  addressing. Parsed capability effects carry a nonblank `capabilityId` and
  transitions carry `null`, so the conditional selects correctly without
  weakening the addressing side.

**The first control for this proved the premise and not the claim.** It
asserted on the binding — two commands, distinct ids, `capabilityId: null` —
and never rendered, so `renderCapabilityCommand` was never executed by it. The
reviewer disproved it with the instrument that now generalises in
`review-tiers`: **revert each parent's half alone and ask whether the control
notices.** Neither revert was noticed.

The replacement renders the command bar and asserts both halves on the **same
two forms**, each with a presence arm *and* an absence arm — because "the new
thing is here" does not exclude "the old thing is also here", and both is
exactly what a half-reverted merge produces:

| | present | absent |
|---|---|---|
| addressing (`34f452e`) | `name="operationId"` per form | no `name="intent"` |
| explanation (`eb02adf`) | *"Ready. This moves the record…"* | no *"Draft staged"* |
| controls | labels `[Cancel, Release]`, in order, off the rendered buttons | |

Run against the reviewer's instrument:

```
ARM 0  merged tree                        ok
ARM    revert the 34f452e half alone      not ok   CONTROL_RED_OBSERVED
ARM    revert the eb02adf half alone      not ok   CONTROL_RED_OBSERVED
```

The fixture also needed a `commandBar` slot — `entitySurfaces` gives one slot
per surface, so the transitions had nowhere to render. That absence is part of
why the binding-only test could not have caught this.

## The governing pin the row did not predict

`test/architecture/surface-data-binding.test.ts:32` banned the string
`submission.operationId` outright. That was a **sufficient** condition for
"the browser cannot name the operation" and it stopped being a **necessary**
one — the same shape `lease-derivation` is chartered on, one gate over.

Re-pinned to the property rather than the spelling: every read of the posted id
must be the comparison that looks it up in `binding.operations`, and the id
handed to the gateway must be the resolved operation's.

**That re-pin was not enough, and ADR-0051 §4 corrects the record.** Narrowing
a source scan to the property leaves it a source scan. It stays green against

```ts
const operation =
  submission.selectorBypass === '1'
    ? binding.operations[0]
    : binding.operations.find((c) => c.operationId === submission.operationId);
```

— the compliant comparison is still written, the gateway still receives
`operation.operationId`, and an unbound posted id quietly proceeds with the
first bound operation. A spread overriding the compliant member leaks
identically.

**The property is now structural.** `semanticOperationRequestFor` is the one
construction site for a gateway request and its argument list has no
submission in it, so neither shape is expressible there — ADR-0048 §2's
`keyof typeof` move one layer over: make the wrong thing inexpressible, not
detectable. `boundOperation` likewise takes the binding and one string, so
there is no second axis to branch on. The architecture check stays as a cheap
ratchet and is labelled as one; it is no longer what the property rests on.

Its vacuity controls now run the **production predicate** against their
specimens. The empty-read arm previously asserted its own fixture had zero
reads without ever calling the predicate, so it never observed the
`length > 0` guard fire — it proved a property of the specimen, not of the
check.

Precedent for re-pinning rather than deleting: `40b4029 test(press-law):
re-pin the conformance line the permission rule moved`.

## What is owed and not done

- **Ordering is deterministic and not yet meaningful.** ux-grammar §3 requires
  *"the primary action first; destructive actions behind the overflow."*
  Commands sort by intent then operation id, because `operationDefinition`
  declares **no `orderKey`** — the catalog carries no signal for which command
  is primary. With a release and a cancel this renders **Cancel before
  Release**, which is the grammar's rule backwards. It is recorded in
  `INTENT_RENDERED_ARITY`'s comment and belongs to ux-grammar plus a carrier
  decision; this packet did not invent one.
- **`transitionStateEffect` is not the exercised path here.** It maps to
  `command` only on `packet/5g3-sm`, which is unmerged. The fixture uses two
  registered capabilities; both kinds bind to the same intent through the same
  code, so `LANG-ADOPT-v5` inherits this fix rather than needing its own.
- `INVALID_SURFACE_BINDING` still surfaces as `QUERY_UNSUPPORTED`, unchanged
  and owned by `msg-code-accuracy`.

## Gate evidence

**Full matrix green at `b86cb09`.** All fifteen steps executed, zero `not ok`,
`MATRIX_EXIT=0` written inside the log the run produced. Terminal checks:

```
language coverage: PASS (1943 obligations; 0 receipts; 1943 decision-covered)
reachability:      PASS (99/99 test files executed; 10 producer artifacts)
```

Local gates before the slot was requested, each through
`run-with-test-lock.mjs`: `typecheck` clean, `test:contracts` 16/16,
`test:integration` 87/87, `test:architecture` 139/139, `test:unit` 105/105,
`test:browser` 70.

### What the first matrix cost, and why it was not this change

The first run at the same SHA returned `MATRIX_EXIT=1`: two `testTimeoutFailure`
at exactly 300000 ms in `test/postgres/composed-application.test.ts` — tests 8
and 9. **Attributed to machine load, and then confirmed rather than argued.**

The same two tests at the same SHA on the second run:

| Test | run 1 | run 2 |
|---|---|---|
| composed product activates through the kernel | timeout (>300 s) | **135.8 s** |
| composed product advances to a compiled successor | timeout (>300 s) | **98.8 s** |

The test's own header documents the exposure: *"210.9 s inside the full matrix
… this workload is load-dependent"* against a 300 s bound — a 1.42x margin. It
also forbids the tempting fix: *"If this ever reds on timing … It is NOT to
raise the bound."* **The bound was not touched.** Corroborating: all seven of
test 8's subtests passed before the parent timed out, the overrun sitting in the
post-subtest activation work; and this packet changes **no file either test
reads** — they read `apps/web/release/*.json` and the compile script, and the
diff touches zero release artifacts.

**The failed run was nearly read as a pass.** The wrapper's exit status was 0,
because the last command in the runner script was a `grep`. Only the
`MATRIX_EXIT=` line *inside* the log showed the 1 — which is the whole content
of learnings.md's *"Capture an exit code inside the log, not beside the
command."*

**One thing the second run's instrumentation could not do.** Idle was sampled
every 30 s (mean 78.2%, min 43.9%), but that is *total system* idle and the
matrix is itself the dominant load, so the sampler cannot separate self-load
from contention. It would not have distinguished the two runs. The load record
is reported for what it is rather than cited as the proof; the 300 s → 135.8 s
delta at a fixed SHA is the evidence.

### Pre-flight, per learnings.md

Before requesting the slot, the last failures' checks were run rather than just
`typecheck`: full integration and full architecture, plus a sweep of both
residue classes `5g3-sm-impl` burned runs on. Two findings worth carrying:

- **The implementation-vocabulary guard is in `test:integration`**, not
  architecture — `test/integration/semantic-gateways.test.ts:593` — and it reads
  exactly three `packages/runtime` files. Its forbidden list includes
  `dispatch`, `handler`, `patch` and `source`, all used heavily in this packet's
  new prose. In `apps/web/src`, which that guard does not scan.
- **The pinned-line class: swept, two hits, both prose.** This packet shifts
  lines in all three sources (+39, +6, +8). `message-catalog.spec.ts:548` cites
  `surface-runtime.ts:113`, still exactly the catch site.
  `surface-grammar.spec.ts:889` cites `surface-runtime.ts:1176-1177` — already
  stale on `main`, where that file is 1146 lines. Pre-existing, no gate reads it.

### Base

Cut from `712f04c`. `main` has since moved to `af44c6f` with two narrative-only
commits (ADR-0051 and a `review-tiers` amendment); nothing under `test/` or
`apps/web/test/` reads `review-tiers/SKILL.md` or `current-plan.md`, so the
integrated tree's executable content is identical to this candidate and
AGENTS.md §6's identical-content rule makes this run the acceptance run.

For a checkpoint under two minutes:

```bash
corepack pnpm test:contracts
```

For a checkpoint under two minutes:

```bash
corepack pnpm test:contracts
```
