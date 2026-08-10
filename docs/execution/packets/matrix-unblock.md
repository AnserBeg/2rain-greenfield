# matrix-unblock — the matrix reaches its suites again, and the formatter stops drifting

Status: evidence ready
Tier: Behavioral
Branch: `packet/matrix-unblock`
Base: `194871f` (`origin/main` at cut; verified, not assumed)

## Outcome

`pnpm format` and `pnpm lint` are green. They are the first two steps of the
main block of `scripts/run-matrix.sh`, so while format was red the matrix
aborted before a single suite ran and no packet in this repository could
freeze. Two froze without one.

The reformat is today's symptom. The fix is the pin: `package.json` declared
`prettier: ^3.6.2` while `pnpm-lock.yaml` resolved `3.9.5`, so files formatted
under an older 3.x stopped satisfying the newer one. `prettier` is now pinned
to `3.9.5` exactly.

## Why 3.9.5

It is the version the lockfile already resolved, and therefore the version
every reformatted file is now formatted under. Pinning to the current
resolution records what is true rather than changing it: no reformat churn
beyond this packet's own, and the same bytes for the next lane. `js-tiktoken`
is already pinned exactly in the same `devDependencies` block, so the shape is
not new here.

## The pin is load-bearing, proved by negative control

A `--frozen-lockfile` install proves nothing about a pin: it honours whatever
the lockfile says, caret or not. That is the vacuity vector, so the check
re-resolves from the manifest with no lockfile present and runs the defect
itself as the control.

| Spec | Fresh resolution (no lockfile) |
| --- | --- |
| `^3.6.2` — the defect, as a control | **3.9.6** |
| `3.9.5` — the pin | **3.9.5** |

`prettier@3.9.6` is published. The caret does not merely risk drifting; it
drifts *today*, on the next lockfile refresh any lane performs. The control
observes the failure, not a proxy for it.

Repository-level, after `rm -rf node_modules`: a fresh
`pnpm install --frozen-lockfile` resolves `prettier 3.9.5`, the lockfile
records `specifier: 3.9.5` where it recorded `^3.6.2`, and the tree stays
clean. `pnpm-workspace.yaml` carries `overrides` for `brace-expansion` and
`js-yaml` but none for `prettier`, so the pin is the only mechanism in play.

## Scope discovery: fourteen files, not seven

The charter named seven format-failing files. At `194871f` there are
**fourteen**. `pnpm format` is `prettier --check .` over the whole repository,
so it cannot go green with seven of fourteen fixed, and the charter's own
prescribed remedy — run `format:write` once — formats all of them. The other
seven landed on `main` between 2026-08-08 and 2026-08-10, after the charter
sampled the tree.

The seven the charter did not name:
`apps/web/src/surface-contract.ts` (already owned, as a lint file),
`apps/web/test/browser/surface-data-binding.spec.ts`,
`apps/web/test/surface-runtime-contract.test.ts`,
`packages/compiler/src/projections.ts`,
`packages/runtime/src/semantic-operation-gateway.ts`,
`test/architecture/surface-data-binding.test.ts`,
`test/integration/surface-data-binding.test.ts`.

## "Whitespace only" is not literally true

The charter said the format differences are whitespace only. They are not,
quite: prettier 3.9 **adds grouping parentheses** when it re-wraps a boolean
chain, so the token stream changes. `git diff -w` cannot see this either way —
it ignores whitespace within a line but a re-wrap moves tokens between lines.

Measured instead: with whitespace, grouping parentheses and commas stripped,
all eleven files that carry no hand edit are byte-identical to their parent.
The four hand-edited files were diffed token-per-line, and the only non-paren,
non-comma deltas are the four intended edits below. This is a pre-screen, not a
proof of behavioural identity; the matrix is that proof.

## The seven lint errors, each decided on its merits

None blanket-disabled. No rule reconfigured. No `eslint-disable` added.

**1-4. `predicate-kernel.ts` — four unused imports, deleted.** History checked
first, as the charter required. They are not in-flight work: `f59fe0e`
(2026-08-08) replaced two version-enumerating switches with a
`SUPPORTED_LANGUAGE_VERSIONS`-derived lookup and left the import list
untouched. `LANGUAGE_VERSION`, `LANGUAGE_VERSIONS`, `LEGACY_LANGUAGE_VERSION`
and `PREVIOUS_LANGUAGE_VERSION` have zero uses each, verified by grep.
Restoring a use would re-enumerate versions, which is the exact staleness
`f59fe0e` existed to remove.

**5. `surface-contract.ts` — `transitionEffect`, deleted rather than wired
up.** The charter asked whether it was meant to be used in the tier check just
below. It cannot be, usefully. `9291e45` introduced it in the same hunk as the
tier-check comment and never read it. The check keys on `capabilityEffect` /
`!capabilityEffect`, and `!capabilityEffect` already covers the transition —
which is precisely what the comment above it says should happen. A kind cannot
be both strings, so `transitionEffect` implies `!capabilityEffect`:
substituting it would narrow the check to transitions alone and stop guarding
archive/create/restore/update, and OR-ing it in is a no-op. Deleting is the
only option that is neither a behaviour change nor dead redundancy.

**6. `module-runtime.test.ts:5585` — `no-explicit-any`, given a real type.**
`Array<Record<string, any>>` became a named `PersistedFieldChange` describing
the persisted change document as this test reads it back out of
`platform.trust_business_change_documents.changes`. Declared structurally
rather than imported from the producer's `BusinessFieldChangeInput`: a reader
typed by the writer's own contract stops being an independent observation of
what was stored. `newState`/`oldState` are typed as an optional `value`
carrier because a `VALUE` state nests its payload while `CLEARED` and `ABSENT`
do not — which is what the existing `?.value ?? …` read already assumes.

**7. `module-runtime-interpreter.ts:3380` — `no-fallthrough`, closed without a
disable and without touching the switch.**

The charter offered two routes — a targeted `eslint-disable-next-line`, or an
argument that the rule should be configured differently — and both rest on the
premise that the shared archive/restore/transition arm is what ESLint objected
to. **It is not.** The trigger is the *comment's placement*: a comment inside
an otherwise-empty case body makes that case non-empty, and a non-empty case
that falls through is reported. Stacked empty cases are not.

Proved with a two-function probe: identical stacked cases, comment inside the
body reports at the following `case`; comment hoisted above the stack reports
nothing.

So the comment moved above the three case labels. Case labels, their order,
their bodies and the control flow are byte-identical — the switch is not
restructured and no behaviour changed. The comment still introduces the arm it
explains.

This is strictly better than a disable comment, which would have suppressed
the rule on the one line where a genuine fallthrough could later be
introduced. The guard stays armed, and any future edit that moves the comment
back into the case body is caught by the same error.

## Gates

Full matrix run at `3f9f358`, verdict read from inside the log rather than
from the pipeline's exit status:

```
PERFORMANCE_GATE_PASS_SHA=3f9f358c289f5693f2e0406d2e6867dc92dc8752
FULL_MATRIX_PASS_SHA=3f9f358c289f5693f2e0406d2e6867dc92dc8752
```

Log: `/tmp/matrix-matrix-unblock-3f9f358.log`. Ran 12:39-13:05.

| Step | Result |
| --- | --- |
| `format` / `lint` / `typecheck` / `build` | pass — the two that were red are green |
| `check:boundaries`, `check:schema`, `check:demo-release`, `check:app-release` | pass |
| `test:performance` | 5 pass, 0 fail |
| `test:unit` | 106 pass, 0 fail |
| `test:compiler` | 133 pass, 0 fail |
| `test:integration` | 113 pass, 0 fail |
| `test:agent` | 3 pass, 0 fail |
| `test:architecture` | 141 pass, 0 fail |
| `test:contracts` | 16 pass, 0 fail |
| `test:postgres` | 196 pass, 0 fail |
| `test:locale` | 1 pass, 0 fail |
| `test:browser` | 70 passed (2.8m) |
| observability producer | 11 pass, 0 fail |
| `check:language-coverage` | PASS — 2050 obligations, 427 first-party observations |
| `check:reachability` | PASS — 99/99 test files executed, 10 producer artifacts |
| security scans | passed |

**Nothing downstream was red.** The charter anticipated that this packet would
be the first in a while to reach the suites at all and asked for careful
reporting if anything beyond format/lint turned out broken. Nothing did.

Two log lines look alarming and are not. `TEST_GATE_LOCK_BUSY` appears three
times against locks named `north-star-*-control-2554` — those are the lock
gate's own negative controls asserting the busy path, not the real lock. And
`WRN leaks found: 1` is the secret scanner's planted synthetic credential in a
throwaway one-commit repository; `run-security-scans.sh` requires
`negativeRuleDetected` to be true, so that line is the gate observing itself
fail, which is what AGENTS.md section 6 asks of it.

### Pre-matrix conditions

Reported as required, after the previous holder's load decayed:

1. **Lock holders** — `/tmp/north-star-matrix.lock.holders/*.json` **empty**.
   It was not when this packet started: `packet/lang-adopt-v5` held it (pid
   40546) from before 12:12 until 12:37:44, running `pnpm test` through
   `test:browser`. This lane waited rather than competing.
2. **CPU idle** — **96%** over a 10s `vmstat` sample, against the 90% floor.
   Pass. One-minute load average 0.82, down from 8.64 at 12:34.
3. **Worktree CPU burn** — **none.** No process under any
   `2rain-greenfield-*` path was consuming CPU.

Decision: run. All three cleared with margin.

### Freeze SHA sits one docs commit above the matrix SHA

`3f9f358` is both, as it happens — the record was committed before the matrix
so the run had a clean tree to freeze on, and the gate table is appended
afterwards, producing a fourth commit. The executable diff from the matrix SHA
to the freeze SHA is empty:

```
git diff --name-only 3f9f358 <freeze> -- . ':!docs' ':!.agents' \
  ':!CLAUDE.md' ':!AGENTS.md' ':!learnings.md'
```

returns nothing; the only delta is this file. Per `git-workflow`, the matrix
run stands.

## What this packet did NOT verify

- **That the reformat is behaviourally inert.** The paren/comma-stripped
  comparison is a pre-screen over text, not an AST or emitted-JS comparison.
  The matrix is the evidence.
- **That 3.9.5 is the right version to sit on long-term.** It is the version
  already resolved. Whether to move to 3.9.6 is a decision this packet
  deliberately did not make, because doing so would have reformatted the tree
  a second time under a version nothing had been formatted under.
- **The lint judgments are arguments, not gates.** Nothing executes to prove
  that deleting `transitionEffect` was preferable to wiring it in; the tier
  check's existing tests pass either way, because `!capabilityEffect` and the
  wired form agree on every input the suite exercises.
- **Anything about `lang-adopt-v5`'s tree.** See below.

## Sequencing note for the orchestrator

`packet/lang-adopt-v5` is active and holds two of the reformatted files
(`packages/canonical-model/src/constants.ts`,
`test/architecture/canonical-contracts-purity.test.ts`) — and, as it turns
out, more than two, since the file set is fourteen rather than seven.

**That lane must merge `main` and re-run `pnpm format:write`, not hand-resolve
the conflict.** A formatting conflict is mechanically re-derivable by
re-running the formatter, and `git-workflow`'s "a conflict in a derived
artifact is re-derived, never picked" applies directly: formatted source is a
function of the formatter version and the input, so hand-picking a side
produces a tree that agrees with neither. That lane is blocked by this same
failure, so it has to merge regardless.
