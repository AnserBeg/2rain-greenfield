# expected-red-gate — a manifest-driven expected-red acceptance gate

Date: 2026-08-21
Base: `3610a1f3bf54a82a169ea349650e801b62309d37` (`origin/main`, verified before cut)
Branch: `packet/expected-red-gate`
Tier: Critical
Status: frozen for review

## Packet definition

Goal: give `AGENTS.md` §6's demanded reds a reusable way to be constructed and a
gate that refuses them when they stop being real.

Ruling: [ADR-0058](../../decisions/ADR-0058-an-expected-red-is-identified-by-what-it-kills.md).

The program review of 2026-08-20 measured the gap (finding R2): the one packet
that committed its mutation runner converged in two rounds while its neighbours
took four to seven, and everywhere else §6's reds were performed by hand and
transcribed into review-log prose, executable never again.

## What ships

**(a) A shared runner.** `test/helpers/expected-red.mjs` is
`test/integration/scoped-create-operand-mutations.mjs` lifted out of one packet:
it discovers manifests by glob rather than carrying one inline, memoizes a green
baseline per distinct test command, and builds the `node --test` argv itself.
`test/helpers/expected-red-reporter.mjs` records one line per real test result
so attribution is read from a produced artifact rather than parsed from TAP
prose.

**(b) A manifest format.** `test/evidence/<packet>.expected-red.json`. Each
entry names the production seam it holds (`claim`), the one-property mutation
(`file` / `original` / `replacement`), the tests it must break (`kills`), and
the failure text it must produce (`expected`). ADR-0058 rules on why the message
pattern alone is not a sufficient identity and what was added beside it.

**(c) An acceptance gate.** `scripts/check-expected-red.sh`, in the pattern of
`check-review-record.sh`:

| mode | proves | cost | wired as |
|---|---|---|---|
| default | every entry still names source text present exactly once in the file it claims, and no entry's shape can pass vacuously | milliseconds | `check:expected-red`, in CI and `run-matrix.sh` |
| `--run` | every selected mutation reproduces its exact declared red and the tree is restored | seconds to tens of minutes | `evidence:expected-red`, under the exclusive test lock |
| `--self-test` | the gate can fail, one recorded red per vacuity vector | ~5s | run before freezing |

**What the default mode cannot prove**, stated because §6 requires it: it does
not execute anything, so it cannot prove any mutation still reds. The split is
deliberate — drift is what goes stale on its own and is cheap enough for every
matrix; reproducing the reds costs minutes and belongs at acceptance.

**(d) A backfill.** See below.

## The three ways this gate could have betrayed itself

Each has its own recorded red in `--self-test`, varying one property of an
otherwise-correct manifest entry. 14 controls in total.

**A — the mutation did not apply.** A1 an `original` absent from its file
(`EXPECTED_RED_VICTIM_ABSENT`); A2 an `original` matching more than once, where
`String.replace` would silently mutate only the first
(`EXPECTED_RED_VICTIM_AMBIGUOUS`); A3 a `replacement` identical to the original
(`EXPECTED_RED_NO_MUTATION`).

**B — the check read zero input.** B1 a glob discovering no manifest
(`EXPECTED_RED_NO_MANIFESTS`); B2 a name pattern selecting no test — refused at
the baseline, before the mutation, because a suite that exits 0 having executed
nothing is not a green baseline; B3 a mistyped entry name, refused rather than
run as a selection of nothing.

**C — the red fired for the wrong reason.** C1 an `expected` that also matches a
green transcript (`EXPECTED_RED_PATTERN_NOT_DISCRIMINATING`, which is how `/./`
is refused); C2 a mutation the suite does not notice (`SURVIVOR`); C3 a red
whose text is not the declared one; C4 a red that killed a different test than
the one declared.

**D — the subject repaired before it is measured.** The measurer receives no way
to restore: the original bytes and the writing call are captured in
`withMutation` and never passed on. That is the structural half. The observed
half is a digest read-back taken after the suite exits and before the restore,
so a subject healed mid-run is refused by name. D1 additionally proves the
runner refuses a dirty tracked tree — which is what makes `git checkout -- <file>`
a lossless recovery for a crashed run, per `commit-before-negative-controls`.
Every executing control also asserts the fixture subject is byte-identical
afterwards.

**E — the admission twin.** A correct manifest against correct production
passes. A gate that only ever refuses is as useless as one that only ever
passes.

**And the gate's own controls are not vacuous.** Two meta-controls, each run on
a committed tree and reverted:

- Disabling the victim-absent refusal makes A1 report *"the gate reported OK"*.
- Restoring the subject before the measurer runs makes the admission twin report
  *"the subject was repaired before it was measured"* — §6's vector, observed by
  digest rather than argued from code shape.

## A defect the controls found

The zero-matching-name-pattern control (B2) reported **one passing test in a run
that executed none**. The cause is in `test/helpers/node-reporter-core.mjs`: the
guard that refuses Node's synthetic file-level pass compared the pair only when
BOTH paths were absolute, and Node emits a **relative** `data.name` beside an
absolute `data.file`. So the guard returned false for the exact shape it exists
to catch.

Latent for the reachability suites, which cannot reach that state because
`assertUnfilteredNodeArguments` refuses `--test-name-pattern` outright; live for
any focused run. Fixed, and the relative/absolute pair is now pinned beside the
absolute/absolute one in `test/architecture/test-reachability.test.ts`, which
previously covered only the case that already worked.

## Backfill — converted, and left

**Converted: 9 of 9 entries that already existed as an executable table.** The
nine scoped-create mutations are
`test/evidence/scoped-create-operand-impl.expected-red.json`. Each gained a
`claim` sentence and a `kills` set; neither was recorded by the inline table, and
three of the nine share the pattern `/Missing expected rejection/u`, so before
`kills` any one of the three satisfied the other two's expectation.

`test/integration/scoped-create-operand-mutations.mjs` is deleted, not disabled.
Per `review-tiers`, a packet removing a harness owes a sentence naming which
claims lose their executable evidence: **none do.** All nine moved, and each is
now more strongly identified than it was.

**Left: the review-log prose.** Rows across seven packets record reds as
sentences — *"1/1 pass → 0/1 → restored"*, *"8/12 with four direct failures"*.
They were not converted, and the reason is not cost:

- **They do not name their mutation.** A manifest entry needs the exact
  production text replaced. The prose names the behaviour changed, in English,
  at a SHA that has since moved. Reconstructing `original` from it is a guess,
  and a guessed entry that happens to red is worse than no entry — it looks like
  evidence.
- **They belong to lanes this packet does not own.** The load-bearing ones sit
  in `apps/web/src` and `packages/**`, held right now by three frozen lanes.
  Retrofitting manifests into packets this packet does not own is out of scope
  by charter.
- **The ones that are cheap are also browser reds.** `inventory-surface-legibility`'s
  bare-text mutation is reconstructible, and its suite is `test:browser` — a
  Playwright run, which the runner's `node --test` argv does not build.

**Disposition:** backfill belongs to each owning packet's next round, where the
author knows the seam and the source has not moved. The mechanism now exists for
them to use. Extending the runner to Playwright suites is a separate, honest
piece of work and is routed, not smuggled in.

## The fenced-claim architecture check — deferred, with the precondition

R2's second half asked for an architecture check that every fenced claim names
≥1 manifest entry. **Not built.** The reasoning is in ADR-0058's *"What this ADR
deliberately does NOT decide"*: fences are created in review prompts, which
`AGENTS.md` §4 puts in `~/2rain-missions`, outside this repository; where they
appear here they are unmarked English in paragraph-length table cells. A
heuristic scanner over that corpus would fail on prose and train everyone to
phrase around it, which is the `gate-reads-a-different-thing-than-its-name`
class this program already carries three instances of.

The precondition is a **marker**, not a cleverer scanner. Once a fence is
recorded in a machine-findable form, the check is a join on entry names, which
are already stable. Routed to `current-plan.md`.

## Cost, measured

- The five focused-integration entries: **12 seconds** for five mutations,
  including two baselines.
- `--self-test`: **~5 seconds**, 14 controls.
- The four PostgreSQL entries: `test/postgres/composed-application.test.ts` takes
  **9m48s** solo for one run, so an entry naming that whole file costs about
  twenty minutes for its baseline plus its mutated run. **Manifest authors should
  focus the test with a `namePattern`.** This is why `--run` is an
  acceptance-time entry point and not a matrix step.

## Owned paths

`scripts/**` · `test/helpers/**` · `test/evidence/**` ·
`test/fixtures/expected-red/**` · `test/architecture/test-reachability.test.ts`
· `package.json` · `.github/workflows/ci.yml` · `docs/decisions/**` ·
`docs/execution/**`.

Not touched: `packages/**` and `apps/web/src/**` — three lanes hold them. The
manifest *names* files in those paths and the runner mutates them transiently
inside this worktree, restoring before it exits; the committed diff touches
none.

**Consequence worth stating:** if `press-law-splice`, `web-refusal-taxonomy` or
`stock-balance-read-model` change `component-registry.ts`, `surface-runtime.ts`,
`semantic-operation-gateway.ts` or `module-runtime-interpreter.ts` before this
merges, the manifest's `original` strings may drift. `check:expected-red` is
exactly the thing that says so, loudly, instead of measuring nothing.
