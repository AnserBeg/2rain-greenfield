# G3-Pterm — Terminal-state operation preconditions (queue row `5g3-term`)

Lane: CANON · Tier: Critical · Branch: `packet/g3-term` · Base: `378216a`
Status: **AUTHOR-ONLY, UNCOMMITTED, PARTIAL BY RULING.** The orchestrator commits, gates
and reviews. The matrix was not run — another lane is repairing the compile-budget gate.

## What was authorized and what was built

The design is `docs/execution/debates/g3-terminal-state-design-ruling.md` (Option A),
recorded as [ADR-0034](../../decisions/ADR-0034-terminal-state-operation-preconditions.md).
I did not re-open it.

The packet was split because the ruling sequences it **after `G3-P5`**, which owns
`module-runtime-interpreter.ts` — where `prepareMutation` lives and where the enforcement
authority belongs. `G3-P5` is not on main (no `onHand`, migrations stop at `0017`, no
`0019`), so its interpreter diff is unreadable from here and the ruling's own §7 records
that anchors will need mechanical rebasing onto it.

**Authored:**

| File | Change |
|---|---|
| `packages/canonical-model/src/predicate-kernel.ts` | `admitPredicateForExecution` — parse-only structural admission, plus the `admitted` receipt variant |
| `packages/canonical-model/src/index.ts` | export it |
| `packages/runtime/src/semantic-operation-gateway.ts` | the one-argument fence widened to parse-only admission |
| `test/unit/canonical-model/predicate-admission.test.ts` | kernel controls (new file) |
| `docs/decisions/ADR-0034-…md` | the decision record |
| this file | the packet record |

**Deferred until `G3-P5` lands:** `definition.ts` (the declaration),
`module-runtime-interpreter.ts` (evaluation + parent-aggregate rule), and
`test/postgres/inventory-terminal-state.test.ts` (controls C1–C7).

**`conformance.ts` deferred by my choice**, though the orchestrator released it. Two
reasons. The pin must assert **exactly** the authored predicate, and that predicate's
authored form lives in the deferred `definition.ts` — pinning a guess would create a
second authority on the spelling, which is the thing this ruling exists to avoid. And an
intentionally-red rule in an uncommitted tree destroys my ability to tell "red because
deferred" from "red because I broke something", with no matrix to fall back on.

**Untouched, and the diff proves it:** `schemas.ts` and `normalize.ts` have zero changes
— the no-language-event invariant. Also untouched: `semantic-query-gateway.ts`,
`release-verification-service.ts`, `module-storage-materializer.ts`, `apps/web/**`,
`builder.ts`, `performance-budget.test.ts`, `inventory-posting-service.ts`. No migration.
`stateMachines` neither adopted nor extended.

## The fail-open window is real, demonstrated, and blocks merge

The ruling says the only fail-open partial order is
gateway-widened-before-interpreter-evaluates. **That is now the state of this branch**,
and it is not theoretical:

`test/integration/module-runtime.test.ts` goes **8 pass / 5 fail** with the fence widened
and no evaluator. The load-bearing one is *"unsupported compiled predicates fail closed
before the generic executor"*: a literal-`false` precondition previously refused with
`operation-precondition-unsupported`, and now returns
`operation-read-back-unsupported` — the operation still refused, **but only because a
second, unrelated fence happened to catch it** (that fixture's read-back filter is also
literal `false`). The precondition fence itself no longer refuses a parseable-but-false
predicate, which is correct once the interpreter evaluates and unsafe until then.

I did not edit those expectations. They legitimately change when the interpreter lands —
refusal moves to `MODULE_OPERATION_PRECONDITION_REFUSED` — and encoding that now would
assert something nothing satisfies.

**This branch must not merge before the interpreter evaluates.** The red suite is the
evidence, not an accident to be tidied.

## Controls, with the victim whose deletion turns each red

| # | Control | Victim | Recorded red |
|---|---|---|---|
| K1 | Admission parses an executable predicate **without evaluating it**, and `true`/`false` admit identically | the `admitted` receipt construction — a receipt varying with truth would be an evaluation | — (positive) |
| K2 | **THE FAIL-OPEN DIRECTION.** Admission refuses every unparseable shape: non-record, missing key, non-Boolean literal, unknown kind, unknown version, unknown binding position | `if (parsed.outcome === 'rejected') return parsed;` in `admitPredicateForExecution` | disabled → **2/3 — red** |
| K3 | `admitted` is not `accepted`, so unmigrated callers still refuse; the v0 one-argument fence still admits only literal `true` | the separate `admitted` outcome — collapsing it into `accepted` turns this red | — (positive) |
| G1 | **The gateway still refuses an unparseable precondition.** This is the one thing this half can get wrong alone | `if (preconditionReceipt.outcome !== 'admitted')` in `semantic-operation-gateway.ts` | deleted → integration **6/13 — red** |

**The named fail-open victim you asked for: `semantic-operation-gateway.ts`, the
`if (preconditionReceipt.outcome !== 'admitted') { … }` refusal guarding
`SEMANTIC_OPERATION_PRECONDITION_UNSUPPORTED`.** Deleting it admits an unparseable
predicate silently; the recorded red is integration 6 pass / 7 fail.

Written `!== 'admitted'` rather than `=== 'rejected'` deliberately: only an explicit
admission proceeds, so any receipt shape this gateway does not recognise refuses instead
of falling through. `=== 'rejected'` would admit a future variant by default.

## Gates run

`node_modules/.bin/tsc --project tsconfig.json --noEmit` — clean.
`test/unit/canonical-model/predicate-admission.test.ts` — 3/3.
`test/integration/module-runtime.test.ts` — 8/13, **expected and explained above**.
No matrix, no commit, per instruction.

## Owed before this can land

1. `G3-P5` integrates; rebase the interpreter anchors onto its `prepareMutation`.
2. Interpreter evaluation + parent-aggregate rule; the declaration in `definition.ts`;
   the conformance pin.
3. `test/integration/module-runtime.test.ts` expectations updated to
   `MODULE_OPERATION_PRECONDITION_REFUSED` where the refusal legitimately moves.
4. Two add-only registrations for the new unit test file: `package.json`'s `test:unit`
   file list and `test/architecture/repository-hygiene.test.ts`'s unit inventory. **I did
   not make these** — the file is unregistered as it stands, which `check:reachability`
   will catch.
