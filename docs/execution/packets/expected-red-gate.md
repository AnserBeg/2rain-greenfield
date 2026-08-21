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
| `--self-test` | the gate can fail, one recorded red per vacuity vector | ~5s | `check:expected-red-controls`, in CI and `run-matrix.sh` |

**What the default mode cannot prove**, stated because §6 requires it: it does
not execute anything, so it cannot prove any mutation still reds. The split is
deliberate — drift is what goes stale on its own and is cheap enough for every
matrix; reproducing the reds costs minutes and belongs at acceptance.

**(d) A backfill.** See below.

## The three ways this gate could have betrayed itself

Each has its own recorded red in `--self-test`, varying one property of an
otherwise-correct manifest entry. **33 controls**, and the self-test is itself a
gate — `check:expected-red-controls` runs in CI and the matrix, so the proof
that this instrument can fail is re-taken on every run rather than once at
freeze time.

**Round 1 of review found four checks whose controls survived deleting the check
itself**, which is the deletion question asked of the control instead of the
check. Each is now held: the entry frozen-tree precondition (D1, which used to
accept the *exit* postcondition's identical message), the digest read-back (D2),
the failure-join (C5), and file-qualified attribution (C6). Two further checks
that had no control at all — staged-tree refusal and the real in-flight race —
are now D3 and a rebuilt G1. **Six meta-controls run the deletion question on
each of those checks and require the holding control to die.**

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

**C — the red fired for the wrong reason.** *The load-bearing one is C5, and it
came from the reviewer rather than from this lane:* a declared victim that stops
being reported without ever failing, a witness that keeps passing so the kill set
stays exact, and a test existing only under the mutation that fails carrying the
declared token. Every separate check green; the gate certifying a red it never
observed. `expected` is now matched against the declared tests' own failure
messages, and each declared kill must be an explicit failure. C6 holds
file-qualified attribution against two files sharing one test name. The rest: C1 an `expected` that also matches a
green transcript (`EXPECTED_RED_PATTERN_NOT_DISCRIMINATING`, which is how `/./`
is refused); C2 a mutation the suite does not notice (`SURVIVOR`); C3 a red
whose text is not the declared one; C4 a red that killed a different test than
the one declared.

**D — the subject repaired before it is measured.** `observeMutatedRun` is
**defined** in `test/helpers/expected-red-measure.mjs`, which imports no
`writeFileSync` and no `rmSync`, and takes plain data rather than a closure.
*Two weaker versions of this claim were refuted in successive rounds: first a
narrow parameter object handed to a thunk that still closed over `path`,
`originalSource` and `writeFileSync`; then the two primitives moved while the
thunk — the operation — stayed in the writer-capable module.* `expected-red.mjs`
still imports write capability and must, because it applies the mutation. The
checkable claim is narrower: the observation is defined where no write exists.
That is the structural half. The observed
half is a digest read-back taken after the suite exits and before the restore,
so a subject healed mid-run is refused by name. D1 additionally proves the
runner refuses a dirty tracked tree — which is what makes `git checkout -- <file>`
a lossless recovery for a crashed run, per `commit-before-negative-controls`.
Every executing control also asserts the fixture subject is byte-identical
afterwards.

**G — validating a tree that is deliberately mutated.** Validation reads the
working tree, so a validate run racing a `--run` run would report the live
mutation as drift. It reports that it cannot determine instead, names the held
file, and says how to recover a killed run.

**E — the admission twin.** A correct manifest against correct production
passes. A gate that only ever refuses is as useless as one that only ever
passes.

**Rounds 4 and 5 ended in a RE-SCOPE, not another correction.** Five REVISE
verdicts, every one of them a false certification the previous round's fix did
not cover. `review-tiers` says what to do when a claim keeps outrunning its
specimens — **narrow the claim rather than grow the table** — and the
orchestrator ruled that on 2026-08-21.

**Withdrawn:** that the gate shows the mutation is the SOLE CAUSE of the red,
measured from a CLEAN START. It does not, and for arbitrary suites it cannot; the
interaction fixture is certified when its marker was left by an earlier
invocation. **Control K1 pins that behaviour executably** rather than leaving the
limit in prose, and closing it is
`expected-red-needs-an-initial-state-contract` in `current-plan.md`.

**Kept, and structurally fixed in the same ruling:** every mode binds to `HEAD`
rather than to the index or the working tree, and every outcome the mutation
produces must be declared — an undeclared `hookFailed` sibling or a test the
suite registers only under the mutation now refuses. Controls H4 and C5.

**The claim the gate makes is now exactly what it observes:** with production
restored the suite is wholly green; with this one named one-property mutation
applied, exactly these declared tests stopped passing, each failing in its own
body for its own declared reason, with no undeclared outcome, and the subject was
still mutated when that was measured.

**Round 2 added four checks and a specimen for each — plus one gap, stated
because it is the same gap this packet exists to close.**

| check | specimen that dies without it |
|---|---|
| the ledger's no-summary rule | **C7** — a file that throws at import, whose lone `test:fail` is named by the file's own relative path and is otherwise identical to the real test the admission rule credits |
| cancellation is not a failure | **C8** — a child left pending when its parent ends, declared as one of two kills |
| `notFailed` | **C8** — deleting it alone makes C8 report OK, which is what round 1 said no control did |
| the observation's definition site | **D2**, unchanged, plus the narrowed claim |

**Reconciliation against Node's per-file counts earns its place, and round 3
supplied the specimen the previous round said did not exist.** A mutation-induced
**timeout** is reported as `test:fail` while Node counts it under
`counts.cancelled` — so a classifier that admits it produces exactly the
credited-versus-counted mismatch reconciliation exists to refuse. Measured: admit
`testTimeoutFailure` as executed and C10 is refused *by reconciliation*; admit it
**and** delete reconciliation and C10 reports **OK**. *The earlier record said no
suite shape produces this mismatch naturally. That was wrong, and the timeout
shape produces it under any classifier that gets one type wrong.*

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

**Converted and reproduced through the gate: 5 of 9.** The five focused
integration entries are `test/evidence/scoped-create-operand-impl.expected-red.json`
and all five reproduce their exact declared reds in 12 seconds. Each gained a
`claim` sentence and a `kills` set; the inline table recorded neither.

**Routed, not converted: the 4 PostgreSQL entries — and the reason is a finding
about evidence this program already accepted.** Their manifest form is preserved
in commit `e94441b`; restoring them is a revert of one file, not a re-derivation.

Two measurements, both taken with the gate:

1. **A whole-file entry's blast radius is not stable.**
   `unscoped-create-closed-key-fence-removed` stopped **two** tests in one run and
   **four** in another — same mutation, same argv, same suite. The two extra are
   `composed product advances an existing deployment to an exact compiled
   successor` and the ADR-0047 rollback edge: 300-second-timeout-bounded
   release-lineage tests that run *after* the create the claim is about and are
   disturbed by the row an unfenced create now writes. **The red this packet
   originally recorded — the file went red matching `/Missing expected
   rejection/u` — is satisfied by both outcomes and cannot tell them apart.**
   That is precisely what ADR-0058 says a message-only identity cannot do, found
   in the packet that motivated the ADR.
2. **Bounding the entry to the test that holds the claim does not currently
   work, for an infrastructure reason.** With
   `--test-name-pattern=composed product activates through the kernel`, the
   **baseline** fails on unmutated production: `waitUntilReady` at
   `test/helpers/postgres.ts:273`, an ephemeral-container readiness timeout at
   `composed-application.test.ts:407`. Reproduced twice, on a machine with no
   orphaned containers and 936GB free. In the whole-file run the same test passes
   as the seventh container of the process; in isolation it is the first, and the
   readiness deadline does not survive the cold start. **This is the open TIER 3
   row `container-pressure-forges-outcomes`, met head-on.**

**The runner refused rather than measuring.** It reported *"the suite is not green
before the mutation, so no red it produces can be attributed to the mutation"* and
stopped. Had it only checked for a non-zero exit — which is what the original
inline runner did — it would have recorded a red for a suite that was already
red, which is the admission-side vacuity this packet exists to close.

**Which claims lose executable evidence, stated because `review-tiers` requires
it:** the effective-input digest identity, the closed-argument-key fence on
create, active-legal-entity enforcement, and the archived-entity predicate. All
four remain covered by `test:postgres` in the full matrix; what they lose is a
one-property mutation proving each is load-bearing. **They were not silently
dropped and they were not kept as a red gate.**

`test/integration/scoped-create-operand-mutations.mjs` is deleted, not disabled.
Per `review-tiers`, a packet removing a harness owes a sentence naming which
claims lose their executable evidence. **Four do**, and they are the four named
above: the effective-input digest identity, the closed-argument-key fence on
create, active-legal-entity enforcement, and the archived-entity predicate.
Their manifest form is preserved in `e94441b`, and all four remain covered by
`test:postgres` in the full matrix; what they lose is a one-property mutation
proving each is load-bearing.

*An earlier draft of this paragraph said none do, contradicting the sentence
above it in the same file. The round-1 review caught it. The honest sentence is
the one now written: five shipped through the new gate, four were reconstructed,
measured, found unsuitable, and routed.*

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
  measured mutation-first and then restored.
- `--self-test`: seconds, **33 controls**.
- The four PostgreSQL entries: `test/postgres/composed-application.test.ts` takes
  **9m48s** solo for one run, so an entry naming that whole file costs about
  twenty minutes for its baseline plus its mutated run. One full nine-entry run
  took **41 minutes**. **Manifest authors should focus the test with a
  `namePattern`** — and see the backfill section for what happened when this
  packet tried to. This is why `--run` is an acceptance-time entry point and not
  a matrix step.

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
