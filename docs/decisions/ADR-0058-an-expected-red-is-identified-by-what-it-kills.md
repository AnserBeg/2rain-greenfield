# ADR-0058: An expected red is identified by what it kills, not by what it says

Date: 2026-08-21
Status: accepted
Tier: Critical (review per `review-tiers`)

## Context

`AGENTS.md` §6 requires a negative control for each way a gate could pass
vacuously, and supplies no reusable way to construct one. Every packet author
has invented the control from scratch and a reviewer has audited the invention
by hand. The 2026-08-20 program review's finding R2 measured the cost: the one
packet that committed a mutation runner converged in two rounds; its neighbours
took four to seven.

That runner — `test/integration/scoped-create-operand-mutations.mjs` — carried a
manifest of `{ name, file, original, replacement, expected: /regex/u, test }`
and required the mutated suite to exit non-zero with output matching `expected`.
Generalizing it into a gate forces a question the inline version never had to
answer: **is a regular expression over the failure text a strong enough identity
for the red a control claims to have observed?**

Three measurements say it is not, on its own.

1. **It cannot attribute.** Three of that runner's nine entries share the exact
   pattern `/Missing expected rejection/u`. Any one of those three mutations
   satisfies the other two's expectation. `review-tiers` already names this:
   *"a red count is not attribution"* — do the red names map to distinct
   specimens?
2. **It reads a proxy, not the fact.** §6 is explicit that parsing a tool's
   output is a proxy while reading a produced artifact is observation. The fact
   a control asserts is *this seam's test stopped working*; the failure text is
   a rendering of that fact, and a loose pattern matches renderings of other
   facts — including a harness crash.
3. **It cannot tell itself apart from a green run.** Nothing refused
   `expected: /./`, which matches every transcript a passing suite emits.

## Decision

**A manifest entry's expected red is identified by the pair (kill set, message
pattern), and the kill set is load-bearing.**

Every entry declares `kills`: the exact set of test names that must stop passing
under its mutation. The runner computes the actual set as *(tests passing at
baseline) minus (tests passing under the mutation)*, read from a reporter
artifact rather than from TAP prose, and requires set equality. A red that kills
a different test, or more tests, or fewer, is refused as unattributable.

**The message pattern is retained and narrowed, not replaced.** It answers a
question the kill set cannot: the right test can fail for the wrong reason.
Two rules make it discriminating:

- **Statically**, `expected` is refused when it matches any line a green
  `node:test` transcript emits. That refuses `/./` by construction rather than
  by a literal-character heuristic, and it refuses every other pattern with the
  same defect.
- **At run time**, `expected` is refused when it matches the same suite's own
  green baseline output. Discrimination is measured against the real transcript,
  not asserted.

**Every entry also declares `claim`** — the production seam it holds, in a
sentence. A manifest that names a file and not a seam records what was mutated
and leaves a reviewer no way to judge whether it was the right thing to mutate.

**The runner builds the test command itself.** Entries declare files and an
optional name pattern; the argv, the reporter, and `--test-concurrency=1` are
the runner's. A free-form argv is where a reporter gets dropped and a name
pattern gets typoed into matching nothing.

## Consequences

**Easier.** A packet's reds are re-derivable by `pnpm evidence:expected-red`
instead of transcribed into review-log prose. Drift is caught by a static check
cheap enough for every matrix, so an entry whose production text has moved fails
loudly instead of silently measuring nothing.

**Harder.** `kills` is exact, so a production change that legitimately widens a
mutation's blast radius reds the gate until the entry is updated. That
brittleness is the feature: it is drift detection, and the failure message
prints the observed set so the fix is a paste.

**Costly where the suite is.** Each entry costs one baseline (memoized per
distinct command) plus one mutated run. Focused `namePattern` entries cost
seconds; an entry naming a whole PostgreSQL file costs about ten minutes per
run. Manifest authors should focus the test, and `--run` stays an
acceptance-time entry point rather than a matrix step for exactly this reason.

**Forbidden.** No mutation generation, no coverage scoring, no mutant survival
ratios. R2 was explicit that this adds only the helpers the real journey needs,
and `review-tiers` is explicit that a self-chosen table measures its author's
model. Mutation choice and fixture self-correlation stay with a human.

## What this ADR deliberately does NOT decide

R2 also asked for **"an architecture check that every fenced claim names ≥1
manifest entry."** That check is **deferred, not declined**, and the reason is
that the population it would scan does not exist in this repository.

A "fenced claim" is created in a **review prompt** — *"settled, do not spend
effort: X"* — and `AGENTS.md` §4 puts launcher templates and captured review
results in `~/2rain-missions`, outside the repository. Where fences do appear
here, in `docs/execution/review-log.md`, they are unmarked English inside
paragraph-length table cells. A check over that corpus would have to decide
which sentences are fences by heuristic, and it would fail on prose while
teaching everyone to phrase around it — which is worse than not having it, and
is the `gate-reads-a-different-thing-than-its-name` class this program already
carries three instances of.

**The precondition for building it is a marker, not a cleverer scanner.** When a
fence is recorded in the repository in a form a machine can find — a `Fenced:`
trailer on a review-log row, or a fences block in the packet record naming the
claim and the control that holds it — the check becomes a join on
`kills`/`claim` and is worth building. `manifest-entry` names in
`test/evidence/**` are already stable identifiers for the right-hand side of
that join.

## Evidence

- `scoped-create-operand-impl`: two rounds with a committed runner, against four
  to seven for its neighbours (2026-08-20 program review, R2).
- The nine ported entries reproduce their reds through the shared runner; the
  five focused-integration entries in 12 seconds, including two baselines.
- The gate's own negative controls: 14, one per vacuity vector, in
  `scripts/check-expected-red.sh --self-test`.
- Two meta-controls prove the self-test can fail. Disabling the victim-absent
  refusal makes control A1 report *"the gate reported OK"*. Restoring the subject
  before the measurer runs makes the admission twin report *"the subject was
  repaired before it was measured"* — §6's vector, observed by digest read-back
  rather than argued from code shape.
- The zero-matching-name-pattern control found a live defect in
  `test/helpers/node-reporter-core.mjs`: the guard refusing Node's synthetic
  file-level pass compared the pair only when both paths were absolute, and Node
  emits a relative `name` with an absolute `file`. One "passing" test was
  credited in a run that executed none. Fixed and pinned.

## Enforcement

`scripts/check-expected-red.sh`, wired as `check:expected-red` into CI and
`scripts/run-matrix.sh` (static: shape and drift), and as
`evidence:expected-red` under the exclusive test lock (executing: the reds).
The gate's own vacuity is held by its `--self-test`.
