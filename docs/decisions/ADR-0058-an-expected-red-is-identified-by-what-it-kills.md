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

1. **It cannot say WHICH red it saw.** Three of that runner's nine entries share
   the exact pattern `/Missing expected rejection/u`, and that pattern matches
   any unmet `assert.rejects` anywhere in a 16-test PostgreSQL file. A mutation
   that broke something else entirely — or a harness that died halfway — would
   satisfy it. `review-tiers` already names this: *"a red count is not
   attribution"*.
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

Every entry declares `kills`: the exact set of tests that must stop passing under
its mutation, each named by **file and test name together**. The runner computes
the actual set as *(tests passing at baseline) minus (tests passing under the
mutation)*, read from a reporter artifact rather than from TAP prose, and
requires set equality. A red that kills a different test, or more tests, or
fewer, is refused as unattributable.

**The two halves are ONE observation, joined on the failing identity.** Each
declared kill must be present in the mutated run as an explicit **failure** —
absent, skipped, or never registered is not a kill — and `expected` is matched
against **those tests' own failure messages**, never the transcript at large.

*Corrected 2026-08-21, on review, and the correction is the whole point of this
ADR.* The first implementation computed the kill set and grepped the whole
transcript as two independent predicates that were never joined. The reviewer
supplied the specimen: a declared victim that stops being reported without ever
failing, a witness that keeps passing so the kill set stays exact, and a test
that exists only under the mutation and fails carrying the declared token. Every
separate check is green and the gate certifies a red it never observed. **A
Cartesian conjunction of two true facts is not an identity.** That specimen is
now control C5, and it is refused.

**Kills are file-qualified for the same reason.** Two files may legitimately
carry the same test name, so a name-only declaration is satisfied by killing
either. Control C6 holds it.

**And the reason belongs to each kill, not to the entry — corrected 2026-08-21,
round 3.** One pattern applied to the concatenation of every declared failure's
message is satisfied when any single one of them carries it, so a second declared
kill could die for anything at all. That is the same Cartesian conjunction, moved
inside the kill set. Each kill declares `expected`, and each must fail for its
own stated reason. Control C9 holds it.

**A `test:fail` is not necessarily an executed failure, so the classifier is an
allowlist.** Node reports a cancelled child, a timed-out test and an aborted one
all as `test:fail`, and counts all of them under `counts.cancelled` rather than
`counts.failed`. Only failure types on the executed allowlist can be a kill;
anything else — including a type a future Node adds — cannot. That is
`review-tiers`' prefer-unrepresentable rule. Controls C8 and C10 hold it, and
reconciliation against Node's own counts is the backstop when the allowlist is
wrong: admit `testTimeoutFailure` and reconciliation refuses C10; delete
reconciliation as well and C10 is certified.

**The mutation is measured before the restored run, and that is an ORDERING
claim only.** It stops an invocation manufacturing its own co-cause: a suite that
leaves state behind cannot have its baseline's leavings be the reason its mutated
run reds, because there is no baseline before it. Control H3 holds it, and H3 is
certified the moment a pre-mutation baseline is reintroduced.

**WHAT THIS ADR DOES NOT CLAIM, withdrawn by orchestrator ruling 2026-08-21.**
Earlier drafts said the gate establishes that the mutation is the SOLE CAUSE of
the red, measured from a CLEAN START. **It does not, and for arbitrary suites it
cannot.** State left by a previous invocation, another suite, a database or a
container is ambient, and the gate certifies a red that needed it — reproduced,
and pinned as control K1 so the limit is executable rather than prose.

Rounds 4 and 5 each found a false certification produced by chasing that claim,
and `review-tiers` says what to do about a claim that keeps outrunning its
specimens: **narrow the claim rather than grow the table.** So the claim is now
exactly what the gate observes:

> With production restored the suite is wholly green. With this one named
> one-property mutation applied, exactly these declared tests stopped passing,
> each failing in its own body for its own declared reason, with no undeclared
> outcome — and the subject was still mutated when that was measured.

Nothing about isolation. Nothing about a clean start. Nothing about sufficiency.
Closing that gap needs a per-entry isolation contract covering files, databases
and containers, which may not be expressible for arbitrary suites at all; it is
filed as `expected-red-needs-an-initial-state-contract` rather than pretended.

**What the kill set does and does not settle — measured, 2026-08-21.** In one run all three
of those PostgreSQL entries killed the *identical* pair of tests, and
they still share one `expected`. So the kill set does **not** make entries
mutually distinguishable, and it should not: `assertAllowedKeys`, the effective
input digest and `requireActiveCreateLegalEntity` are three independently
necessary checks guarding the same journey, and removing any one of them
legitimately breaks the same two tests. What the kill set settles is the other
question, which is the one a control has to answer: **of everything this suite
could have gone red about, is this the red the entry declared?** A crash, a
flake, an unrelated regression, or a mutation with a wider blast radius all
change the set and are refused.

**The message pattern is retained and narrowed, not replaced.** It answers a
question the kill set cannot: the right test can fail for the wrong reason.
`expected` is refused **statically** when it matches any line a green
`node:test` transcript emits — which refuses `/./` by construction rather than by
a literal-character heuristic, and refuses every other pattern with the same
defect. That is a conservative rejection of trivial patterns, not a measurement
against a real baseline, and it should not be described as one.

*A second rule, refusing `expected` when it matched the suite's own green
transcript at run time, existed in the first draft and was removed once the
pattern began matching failure messages rather than transcripts: green text is
no longer among the data `expected` is tested against, so the rule had nothing
left to refuse. The ADR went on claiming it until the 2026-08-21 round-2 review
noticed. Removing it does not reopen the Cartesian join.*

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

**The measurement cannot restore the subject, and the boundary is where the
observation is DEFINED.** `observeMutatedRun` lives in
`test/helpers/expected-red-measure.mjs`, which imports no `writeFileSync` and no
`rmSync`, and it receives plain data — no closure over the caller's scope.

*Stated at its real strength, because two weaker versions of this claim have now
been refuted.* The first passed a narrow parameter object to a thunk declared
beside `path`, `originalSource` and an imported `writeFileSync`; the round-1
review pointed out the thunk kept every capability it was supposedly denied. The
second moved the two called primitives but left the thunk — and therefore the
operation — in the writer-capable module; the round-2 review pointed that out
too. **`expected-red.mjs` still imports write capability and always will, because
it applies the mutation.** What is established is narrower and checkable: the
function that performs the observation is defined in a module where no write
exists, and it is handed data rather than scope. The dynamic guard is control
D2, which observes a suite that heals the subject and refuses it by digest. *The earlier arrangement claimed this because
`withMutation` handed its measurer a narrow parameter object — while the
measurer was a closure declared beside `path`, `originalSource` and an imported
`writeFileSync`, and retained every capability it was supposedly denied. The
review was right that the claim was false.* The observed half, a digest
read-back taken before the restore, is held by control D2, whose fixture suite
tidies up after itself by restoring the subject from `HEAD`.

**Forbidden.** No mutation generation, no coverage scoring, no mutant survival
ratios. R2 was explicit that this adds only the helpers the real journey needs,
and `review-tiers` is explicit that a self-chosen table measures its author's
model. Mutation choice and fixture self-correlation stay with a human.

**And the gate proves it can fail on every run, not once.** `--self-test` is
wired as its own gate, `check:expected-red-controls`, in CI and the matrix. A
gate whose negative controls are executed only when someone remembers to ask
decays into the same prose this ADR exists to replace.

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
- **Five** of the nine ported entries reproduce their reds through the shared
  runner, each measured mutation-first and then restored. The other four are routed, not
  shipped — see the packet record, and the bullet below for what exposed them.
  *(An earlier draft of this line said all nine reproduce. It was wrong, it
  contradicted the packet record in the same commit, and the review caught it.)*
- **The decision paid for itself on its own backfill.** A whole-file PostgreSQL
  entry — `unscoped-create-closed-key-fence-removed` — was observed stopping
  **two** tests in one run and **four** in another, same mutation and same argv.
  Its original recorded red, _the file went red matching
  `/Missing expected rejection/u`_, is satisfied by both. The kill set made the
  difference visible; the message pattern could not have. The four PostgreSQL
  entries are routed rather than shipped, for the reason in the packet record.
- The gate's own negative controls: **31**, in
  `scripts/check-expected-red.sh --self-test`, wired as its own gate so the
  proof is re-taken on every CI and matrix run rather than once at freeze.
- **Six meta-controls, each deleting one check and requiring the control that
  holds it to die.** This is the deletion question asked of the CHECK rather
  than of the control, which is what the first round failed. Deleting the entry
  frozen-tree precondition makes D1 report both *"refused, but not by the entry
  precondition"* and *"the runner executed a baseline or a mutation before
  refusing"*; deleting the digest read-back makes D2 report *"the gate reported
  OK"*; deleting the failure-join makes C5 stop refusing for its stated reason;
  comparing the tree with the index instead of `HEAD` makes D3 report *"the
  runner started against a staged-only modification"*; dropping the file from
  kill identities makes C6 fail; checking the journal after loading manifests
  makes G1 fail.
- **The round-1 review found four checks whose controls survived their
  deletion**, and each is recorded above with the control that now holds it. The
  worst was D1: the entry precondition and the exit postcondition shared one
  message, so a run could proceed on dirty bytes, restore them, and have the
  exit assertion supply the words the control was looking for.
- **The synthetic-pass guard was wrong twice, in opposite directions, because it
  asked a test's TITLE a question only the event stream answers.** Comparing the
  pair only when both paths were absolute credited Node's synthetic file-level
  pass whenever a command named its files relatively — one "passing" test in a
  run that executed none, found by the zero-matching-name-pattern control.
  Resolving relative titles against cwd fixed that and broke the other side: a
  **real** test whose name happens to equal its own relative path was discarded,
  found by the round-1 review. Measured against Node's own events, the fact is
  structural: a file whose filter matched nothing emits its `test:summary` with
  `counts.tests: 0` **before** the synthetic pass, while a real result always
  arrives **before** its file's summary. `createNodeResultLedger` reads that
  ordering; both reporters use it; and the rule now carries an admission twin —
  a real path-named result must still be credited.

## Enforcement

`scripts/check-expected-red.sh`, wired as `check:expected-red` into CI and
`scripts/run-matrix.sh` (static: shape and drift), and as
`evidence:expected-red` under the exclusive test lock (executing: the reds).
The gate's own vacuity is held by its `--self-test`.
