# PR-4 — Gate completeness round 2 + coverage audit

Status: evidence_ready — full matrix green and final scoped review PASS; ready for user acceptance
Tier: Mechanical
Branch: `packet/pr-4`
Base: `982d2df01204107f560469f34336da723ae9cd93`
Prior reviewed candidate: `7711a89758134b942e77a6a2277fcde05e393537`
Frozen reviewed candidate: `f7296dcfd3139928f949832f7cdabecae5cf4a5d`
Final evidence commit: post-review record only; reported in the completion block
Review: PASS — one final fresh naive `gpt-5.6-sol` xhigh review under the
user's post-tripwire design ruling

## Authority and outcome

PR-4 quotes the remaining recursive test globs, independently proves the
coverage of the five filesystem suites, and adds a structural architecture gate
that derives every reachable test from CI and package-script declarations. A
future `*.test.ts` or `*.spec.ts` file outside the declared selectors makes
`test:architecture` red with the exact unreachable path.

The static gate now conservatively credits only files named by unfiltered
commands. Any Node command carrying a test-selection argument contributes zero
files; `test:locale` therefore receives no credit, while its file remains
independently covered by the unfiltered `test:postgres` command.

The honest limitation is narrower than the original claim: this static gate
proves that a file is named by an unfiltered CI-invoked command, not that any
test inside the file actually ran. Queued PR-4b replaces inference with dynamic
executed-file evidence from Node and Playwright reporters and closes that class.

The packet also wires the two hidden compiled-shell guards, removes the dead
root Playwright scaffold, regenerates the one authorized stale content-addressed
root, records three doctrine gaps and seven documentation debts, and archives
the four external review inputs in-repository. It does not change product
source, dependencies, the lockfile, compiler behavior, or any artifact other
than `apps/web/release/shell.compiled.json`.

## Corrective scope

1. **Quoted recursive globs.** `test:architecture`, `test:compiler`,
   `test:integration`, and `test:postgres` pass quoted `**` patterns to Node.
   `repository-hygiene.test.ts` inspects every raw `test:*` script token and
   fails if a glob is not quoted before shell expansion.
2. **Five-suite discovery.** Unit, compiler, integration, architecture, and
   PostgreSQL commands are compared with independently expanded filesystem
   discovery and a reviewed inventory. Every discovery and command selection
   must be non-empty, and the inventory, discovery, and command sets must be
   identical.
3. **Structural reachability.** `test-reachability.test.ts` parses every CI
   `run:` form, resolves root and filtered web scripts, parses explicit Node
   test targets, expands quoted globs, and resolves Playwright `testDir`. Exact
   recognized non-test commands and the repository-cleanliness block are
   classified explicitly; unrecognized CI commands, package-script bodies,
   targets, continuations, and mappings throw with the unparsed text. Playwright
   configuration is parsed as TypeScript and every top-level key must be in an
   explicit selection-neutral allowlist; `testDir` is the sole parsed
   file-selection root. The permanent script allowlist contains only root
   `test` (developer aggregate) and `check:boundaries` (transitively executed
   by `dependency-boundaries.test.ts`). The aggregate is compared with every
   CI-invoked `test:*` command plus `check:demo-release`. Node commands carrying
   `--test-name-pattern`, `--test-only`, `--test-skip-pattern`, sharding, or an
   equivalent known selection option receive zero reachability credit.
4. **Orphans made live or removed.** Root passthroughs and quality-job steps now
   invoke `check:demo-release` and `test:contracts`; the hygiene test requires
   both. The unreferenced root `playwright.config.ts` and its skipped
   `test/browser/scaffold.spec.ts` were deleted after a repository-wide live
   reference check found none. The three real web browser specs remain selected
   by `apps/web/playwright.config.ts`.
5. **Coverage map and debt.** `doctrine-coverage.md` now records identity/policy,
   runtime configuration/secrets, and erasure as `prose-only` with no claimed
   current enforcement. `documentation-debt.md` owns the missing capability
   matrix, risk register, non-compiler SLO ratification, seed skills, G0 stage
   evidence, runtime config/secret contract, and compiled-demo byte-format
   decision.
6. **External review archive.** The request and all three reviews are archived
   under dated `program-reviews/` directories. The existing review provenance
   headers and bodies are unchanged. The request has exactly one added
   provenance line and separator. `docs/` was already excluded by
   `.prettierignore`, so no ignore bridge was necessary.
7. **Doctrine and learning.** AGENTS.md section 6 now states the executable
   every-test-reachable rule. The same evidenced rule is recorded in
   `learnings.md` under the repository's adjudicated-learning format.

## Commit trail

| Commit | Purpose |
|---|---|
| `0527d64` | Regenerate only the stale compiled-shell `releaseRoot` |
| `84cc0d3` | Quote globs, wire guards, remove dead scaffold, and add structural reachability gates |
| `2019d93` | Record doctrine/debt coverage, archive external reviews, and capture the learning |
| `3a26329` | Record the packet demonstrations and initial evidence |
| `04e4be7` | Normalize whitespace exposed by the first full-matrix cleanliness gate |
| `1aa5780` | Retain independent reviewed inventories for all five filesystem suites |
| `7d506f5` | Parse run-only workflow steps and add a workflow-level fail-closed canary |
| `7711a89` | Replace the Playwright selection-key denylist with a parsed top-level allowlist and retain its red/green evidence |
| `f7296dc` | Give filtered Node commands zero static reachability credit, prove locale remains independently covered, and queue PR-4b |

## Required demonstrations

### (a) Permanent in-suite canaries

`test-reachability.test.ts` ships five focused canaries:

- a pure comparison receives `test/orphan-demo/orphan.test.ts` in the synthetic
  discovered set but not the reachable set and returns exactly that path;
- the script parser receives `future-test-runner --all` and must throw
  `Unparsed synthetic script body: future-test-runner --all`;
- the workflow parser receives a valid run-only step written as
  `- run: future-test-runner --all` and must throw
  `Unparsed CI command: future-test-runner --all` rather than silently omit the
  step;
- the Playwright parser receives a direct `defineConfig` object containing the
  unknown top-level key `futureSelection` and must throw
  `Unparsed Playwright config key: futureSelection`;
- filtered Node commands using name, only, skip, shard, or rerun selectors must
  report `test/postgres/module-runtime.test.ts` unreachable when they are its
  only declared coverage. The real filtered `test:locale` script likewise
  receives zero credit, while unfiltered `test:postgres` independently covers
  that same file.

All five ran within the focused green 51-test architecture suite.

### (b) Real unreachable file, end to end

A real `test/orphan-demo/orphan.test.ts` was added under a directory selected by
no declared suite. The exact retained failure excerpt was:

```text
exit_code=1
# Subtest: every repository test file is reachable from a CI-invoked command
not ok 41 - every repository test file is reachable from a CI-invoked command
  ---
  duration_ms: 101.452171
  type: 'test'
  location: '/home/rvham/2rain-greenfield/test/architecture/test-reachability.test.ts:2:2908'
  failureType: 'testCodeFailure'
  error: |-
    Test files not reachable from CI: test/orphan-demo/orphan.test.ts
    + actual - expected

    + [
    +   'test/orphan-demo/orphan.test.ts'
    + ]
    - []

  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected:
  actual:
    0: 'test/orphan-demo/orphan.test.ts'
  operator: 'deepStrictEqual'
  stack: |-
    TestContext.<anonymous> (/home/rvham/2rain-greenfield/test/architecture/test-reachability.test.ts:92:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.processPendingSubtests (node:internal/test_runner/test:744:18)
    Test.postRun (node:internal/test_runner/test:1173:19)
    Test.run (node:internal/test_runner/test:1101:12)
  ---
  duration_ms: 8.700787
  type: 'test'
  ...
1..48
# tests 48
# suites 0
# pass 47
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 2423.403805
[ELIFECYCLE] Command failed with exit code 1.
```

After deleting the file and directory, the same command returned:

```text
1..48
# tests 48
# pass 48
# fail 0
git_status_after_canary=
```

The final empty value is the verbatim output of
`git status --porcelain --untracked-files=all`; no canary residue remained.

### (c) The shell glob bug in-repository

With temporary `test/compiler/sub/canary.test.ts` present and the old script
form still in `package.json`, the exact command summaries were:

```text
OLD UNQUOTED FORM
shell_argument_count=1
shell_argument=test/compiler/sub/canary.test.ts
1..1
# tests 1
# pass 1
# fail 0

QUOTED FORM
shell_argument_count=1
shell_argument=test/compiler/**/*.test.ts
1..50
# tests 50
# pass 50
# fail 0
```

The old form silently dropped all six top-level compiler files and executed
only the one subdirectory canary. The quoted form executed the real 49-test
compiler suite plus the canary. The temporary file and directory were removed,
and the tree was clean before the gate commit.

### (d) Playwright top-level allowlist, in-repository

The prior parser rejected a short denylist of known file-selection keys. The
authorized correction instead parses the direct `defineConfig({...})` object
and rejects every top-level key outside the explicit current-config allowlist.
With temporary `grep: /x/` added to the real
`apps/web/playwright.config.ts`, the exact retained result was:

```text
exit_code=1
not ok 43 - every repository test file is reachable from a CI-invoked command
  error: 'Unparsed Playwright config key: grep'
not ok 44 - every root test/check script is CI-invoked or explicitly justified
  error: 'Unparsed Playwright config key: grep'
not ok 45 - root test aggregate includes every CI-invoked test command and demo check
  error: 'Unparsed Playwright config key: grep'
# tests 50
# pass 47
# fail 3
```

After removing that one temporary line, the same command returned:

```text
# tests 50
# pass 50
# fail 0
```

`git diff --exit-code -- apps/web/playwright.config.ts` passed afterward; the
temporary selection key is absent from the candidate.

### Retained development red

The first generalized architecture run was honestly red at 45/48. The
fail-closed parser treated the workflow's `defaults.run.shell` YAML mapping as
an unparsed command and reported `Unparsed CI run declaration: run:` in all
three structural checks. The parser now recognizes exactly the empty
`defaults.run` mapping followed by `shell: bash`; any other empty `run:` mapping
fails closed. Architecture then passed 48/48.

The first full-matrix candidate, `3a263297810275bd1d3e371274820391e2115e52`,
passed every functional gate through observability 5/5, then failed the final
patch-whitespace gate honestly:

```text
docs/execution/packets/PR-4.md:107: trailing whitespace.
+<four spaces>
docs/execution/packets/PR-4.md:112: trailing whitespace.
+<four spaces>
```

Those were whitespace-only lines preserved inside the pasted orphan-canary
failure block. They were normalized to empty lines; no evidence text changed.

## Stale demo artifact evidence

### Blast radius before regeneration

Fresh compiler output was generated in `/tmp`, without touching the repository,
and recursively compared after JSON parsing. The exact output was:

```text
semantic changes: 1
releaseRoot: "728bc0ae2306ab0c5cc188f0675043247628629eab8825ff0cb94e286bf2c12b" -> "0a5362906943d62c7397db835958153a85457356224eb227a05d53c4e143259f"
9584ff11af5fcdb4fc786b626a4f061b2d470d3d82c09f427011820bf0aeb2eb  apps/web/release/shell.authored.json
9584ff11af5fcdb4fc786b626a4f061b2d470d3d82c09f427011820bf0aeb2eb  /tmp/tmp.0j707qrITL/apps/web/release/shell.authored.json
```

No recorded projection payload, artifact root, semantic digest, schema version,
instance ID, compiler version, normalized-definition digest, or output-protocol
version changed. `shell.authored.json` remained byte-identical and is absent
from `main...HEAD`.

### Explained root movement

The fixture was last generated by G1-P7 commit `9c108af`, before PR-2. Accepted
PR-2 commit `8152ad0` changed the non-recorded
`northstar.compiler:projection-family.verification-plan` family identified at
`packages/compiler/src/protocol.ts:81`: `packages/compiler/src/projections.ts`
replaced its provisional assertion-list payload with the v1 executable scenario
plan now built at lines 513-643. PR-2 is accepted in the ledger at reviewed SHA
`9d5f4187866410da3311e321f9982d56c4c073a3`. Because `releaseRoot` covers all
ten projection families while the fixture records five, that accepted
verification-family content change moved only the top-level Merkle root visible
in this fixture.

### Stable generation/format/check loop

The regeneration is standalone commit `0527d64` and changes one line. The
sequence was: build the demo release, Prettier-write the one generated file,
run repository `format`, run `check:demo-release`, run `test:contracts`, then
run `format` again. Results:

```text
All matched files use Prettier code style!
check:demo-release: exit 0
test:contracts: 6/6
compiled_before_second_format=40e58628a8a8520fffe9db130df91b8fe3d7bcc203b7580453befa1cf4ffc7e7
compiled_after_second_format=40e58628a8a8520fffe9db130df91b8fe3d7bcc203b7580453befa1cf4ffc7e7
authored_before=9584ff11af5fcdb4fc786b626a4f061b2d470d3d82c09f427011820bf0aeb2eb
authored_after=9584ff11af5fcdb4fc786b626a4f061b2d470d3d82c09f427011820bf0aeb2eb
```

The check remains deliberately parse-normalized rather than byte-exact. Its
test title now says so, and the byte-format/formatter ownership gap is recorded
in `documentation-debt.md`; check semantics did not change.

## External archive verification

The three review destinations are byte-identical to their sources:

```text
f9823ef002ba26a0df90cc4f519f1a520d4c09dbdcfa59fe984036232e215602  design review source and archive
f1f279714d8e95718c388d0ffa15727717112a01fbde58220d6551c520dd08b2  performance review source and archive
81844f615519541a3c1e42bb2ff16cd5a58fe98c3dd226f9ec00bb863d45dd1e  architecture review source and archive
```

`sed '1,2d' request.md | cmp source -` also passed, proving that the request
differs only by its required one-line provenance header and blank separator.
No finding was re-dispositioned in `current-plan.md`.

## Full-matrix evidence on the frozen candidate

The complete matrix ran serially from a clean tree at exactly
`f7296dcfd3139928f949832f7cdabecae5cf4a5d`. Focused development runs did not
substitute for it.

| Gate | Result |
|---|---|
| Frozen install | PASS — pnpm 11.9.0, all 13 workspace projects |
| `corepack pnpm format` | PASS |
| `corepack pnpm lint` | PASS |
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm check:boundaries` | PASS — 93 files scanned |
| `corepack pnpm build` | PASS |
| `corepack pnpm test:unit` | PASS — 27/27 |
| `corepack pnpm test:compiler` | PASS — 49/49 |
| `corepack pnpm test:integration` | PASS — 42/42 |
| `corepack pnpm test:agent` | PASS — 1/1 |
| `corepack pnpm test:architecture` | PASS — 51/51 |
| `corepack pnpm test:contracts` | PASS — 6/6 |
| `corepack pnpm check:demo-release` | PASS |
| `corepack pnpm check:schema` | PASS — 9 applied, 9 verified, no drift |
| `corepack pnpm test:postgres` | PASS — 61/61 |
| `corepack pnpm test:locale` | PASS — 1/1 |
| `corepack pnpm test:browser` | PASS — 5/5 |
| Security CI job | PASS — dependency audit; 201-commit clean scan found no leaks; disposable negative fixture found exactly one leak |
| Observability inline CI command | PASS — 5/5 |
| Patch and tree cleanliness | PASS — `git diff --check main...HEAD`, no tracked or untracked residue |

The first PostgreSQL run at this SHA was retained red at 60/61. The ephemeral
container used by “a failing callback still removes its ephemeral container”
logged that PostgreSQL was ready, but its mapped port refused connections until
the 30-second harness deadline:

```text
not ok 6 - a failing callback still removes its ephemeral container
error: |-
  The input did not match the regular expression /intentional fixture failure/.
  Input: 'Error: ephemeral PostgreSQL was not ready within 30s:
  Error: connect ECONNREFUSED 127.0.0.1:49856 ...
  database system is ready to accept connections'
# tests 61
# pass 60
# fail 1
```

The failure path removed its container. No repository file changed; a clean
standalone rerun passed 61/61, after which locale passed 1/1 and browser passed
5/5. The red is recorded as an environmental development result, not hidden or
counted as green.

In addition to the retained development reds above, the first two review
rounds exposed executable omissions before this matrix: removal of the fixed
unit inventory had weakened deletion detection, and a valid run-only YAML step
(`- run: ...`) was silently skipped. Those findings were corrected before this
run. The hard-tripwire review correctly showed that green did not settle the
parser design; the user's ruling now assigns dynamic truth to PR-4b and bounds
this candidate's static claim honestly.

## Review evidence

Every invocation was a new ephemeral, naive, read-only Codex session using
`gpt-5.6-sol` at xhigh effort. Each received only the frozen diff, owned paths,
green-gate counts, and its bounded charter; no session was resumed. Rounds 1–3
used the original charter below. Round 4 used the separately recorded
user-authorized exception charter. Round 5 used the post-tripwire ruling
charter, which explicitly forbade another static-parser hunt.

| Round | Frozen SHA | Verdict and disposition |
|---|---|---|
| 1 | `04e4be76693820df870e14f3c412ba6e055f0e5b` | **REVISE** — the filesystem was both expected set and command comparator, weakening PR-1's fixed unit inventory and allowing a deleted test to shrink both sides. **Fixed** in `1aa5780` by reviewed inventories for all five suites. |
| 2 | `1aa578087105bd64d195fd3e0dd5ad925f9bd624` | **REVISE** — a valid run-only workflow step (`- run: ...`) did not match the extractor and was silently skipped. **Fixed** in `7d506f5` with optional-list-marker parsing and a permanent workflow-level negative canary. |
| 3 | `7d506f54be1be12d0c5ceb5424a3a7c4ff45a365` | **REVISE** — Playwright config parsing rejects `projects`, `testIgnore`, and `testMatch`, but not `grep` or `grepInvert`; either option could select no tests from a file while the gate counts every file under `testDir`. **Fixed under the user's deliberate single-finding exception** by replacing the denylist with a TypeScript-parsed top-level allowlist and adding synthetic plus real-red canaries. |
| 4 | `7711a89758134b942e77a6a2277fcde05e393537` | **REVISE / HARD TRIPWIRE** — the Playwright fix and its demonstrations pass, and original questions 1–2 and 4–9 have no regression. `parseNodeTestCommand()` accepts `--test-name-pattern=...` but ignores its selection effect before marking every expanded file reachable. An honest globbed suite can therefore skip every test in a nonmatching file while the reachability gate stays green. **Resolved by the user's design ruling:** filtered commands now receive zero static credit, and PR-4b owns dynamic executed-file truth. |
| 5 | `f7296dcfd3139928f949832f7cdabecae5cf4a5d` | **PASS** — filtered commands receive zero credit, the permanent canary proves the real filtered locale command leaves its file unreachable until unfiltered PostgreSQL coverage is added, the packet states the static limitation honestly, PR-4b is queue row 2, and original questions 1–2 and 4–9 have no regression. No non-blocking PR-4b observations. |

Round 3 reported no other in-scope material findings: questions 1–2 and 4–9
passed, including direct byte comparison of all four archives. The user
authorized exactly one bounded correction and one fresh review. Any newly
identified fail-open reachability-parser surface is a hard stop for design
reconsideration, not another fix round.

Round 4 was a fresh ephemeral read-only `gpt-5.6-sol` invocation at xhigh
effort. It returned **REVISE** with exactly the hard-tripwire finding above and
modified no files. Per the user's explicit instruction, the writer did not
open another correction round.

### Post-tripwire design ruling

The user ruled that four fail-open surfaces in four rounds demonstrate a
structural mismatch: a static parser cannot completely model open-ended runner
selection. PR-4 therefore makes one final conservative change—any recognized
test-selection argument gives its command zero reachability credit—and records
the static gate's actual proof boundary. PR-4b is queue row 2 and will replace
this inference with the union of successful-suite reporter file events before
comparing against filesystem discovery. The final review is forbidden from
opening another static-parser hunt; further surfaces are observations owned by
PR-4b, not PR-4 REVISE findings.

Round 5 was a fresh ephemeral read-only `gpt-5.6-sol` invocation at xhigh
effort. It returned **PASS** with no findings, no PR-4b observations, and no
file modifications.

### Review charter

**Gates already green** — full CI matrix at the frozen SHA, listed above with
real counts. Do not re-derive what the tests prove.

**Threat model** — accidental omission by an honest developer or AI writer who
adds a test file, a suite, or a script that no CI command runs. NOT active
evasion, NOT a malicious author defeating the parser.

**In scope** — exactly these nine bounded questions:

1. Does every root `test:*` script that contains a glob quote it, and does an
   executable assertion fail if a future script reintroduces an unquoted glob?
   (Note the shell mangles the argument before Node sees it, so a
   `globSync`-vs-discovery comparison cannot catch this class.)
2. For each of the five suites, does the hygiene assertion independently
   discover its files and fail on a dropped file, an uncovered added file, and
   a zero-match pattern?
3. Is the reachability gate's reachable set derived from `ci.yml` plus the
   package scripts, and does it **hard-fail** — rather than silently skip — on
   any step, script body, or argument form it cannot parse?
4. Does the recorded demonstration show the reachability gate genuinely red on
   a real unreachable file (not only on a synthetic in-memory input), and is
   that file absent from the final tree?
5. Are `test:contracts` and `check:demo-release` genuinely invoked by a CI job
   step and required by the hygiene assertion, such that removing either from
   `ci.yml` turns a test red?
6. Do the three new `doctrine-coverage.md` rows claim only enforcement that
   actually exists, and does every plan `§` / ADR reference they cite resolve
   to real text in the repository?
7. Does the diff touch any product source, add any dependency, move any golden
   file / fixture / persisted digest other than the one authorized artifact, or
   weaken any pre-existing assertion?
8. The regenerated `apps/web/release/shell.compiled.json`: does the recorded
   parse-and-compare evidence show the drift confined to `releaseRoot` alone,
   is the root's movement explained by a named projection family and a named
   accepted packet, is `shell.authored.json` untouched, and do `format`,
   `check:demo-release`, and `test:contracts` all hold green together and stay
   stable across a second `format` run?
9. Are the four archived external review documents byte-faithful to their
   sources apart from whitespace normalization, with their provenance headers
   intact and no review body edited to agree with the repository?

**Out of scope (do not chase)** — PR-5 idempotency; PR-6 index coverage,
`EXPLAIN`, and runtime SLOs; product behavior of any kind; CI job topology,
caching, or runner choices; performance of the new tests;
adversarial-evasion hypotheticals against the parser; style and naming
preferences; the substance of the pending plan-level decisions; the content of
the unwritten documents that item 6 merely records as debt. Also out of scope:
auditing the compiler or release kernel itself (question 8 asks only whether
the root movement is *explained*, not whether the compiler is correct); the
technical merits of any finding inside the four archived review documents; and
whether `--check` ought to be byte-exact rather than parse-based — that gap is
recorded as debt by design.

**Verdict** — PASS / REVISE (in-scope material findings only) / BLOCK
(design-level). For each finding state the question it answers, the concrete
failure it enables, and the exact file:line.

### Authorized exception review charter

The fourth reviewer received the exact frozen SHA, owned paths, and green
matrix counts above, plus this bounded scope:

- confirm that the Playwright config now uses a top-level allowlist, rejects
  every unknown key or structural form with named text, treats `testDir` as the
  sole interpreted selector, and gives a correct selection-neutral reason for
  every other allowed current key;
- confirm the permanent unknown-key canary and the retained real `grep: /x/`
  red/green demonstration with no residue;
- identify any other concrete fail-open reachability-parser surface under the
  honest-omission threat model as a **hard tripwire**, naming the accepted form,
  omitted tests, and exact line, without proposing or performing a fix; and
- check only for regressions to original questions 1–2 and 4–9, all of which
  passed at `7d506f5`.

The threat model remained accidental omission by an honest developer or AI
writer, not malicious parser evasion. The out-of-scope list remained PR-5,
PR-6, product behavior, CI topology, parser performance, style, pending plan
decisions, compiler/release-kernel correctness, archived-review merits,
byte-exact demo checking, and a static-to-dynamic redesign unless the hard
tripwire fired. Verdicts remained PASS / REVISE / BLOCK with concrete failure
and file:line evidence.

### Final post-tripwire review charter

The fifth reviewer received the exact frozen SHA, owned four-file delta, green
matrix counts, retained transient PostgreSQL red, and the settled design ruling.
Its scope was limited to three questions:

1. filtered Node commands must contribute zero reachability without failing
   merely for being filtered; the permanent canary must report filtered-only
   coverage unreachable and prove `test:postgres` independently covers the
   real `test:locale` file;
2. this record must state the static proof boundary honestly, name reporter-
   based PR-4b as its closure, and place PR-4b at queue row 2 with the ruled
   rationale; and
3. the four-file delta must not regress original questions 1–2 or 4–9.

Further static-parser completeness review and PR-4b implementation were
explicitly out of scope. Any noticed parser surface could be only a non-blocking
PR-4b observation and could not change a PASS verdict.

## Test it yourself

From the repository root, the following takes under ten minutes and directly
falsifies the packet's central claim:

```bash
cd /home/rvham/2rain-greenfield
mkdir -p test/orphan-demo
printf "import test from 'node:test';\ntest('throwaway orphan', () => {});\n" > test/orphan-demo/orphan.test.ts
! corepack pnpm test:architecture
rm test/orphan-demo/orphan.test.ts
rmdir test/orphan-demo
corepack pnpm test:architecture
corepack pnpm check:demo-release
corepack pnpm test:contracts
```

The first architecture command must be red and name
`test/orphan-demo/orphan.test.ts`; the second must be green at 51/51. The two
compiled-shell commands, both red at `main` before PR-4, must be green, with
contracts at 6/6.

## Draft ledger row (do not commit to `ledger.md`)

```markdown
| PR-4 | Gate completeness round 2 + coverage audit | G2 corrective | Mechanical | evidence_ready | `f7296dcfd3139928f949832f7cdabecae5cf4a5d` | [packet](packets/PR-4.md); full CI matrix green at the exact frozen SHA after one retained transient PostgreSQL red and clean 61/61 rerun; filtered commands receive zero static reachability credit; `test:locale` is independently covered by unfiltered `test:postgres`; static proof is explicitly limited to files named by unfiltered commands; final fresh Codex `gpt-5.6-sol` xhigh PASS; PR-4b owns dynamic executed-file truth. |
```

## Checkpoint

The user's post-tripwire design ruling is implemented: filtered Node commands
receive zero static credit, the locale file remains independently covered, the
static limitation is explicit, and PR-4b is queued immediately next. The full
matrix is green at the frozen SHA and the final scoped review passed with no
findings or observations. PR-4 is acceptance-ready.

No program-review trigger fires. The dual-model G2-P3 whole-app review is still
current; this packet is a mechanical gate corrective, introduces no product
correctness domain or fan-out, and its systemic runner-evidence seam has an
explicit next packet. PR-4b, PR-5, and PR-6 remain unstarted pending user
acceptance and selection.

## PR-4b closure note

PR-4b superseded this packet's static selection inference with executed-file
evidence from successful declared suites. The PR-4 history and review table
remain the record of why inference was retired; the executable completeness
claim now belongs to `check:reachability` and
`docs/execution/packets/PR-4b.md`.
