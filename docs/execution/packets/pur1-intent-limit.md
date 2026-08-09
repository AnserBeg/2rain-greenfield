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

A second operation on any of the four still throws `INVALID_SURFACE_BINDING`
with the same message. **The limit lifted where a control exists and nowhere
else** — the alternative would be quiet permissiveness, which the charter
correctly called worse than the limit.

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
2. an intent rendered by one control still refuses a second operation by name;
3. ids outside the binding are refused (another entity's operation, an
   unregistered one, and the empty string — so the retired wire vocabulary is
   not a fallback), with the bound-id 200 companion.

`apps/web/test/surface-runtime-contract.test.ts` — the arity table pinned
against the renderer each entry names as its authority, plus its vacuity red
(a permissive table, and a `find` re-imposed in the command bar).

## The governing pin the row did not predict

`test/architecture/surface-data-binding.test.ts:32` banned the string
`submission.operationId` outright. That was a **sufficient** condition for
"the browser cannot name the operation" and it stopped being a **necessary**
one — the same shape `lease-derivation` is chartered on, one gate over.

Re-pinned to the property rather than the spelling: every read of the posted id
must be the comparison that looks it up in `binding.operations`, and the id
handed to the gateway must be the resolved operation's. A red arm observes the
leak it exists to catch. This is a source scan and therefore a proxy; arm 3
above is the observation.

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

Run at this tree, each through `run-with-test-lock.mjs`:

| Gate | Result |
|---|---|
| `typecheck` | exit 0, clean |
| `test:browser` | **70 passed** |
| `test:contracts` | **16/16** |
| `test:integration` | **87/87** |
| `test:architecture` | 137/138, then 138/138 after the re-pin |

The full matrix at the frozen SHA is not claimed here; it is the acceptance
gate and belongs in the writer handoff.

For a checkpoint under two minutes:

```bash
corepack pnpm test:contracts
```
