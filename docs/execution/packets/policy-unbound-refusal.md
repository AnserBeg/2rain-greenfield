# policy-unbound-refusal — a declared permission no evaluator binds announces itself at compile time

Cut from `4218a66068041eb04e45e6fff4883c8aa8dfaebf` (`origin/main`) on branch
`packet/policy-unbound-refusal`, in the detached worktree
`/home/rvham/2rain-greenfield-pur` (the shared checkout is `ENUM-WIDEN`'s).
Tier: **Critical** — a compiler refusal that can stop a release. Evidence band:
**Band B, declared** — the failure this packet guards against is visible the
first time a release is built: `build:app-release` (and `--check` on unchanged
source) throws with the diagnostics in the message, naming the permission, and
the release script refuses a list with no key for its package before compiling. One discriminating recorded red per
claim, and the vectors not individually controlled are named below. (The
`lanes.md` row proposed Band C for the refusal itself; the charter said Band B,
and Band B is what is declared here.)

Program review 2026-08-20, finding **R7, small (a)**. The full authorization
kernel is queue row `7`, deferred by user ruling, and is NOT this packet.
Stops: **1** of the 2-stop cap — the bridge request after round 1's BLOCK,
granted by the user.

**STOPPED AND ROUTED after a THIRD BLOCK on the same class. This packet does
not proceed to round 4, and that is the correct outcome rather than a failure
of nerve.**

Three rounds, three BLOCKs, one defect wearing three coats — **absence read as
permission**:

| round | frozen | where absence lived | how it was read |
|---|---|---|---|
| 1 | `87878a6` | a missing **key** in the acknowledgement list | package not governed |
| 2 | `af1d603` | a missing **execution option** | compile not governed |
| 3 | `543b90c` | a missing **choice between two public entry points** | caller may select the ungoverned one |

**Round 3's own review named the routing condition this record wrote into its
prompt, and it was met.** The prompt said: *"If you find absence-means-ungoverned
a third time, say so plainly — that is the signal to route the class rather than
write round 4."* The reviewer found it, said so, and the lane is honouring its own
pre-commitment. `review-tiers` question 3 (**enumerating, not subsuming →
STOP and route**) and `mission-cadence`'s two-stop cap both point the same way.
Round 3's claim that its fix *subsumed* is **withdrawn**: it moved absence from
an option to an API choice, which is one level up, not one level out.

**The two findings that survive, verified by the lane before accepting them:**

1. **The ungoverned constructor is public.** `compileApplication` is exported
   from the package root, returns the same `CompileResult`, and an ordinary
   aliased import — `import { compileApplication as compileCurrent }` — mints a
   servable result ungoverned. **Measured:** the committed scan's regex does not
   match that call site, and does not match the import line either.
2. **The scan control was vacuous.** **Measured:** deleting its decisive
   `offenders.push(path)` line leaves the test **passing**. It violated
   `review-tiers`' "a committed control must die alone", so it is **removed
   rather than weakened** — a false instrument in the tree is worse than none.
   Its claim is withdrawn with it.

A third finding is accepted and not disputed: **the required acknowledgement is
structurally self-certifying.** Nothing in the contract distinguishes the
reviewed checked-in list from entries derived from the package's own census, and
two committed fixtures do exactly that derivation. "Required parameter" proves a
value was passed, never that it was *reviewed*.

**What is NOT withdrawn, because the reviewer verified it independently:** the
two checked-in release scripts *are* governed in their current forms, truncation
included, and no current-mode bypass exists in either. That is the increment
this packet actually earned, and it is real: today a declared permission absent
from the list refuses the release build by name.

Round 3's executable freeze is `17529cf8c8b80e97f287545a3b80782e95600fb9`.

**Frozen SHA: `543b90c471f7cda231beefe106d23ddaa48b3215`**, the tip that carries the
matrix result, the ledger and lane rows. Quoted from the remote at freeze time:

```
$ git ls-remote origin refs/heads/packet/policy-unbound-refusal
543b90c471f7cda231beefe106d23ddaa48b3215	refs/heads/packet/policy-unbound-refusal
```

The branch head is one commit above that SHA; its only content is this block,
the SHA filled into the rows and the review prompt, and the two gate results
measured at `543b90c`. The executable freeze is `17529cf`;
`FULL_MATRIX_PASS_SHA=17529cf8c8b80e97f287545a3b80782e95600fb9`.

## The finding

Every production `CurrentPolicyGateway` returns ALLOW — `AllowAllLocalPolicy`
in `composed-application-runtime.ts` and `VerificationAllowPolicy` in
`release-verification-service.ts`. Permission IDs compile into reference data
(`projections.ts`, `addFamily(constructs, packageRevision.permissions,
'permissionId')`) that nothing evaluates. Measured in this packet: the composed
application declares **65** permissions across the five mounted modules (party,
catalog, location, inventory, purchasing), every one bound to nothing, and the
sixth first-party module that declares permissions (`platform`) is not mounted
at all. The vacuum was silent: no gate, diagnostic or record said so.

## The two stop conditions, measured before anything was designed

**(1) Where does the acknowledgement live?** Three homes were measured and two
were refused by existing instruments:

- *A field on the canonical permission object* — a canonical-model schema
  change, therefore a language-version event under ADR-0021's rule that adding
  spellings retroactively widens an immutable language version. `packages/
  canonical-model/**` is outside the lease. **Not taken.**
- *A TypeScript constant inside the compiler* — `test/architecture/
  module-press-law.test.ts` (PRESS006) matches every `<entity>_{create,update,
  archive,restore,…}` local id and every operation local id as a whole word in
  generic press source, `packages/compiler/src/**` included. A constant naming
  `party_create` … `stock_count_update` would produce dozens of violations that
  the routed-debt table pins exactly. **Not taken, and the reason is the press
  law being right:** the generic press must not know module identity.
- *A compiler input passed by `compile-app-release.ts`* — every existing input
  field (`profile`, `limits`, `dependencies`, `expectedActiveRelease`) is hashed
  into `cacheInputDigest` or the manifest, so it would move the release root;
  adding a new field is `protocol.ts` / `compiler.ts` / `index.ts`, and
  `index.ts` and `protocol.ts` are in `ENUM-WIDEN`'s live diff. **Not taken.**

**Round 1 took a JSON data file beside the rule inside `packages/compiler/src`,
and the review rightly called that an evasion of the press law** — the file was
imported by production compiler code and decided admission, so it was press
configuration whatever its extension. **Round 2 takes the compiler-input home
without widening `CompilerInput`:** the acknowledgement travels through
`CompilerExecutionOptions.unboundPermissionAcknowledgement`, which is not part
of the hashed input and is hashed into nothing; the checked-in list lives beside
the release inputs it acknowledges, `apps/web/release/unbound-permission-acknowledgement.json`,
and the release scripts hand each package its own entries. The compiler now
holds **no module identity at all** — no compiler file imports the list. The
cost was one optional field on `CompilerExecutionOptions` in `protocol.ts`,
which is in `ENUM-WIDEN`'s live diff at other lines; the user granted the
bridge with *do whatever you need to fix this*, and the field sits in a block
that lane does not touch. No canonical byte moves.

**(2) Does the diagnostic or the list reach the compiled artifact?** No. A
diagnostic exists only on a failed compile, which mints nothing; the list is
read at validation time and is hashed into no release root, manifest, or
attestation. Measured at `209e3fc`: `check:app-release` and `check:demo-release` green, then
`build:app-release` rewrote `app.compiled.json` byte-identically and
`build:demo-release` rewrote `shell.compiled.json` differing only in JSON
indentation (the checked-in file is prettier-formatted and the demo script
writes `JSON.stringify(…, null, 2)`; that mismatch predates this packet, its
check compares parsed JSON, and the rewrite was reverted, not committed).
**No compiled artifact under `apps/web/release/**` changed; one new input file
was added there.** The
consequence is stated plainly: the acknowledgement is a build-time gate, not
an artifact fact — a release root says nothing about which list it was built
under.

## The mechanism — two entry points, and only one of them can mint

`validateUnboundPermissionAcknowledgement` in `packages/compiler/src/conformance.ts`,
called from `validateWholeModel` in `compiler.ts` **before** the version-gated
module-conformance cells, so it governs every language version the compiler
accepts (round 1 sat inside `validateModuleConformance`, which returns nothing
below `v2`; the v0 shell demo never reached it).

**The compiler exposes two current-mode entry points, and the difference between
them is the whole of round 3.**

| | `compileApplication` | `compileApplicationRelease` |
|---|---|---|
| acknowledgement | optional execution option | **required positional parameter** |
| governance runs | only when the option is supplied | **unconditionally** |
| omitting it | compiles (fixture semantics) | **does not compile — a type error** |
| nullish via a cast | n/a | refused, `COMPILER_PERMISSION_ACKNOWLEDGEMENT_INVALID` |
| who may call it | tests and fixtures only, asserted by a committed control | the release scripts |

**Why this was CLAIMED terminal, and why that claim is withdrawn.** Round 2's contract could be
satisfied by *saying nothing*, and saying nothing is what a forgetful caller
does. Round 3's release contract cannot be satisfied by saying nothing: there
is no value of "omitted" for a required parameter, so a new release path that
forgets governance **fails to compile** rather than building green. **But the door beside it is still open, and that is what the third review
blocked on:** `compileApplication` is exported from the package root and an
ordinary aliased import reaches it. The scan that was supposed to close this is
removed — it matched an identifier spelling rather than a resolved binding, and
it passed with its own decisive line deleted. **So the accurate statement is:
a caller that has chosen `compileApplicationRelease` cannot forget governance;
nothing prevents a caller from choosing the other function.**

**Why `compileApplication` keeps its optional option, stated as a cost rather
than a virtue.** It is the fixture entry point. Making governance mandatory for
*every* current-mode compile was measured first, not predicted: it reds **85 of
174** compiler tests and **27 of 155** unit tests, a ~46-file change across
`test/postgres/**`, `test/integration/**`, `apps/web/test/**` and
`test/fixtures/**`, several of them held by other live lanes. Against that,
**exactly two production call sites exist**, both already governed. The
required-parameter design buys a strictly stronger guarantee than the naive one
for a fraction of the blast radius — but it is honest that a *fixture* compile
of a permission-bearing package is still ungoverned, and that this is safe only
because production cannot reach that door.

The rule itself is unchanged from round 2 and still holds:

- **Census:** `packageRevision.permissions` of the normalized package — never
  source text. Every lifecycle.
- **Bound set:** `EVALUATOR_BOUND_PERMISSION_IDS`, **empty by construction**,
  with the comment naming row `7` as what populates it.
- **Subject explicit:** `packageId` must equal the compiled package's id, and
  the value must be exactly `{packageId, entries[{permissionId, resource}]}`,
  or the compile refuses with `COMPILER_PERMISSION_ACKNOWLEDGEMENT_INVALID`.
- **`COMPILER_PERMISSION_EVALUATOR_UNBOUND`**: a declared permission not in the
  bound set and not acknowledged.
- **`COMPILER_PERMISSION_ACKNOWLEDGEMENT_STALE`**: an entry naming a permission
  the package does not declare, an entry whose resource disagrees, an entry for
  a bound permission, a duplicate.
- **Row `7` empties the list.** At zero entries the refusal is absolute.

**Truncation, decided rather than excepted.** `--truncate-invalid-lineage`
recompiles RECORDED bytes under current conformance, and round 2 passed those
compiles nothing. They are now governed by the checked-in list **narrowed to
that revision's own declared census** (`narrowAcknowledgementToDeclared`).
Narrowing can only remove, never invent, so it cannot certify a revision
against itself: a permission the revision declares that the list does not name
is simply absent from the narrowed set and is refused as **unbound** — which is
the correct answer for a recorded release that declared a permission nothing
ever acknowledged. Entries the revision does not declare are filtered out, so
today's newer list does not report an older revision as stale.

**A recorded entry may belong to a package the list does not key at all** — a
lineage's invalid suffix routinely does, which is what truncation exists to
drop. Truncation must be able to JUDGE such an entry rather than die on it, so
recorded entries read through `readRetainableAcknowledgementFor`, which returns
an **empty** acknowledgement for an unlisted package. That is stricter at that
entry than throwing, not weaker: every permission it declares is unacknowledged,
its compile is refused as unbound, and truncation drops it and everything after
— while a revision declaring no permissions is retained, which is correct. The
head loader still throws, because a head whose package is unlisted must stop the
build. **This was found by the pre-existing truncation control, not by the
lane**, when round 3 first routed every truncation compile through the list. The three
compiles this script performs therefore have three honest acknowledgements: the
authored head gets the list unnarrowed (its census must be complete), the
bootstrap gets an explicitly empty one (it declares no permissions by
construction), and a recorded revision gets the narrowed one.

**What "the list can only shrink" means, precisely.** The compiler enforces a
**snapshot invariant**: every entry handed to it is true of the package in front
of it, and every unbound declared permission is named. It does not enforce
repository-history monotonicity — adding a newly declared permission to the list
compiles, by design, and *Test it yourself* step 2 does exactly that. Shrinking
is the review policy over the checked-in file, written in its header, and row
`7` is what drives it.

**The list and its loader.** `apps/web/release/unbound-permission-acknowledgement.json`
sits beside the release inputs it acknowledges, keyed by package id: **65**
entries for `northstar.app:package.application` and **1** for
`northstar.shell:package.demo`. `apps/web/scripts/unbound-permission-acknowledgement.ts`
reads it **strictly** — exactly the keys `header`, `packages`, `schemaVersion`;
a non-empty header; entries exactly `{permissionId, resource}` with non-empty
strings — and throws before any compile when the requested package has no key.
The path is derived from the release input's directory, so the
`NORTH_STAR_APP_AUTHORED_PATH` override the tests use redirects the
acknowledgement with the input.

## Controls

Fifteen tests in `test/compiler/g2-module-conformance.test.ts` (the sixteenth,
the production-caller scan, was **removed at the stop** — it was vacuous under
deletion). Thirteen carry the prefix `unbound-permission acknowledgement:`, two carry `unbound-permission
release script:` and spawn the real `compile-app-release.ts --check` against a
temp copy of the release inputs.

| test | claim it holds |
|---|---|
| the unchanged composed application builds under its acknowledgement, which is exactly its declared census | admission twin through the real loader and compiler; entries equal the declared census with no duplicates |
| **the release entry point governs unconditionally, so casting around its required parameter is refused rather than ungoverned** | **round 2's finding closed at the compiler:** `undefined`, `null` and `{}` forced past the type each refuse by the package's name, and the real acknowledgement still admits |
| **a recorded revision is governed by the list narrowed to its own census, which can only shrink it** | truncation decided rather than excepted; narrowing never invents an entry |
| **a recorded revision from an unlisted package is judged unretainable, not crashed on** | the head loader still throws; the retainable reader returns empty, and an empty acknowledgement refuses every declared permission by name |
| a permission the composed application declares and nothing acknowledges refuses the release by name | the core refusal, through the real compiler on the real composition |
| the rule runs at language v0 too — the shell demo builds and refuses by name | round 1's finding 2 closed |
| removing the acknowledgement of a permission the package still declares refuses it by name | the unbound half at the rule level |
| an entry naming a permission the package does not declare is stale, whether or not its resource exists | the list cannot rot |
| an entry whose resource disagrees with the declaration is stale | a re-pointed permission re-announces itself |
| a permission an evaluator binds leaves the list, and stays listed only as rot | the shrink direction row `7` drives |
| a duplicated entry is stale | the list carries nothing twice |
| an acknowledgement for another package, or an unreadable one, fails closed | subject mismatch and nine malformed shapes each refuse |
| the checked-in document is read strictly and a package with no key is refused before any compile | nine malformed documents throw; a missing key throws by package name |
| release script: `check:app-release` on an untouched copy of the inputs is green | the real script, real inputs, real list: admission |
| release script: a list with no key for the composed package makes `check:app-release` refuse before compiling | the build itself refuses a one-character key typo |

## Expected-red manifest — the recorded reds

`test/evidence/policy-unbound-refusal.expected-red.json`, **nine** entries, each
varying one property.

| entry | mutation | measured |
|---|---|---|
| `unbound-check-removed` | `conformance.ts`: a bare `continue` at the top of the unbound branch | 4 killed at `17529cf` |
| `governance-wiring-removed` | `compiler.ts`: the whole-model condition made unreachable, defeating both the `required` arm and the supplied arm without touching fixture semantics | 4 killed at `17529cf` |
| **`release-governance-made-optional`** | `compiler.ts`: `compileApplicationRelease` downgraded to the caller-supplied contract — **round 2's exact fail-open defect, restored on purpose** | 1 killed at `17529cf` |
| **`recorded-revision-narrowing-removed`** | the loader: narrowing returns the list unnarrowed, so a recorded revision is judged against today's census | 1 killed at `17529cf` |
| `subject-check-removed` | `conformance.ts`: the subject compared against itself | 1 killed at `17529cf` |
| `stale-check-removed` | `conformance.ts`: the stale membership test keyed on the acknowledgement instead of the declared census | 1 killed at `17529cf` |
| `acknowledgement-entry-removed` | the list: the `party_create` entry deleted | 4 killed at `17529cf` |
| `stale-entry-added` | the list: an entry for `stock_count_probe_stale` appended | 3 killed at `17529cf` |
| `governed-package-key-renamed` | the list: the composed package key misspelled by one character | 6 killed at `17529cf` |

The admission twin is measured by the runner itself: every entry's population
must pass with production restored before the mutation is applied.

**Vectors NOT individually controlled, and why.** (a) The domain-edit route is
exercised by hand in *Test it yourself*, not by a manifest entry: a mutation of
a file outside this lease would couple the manifest's `original` text to a file
the next module packet will edit. (b) The production-caller scan is proven
non-vacuous by its own positive assertion (it finds both governed callers)
rather than by a mutation, because the realistic defect — a new release script
calling `compileApplication` — cannot be simulated by changing one property of
an existing file: that file does not import the ungoverned entry point, so the
mutation would red with a `ReferenceError`, the wrong reason. (c) The
"bound permission stays listed", "duplicate entry" and parser-clause branches
are tested, not mutated; Band B is one discriminating red per claim, not per
branch. (d) The truncation path's end-to-end behaviour is not exercised by any
test — only its narrowing helper is. Stated, not hidden.

## What this packet does NOT claim — rewritten at the stop

**Narrowed to what was measured, per `review-tiers`' stop procedure. Every
sentence a reviewer refuted is withdrawn rather than softened.**

**WHAT IT DOES CLAIM, and what the third reviewer independently confirmed:**
the two checked-in release scripts are governed in their current forms —
`compile-app-release.ts` in all four modes and `compile-demo-release.ts` — and
**no current-mode bypass exists in either**. A declared permission absent from
`apps/web/release/unbound-permission-acknowledgement.json` refuses the release
build by name, today, and `check:app-release` refuses a list with no key for its
package before compiling. Narrowing for recorded revisions is sound and cannot
self-certify; empty-for-unlisted is genuinely stricter.

**THE THREE LIMITS, stated where a reader will hit them:**

1. **The ungoverned constructor is public and reachable by ordinary code.**
   `compileApplication` is a package-root export returning the same
   `CompileResult`. `import { compileApplication as compileCurrent }` mints a
   servable result with no acknowledgement, needing no cast and no trickery.
   **Nothing in the tree prevents or detects this** — the control that claimed
   to was removed at the stop for being vacuous.
2. **The required parameter proves a value was passed, never that it was
   reviewed.** The acknowledgement is a plain structural object, so a release
   path can derive it from the package's own census and satisfy the contract
   tautologically, absorbing every new permission without a list change anyone
   reads. **Two committed fixtures implement exactly that pattern**, which is
   how ordinary it is.
3. **The truncation route runs but does not discriminate.** The pre-existing
   v0-prefix control executes `--truncate-invalid-lineage`, but its retained
   revision's acknowledgement is generated from its own complete census and its
   invalid suffix declares zero permissions and fails a different rule — so
   removing governance or narrowing would not change its outcome. The narrowing
   helper is controlled directly; **its call-site wiring is not.** An earlier
   version of this record and its review prompt presented that control as
   end-to-end evidence. It is not, and that presentation is withdrawn.

**Also true and unchanged:** it authorizes nothing (row `7` is the kernel); a
FIXTURE compile of a permission-bearing package is ungoverned by design; the
`platform` module is unmounted; the acknowledgement is hashed into no artifact;
`historicalReproduction` skips whole-model validation by design; and
`check:app-release` on changed source refuses as *stale* before any candidate
compile.

**`release-governance-made-optional` proves runtime fail-closed behaviour, not
type-level requiredness.** Making the parameter optional while leaving the
internal mode `required` would keep every committed test green. The claim is
narrowed accordingly.

## THE ROUTED CLASS — what a successor charter must own

**Filed as one line in the archive's *Filed during the freeze* table; promotion
to a critical-path row is the user's ruling, not the lane's.** The class is not
"add another scanner case". It is a boundary the reviewer stated, and it is
recorded here verbatim as the design criterion a successor must satisfy:

> Production code cannot obtain a servable current `CompileSuccess` through any
> package-exported operation unless it presents **non-self-certifying**
> governance; fixture compilation is unavailable through production imports.
> Symbol-aware controls and alias/wrapper negative specimens may verify that
> boundary, but **they must not be the boundary**.

**What that implies, so the successor does not rediscover it:** the seam is the
compiler package's **public export surface** and the **provenance** of an
acknowledgement — not the current caller list. Candidate shapes the lane
considered and did not attempt, each with its measured cost:

- **Stop exporting the ungoverned constructor** from the package root, leaving
  fixtures to import it by deep path. Touches how ~46 test files import; the
  measurement that made this packet choose otherwise is that mandatory
  governance for every current-mode compile reds **85/174** compiler and
  **27/155** unit tests.
- **Give the acknowledgement provenance the compiler can check** — a digest of
  the reviewed document carried into the input — so a census-derived object no
  longer satisfies it. This is the honest answer to limit 2 and it is a real
  design question, not a patch.
- **Discriminating truncation evidence:** an older permission-bearing revision
  whose census is a strict subset of today's list, followed by an otherwise-valid
  revision adding one permission the list omits. The reviewer wrote this
  specimen out; it belongs in the successor.

## Round 2 review and what changed

Round 2 froze at `af1d603` and returned **BLOCK**. Both findings are accepted in
full; neither was disputed.

1. **Current-mode permission governance remained fail-open on omission
   (Critical, production).** Confirmed in the source before acting: the option
   was optional, `validateWholeModel` ran the rule only when it was present, the
   lane's own test asserted a permission-bearing package compiles without one,
   and `--truncate-invalid-lineage` passed `undefined` for every recorded
   revision that was not today's bytes. **Closed** by the required-parameter
   release entry point, unconditional governance on that path, the
   production-caller scan, and narrowed per-revision evidence for truncation.
   The test that codified the bypass is replaced by two that refuse it.
2. **Evidence did not prove that all release paths preserve the handoff
   (Medium, control and prose).** Accepted. With the release entry point
   required, deleting a handoff is now a type error rather than a green build,
   which is what the reviewer said would make this gap non-consequential. The
   demo script's handoff is additionally covered by the production-caller scan.

The reviewer also judged the round-2 prompt to have steered — it framed
compiler-level absence as acceptable and the two scripts as the only callers
that matter, while one mode of one of those scripts took the bypass. That
framing is withdrawn; this record states the fixture gap as a cost rather than a
virtue, and the round-3 prompt below asks the reader to test the boundary rather
than accept it.

## Round 1 review and what changed

Round 1 froze at `87878a6` and returned **BLOCK**. Dispositions, each as a
claim the round-2 reviewer may test:

1. **Missing key or vanished entity ungoverned the release (Critical, production).**
   Closed. The subject is explicit and checked; absence is a fact about the
   caller's code, never about a list key; stale ignores entity presence; the
   release scripts' loader throws before compiling when the package has no key;
   a spawned `--check` proves the real script refuses a one-character typo.
2. **v0/v1 bypass (High, production).** Closed. The rule runs from
   `validateWholeModel` before the version gate, and the v0 shell is governed
   and tested.
3. **JSON in the compiler is a press-law evasion (High, architecture).**
   Accepted. The list moved under `apps/web/release/`, the compiler imports
   nothing module-specific, and the record no longer argues the point.
4. **`check:app-release` overclaim (Medium, prose).** Corrected above.
5. **"Exact shape" and "only shrink" overstated (Low, prose and parser).**
   The compiler validates exact shape now (extra keys refuse); the loader
   validates the exact document; "only shrink" is stated as the snapshot
   invariant plus a review policy.

## Gates and SHAs

Round 3, at the executable freeze `17529cf`. Rounds 1 and 2 kept their own
gate histories in the record at `87878a6` and `af1d603`; round 2's matrix passed
at `afe67f7` and is superseded.

| gate | result |
|---|---|
| `format`, `typecheck`, `lint`, `check:boundaries` | green |
| the sixteen packet tests, run alone | 16/16 |
| `check:app-release`, `check:demo-release` | green; `build:app-release` rebuild byte-identical |
| `check:expected-red` | OK, 71 entries in 7 manifests |
| `evidence:expected-red` (this packet's nine entries, `--run`, exclusive lock) | OK, 9 expected reds reproduced and restored at `17529cf`; 14 tests passing with production restored before each mutation; kill counts 4, 4, 1, 1, 4, 3, 6, 1, 1 |
| full matrix (`run-matrix.sh policy14`, detached worktree at `17529cf`) | **PASS — `FULL_MATRIX_PASS_SHA=17529cf8c8b80e97f287545a3b80782e95600fb9`**, first attempt: performance 5/5, unit 155/155, compiler 173/173, integration 149/149, agent 3/3, architecture 189/189, contracts 29/29, PostgreSQL 223/223, locale 1/1, browser 93/93, observability producer 11/11, language coverage PASS (2050 obligations), reachability 106/106, security scans passed, schema 23 migrations verified, both release checks green, expected-red validation and its 38 self-test controls green as matrix stages |
| `test:architecture` and `format` re-run at the narrative head, round 3 `543b90c` and again at the STOP `07c4d30` | architecture **189/189**, prettier clean — the two suites that read narrative, re-run past the docs commit per `git-workflow`; `git diff --name-only 17529cf 543b90c` outside `docs/` is empty, so every other suite carries forward |
| `scripts/check-records.sh` at `543b90c` and at the STOP `07c4d30` | `records: OK (138 record(s), 6 declaring: 55 claimed path(s) and 79 claimed symbol(s) observed in their frozen trees; 159 ledger row(s), ids unique)` |

**Five intermediate reds are recorded rather than hidden, because every one was
an instrument doing its job.** At `87496a9` the `governance-wiring-removed`
mutation killed an undeclared victim — inverting the condition also flipped the
FIXTURE path, so the census control died; the mutation was narrowed to vary one
property. At the same SHA the pre-existing `--truncate-invalid-lineage` control
failed with *names no entries for package `northstar.partial:package.fixture`*,
which is the unlisted-recorded-package gap described above — a real
behavioural question the lane had not seen, found by a control it did not write.
Then the expected-red runner refused the manifest three times in a row: two
declared kills whose reason did not match the assertion that actually dies
first, and three list mutations that reach more controls than the entries
declared. Each was a manifest or assertion correction, not a production change;
the last production commit is `68eaa2a`. **The runner's "every outcome the
mutation produces must be accounted for" clause is what forced all three, and
it is the reason this packet's kill sets are exact rather than approximate.**

## Declaration

The last executable commit is `8a6ad4f838fa25b49fc8d54e64a132c9f31bcb22` — **the STOP commit**,
which removes the vacuous control and is therefore executable, not narrative.
`17529cf` is the matrix-green SHA below it and the one the ledger records. Round 3's executable commits are `87496a9` (the release
entry point, the production-caller scan, narrowing), `f099fbb` (the wiring
mutation narrowed to one property) `68eaa2a` (truncation judges an
unlisted recorded package instead of crashing), `e1eed38`, `9d3f488` and
`17529cf` (three passes declaring every control the mutations reach and
giving each assertion the reason it dies for). Rounds 1 and 2's commits are
their ancestors; `packages/compiler/src/unbound-permission-acknowledgement.json`
existed only between `1f6eca2` and `209e3fc` and is in no path of this range.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "policy-unbound-refusal",
  "base": "4218a66068041eb04e45e6fff4883c8aa8dfaebf",
  "head": "8a6ad4f838fa25b49fc8d54e64a132c9f31bcb22",
  "changedPaths": [
    "apps/web/release/unbound-permission-acknowledgement.json",
    "apps/web/scripts/compile-app-release.ts",
    "apps/web/scripts/compile-demo-release.ts",
    "apps/web/scripts/unbound-permission-acknowledgement.ts",
    "packages/compiler/src/compiler.ts",
    "packages/compiler/src/conformance.ts",
    "packages/compiler/src/diagnostics.ts",
    "packages/compiler/src/index.ts",
    "packages/compiler/src/protocol.ts",
    "test/compiler/compiler-semantic-profile.test.ts",
    "test/compiler/g2-module-conformance.test.ts",
    "test/evidence/policy-unbound-refusal.expected-red.json",
    "test/postgres/composed-application.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/compiler/src/compiler.ts",
      "name": "compileApplicationRelease"
    },
    {
      "path": "packages/compiler/src/compiler.ts",
      "name": "validateWholeModel"
    },
    {
      "path": "packages/compiler/src/conformance.ts",
      "name": "validateUnboundPermissionAcknowledgement"
    },
    {
      "path": "packages/compiler/src/conformance.ts",
      "name": "EVALUATOR_BOUND_PERMISSION_IDS"
    },
    {
      "path": "packages/compiler/src/protocol.ts",
      "name": "UnboundPermissionAcknowledgementInput"
    },
    {
      "path": "packages/compiler/src/diagnostics.ts",
      "name": "COMPILER_DIAGNOSTIC_COPY"
    },
    {
      "path": "apps/web/scripts/unbound-permission-acknowledgement.ts",
      "name": "readUnboundPermissionAcknowledgementFor"
    },
    {
      "path": "apps/web/scripts/unbound-permission-acknowledgement.ts",
      "name": "readRetainableAcknowledgementFor"
    },
    {
      "path": "apps/web/scripts/unbound-permission-acknowledgement.ts",
      "name": "narrowAcknowledgementToDeclared"
    },
    {
      "path": "test/compiler/g2-module-conformance.test.ts",
      "name": "composedPermissionCensus"
    },
    {
      "path": "test/postgres/composed-application.test.ts",
      "name": "writeAcknowledgementBeside"
    }
  ]
}
```

## Test it yourself (under ten minutes, no diff reading)

From the repository root on branch `packet/policy-unbound-refusal`, with
`corepack pnpm install --offline` done. The release build reads the checked-in
`apps/web/release/app.authored.json`, which `generate-app-authored.ts` derives
from the domain — so every domain edit below is followed by the generator.
The lane ran this exact sequence at `c9062f5` (round 1) and again at `209e3fc` (round 2, same observations except the list's path; nothing executable that the sequence touches changed in `5de9f1f` or `afe67f7`, which are test-only) and recorded what it saw.

1. **Watch the refusal name the permission.** Append one permission to the
   Party module and rebuild the release input and the release:

   ```bash
   python3 - <<'PY'
   from pathlib import Path
   p = Path('packages/domain/src/party/definition.ts')
   s = p.read_text()
   anchor = "      ...entityPermissions(definitionIds, 'party_role', entityIds.role),\n"
   assert s.count(anchor) == 1
   s = s.replace(anchor, anchor + "      {\n        action: 'read',\n        kind: 'permissionDefinition',\n        label: 'party export',\n        permissionId: `${namespace}:permission.party_export`,\n        resource: { kind: 'entityReference', schemaVersion: version, targetId: entityIds.party },\n        schemaVersion: version,\n      },\n")
   p.write_text(s)
   PY
   node --import tsx apps/web/scripts/generate-app-authored.ts
   corepack pnpm --filter @north-star/web build:app-release
   ```

   Observed: exit 1, `composed application release did not compile: [...]`,
   and the one diagnostic in the message is
   `"code":"COMPILER_PERMISSION_EVALUATOR_UNBOUND"` with
   `"subjectId":"northstar.app:permission.party_export"`.
   `apps/web/release/app.compiled.json` is untouched (only
   `app.authored.json` is modified).

2. **Acknowledge it and watch the build pass.** Append
   `{ "permissionId": "northstar.app:permission.party_export", "resource": "northstar.app:entity.party" }`
   to the composed package's array in
   `apps/web/release/unbound-permission-acknowledgement.json`
   and run the same build command. Observed: exit 0, and
   `app.compiled.json` now carries **16** lineage entries against **15** at
   `HEAD` — the ordinary authored-source axis appending an entry, not this
   packet's list.

3. **Watch the list refuse to rot.** Put the domain back, regenerate, keep
   the entry from step 2, build:

   ```bash
   git checkout -- packages/domain/src/party/definition.ts
   node --import tsx apps/web/scripts/generate-app-authored.ts
   corepack pnpm --filter @north-star/web build:app-release
   ```

   Observed: exit 1 with `"code":"COMPILER_PERMISSION_ACKNOWLEDGEMENT_STALE"`
   and `"subjectId":"northstar.app:permission.party_export"`.

4. **Restore.**

   ```bash
   git checkout -- apps/web/release/
   corepack pnpm check:app-release
   ```

   Observed: `git status` clean, `check:app-release` exit 0.

5. **Watch the build refuse a one-character key typo, before compiling.**
   Change `"northstar.app:package.application"` to
   `"northstar.app:package.applicatio"` in the list and run
   `corepack pnpm check:app-release`. Observed: exit 1,
   `unbound-permission acknowledgement at … names no entries for package
   northstar.app:package.application; a release build cannot proceed
   ungoverned`. Restore with `git checkout -- apps/web/release/`.

## Disposition — the green half is offered for integration; the seam is routed

**Ruled by the user's delegation on 2026-09-04 ("do whatever you think is
best"), and the ruling follows `mission-cadence`'s own stop procedure rather
than the lane's preference:** *"On the third stop… land what is already green as
its own reviewable increment, and move the unfinished seam into a charter of its
own with the discovered constraints written in from the start."* Holding the
branch contradicts that and risks the parked-work rot `mission-cadence` records;
discarding throws away a refusal the third reviewer independently confirmed
works. So: **the narrowed increment is offered for integration, and the boundary
is routed.**

**The lane does not and cannot accept it.** A Critical packet with three BLOCKs
and no PASS cannot be accepted — `review-tiers` is explicit that a Critical
result without its arm stays `evidence_ready`, that waiting is the correct
outcome, and that self-review is not. The lane has therefore prepared the
increment and stopped.

**Integration facts, measured at the stop rather than predicted:**

- `main` advanced **7 commits** since the cut. A trial merge of this branch onto
  current `main` produces conflicts in **exactly three files** —
  `docs/execution/{ledger,lanes,current-plan-archive}.md` — the ordinary
  multi-lane bookkeeping merge, resolved by keeping both lanes' rows.
- **No executable conflict**, including `packages/compiler/src/protocol.ts` and
  `index.ts`, which ENUM-WIDEN also touches: the hunks are disjoint.
- Integration owes a **fresh full matrix at the integrated SHA**, because the
  stop commit changes executable content (one test removed) and because `main`
  moved.

## No boundary review arm is written, and that is deliberate

Three arms have converged on one class and the third named the routing
condition. A fourth arm asked to re-examine a boundary the lane has already
conceded is wrong is the spiral `review-tiers` exists to prevent. **Nothing in
this record should be read as inviting one.**

**One much smaller arm IS owed and is written below.** It does not ask whether
the boundary is right — that question is routed and its criterion is recorded
above. It asks the only question that stands between this increment and
integration: **do the narrowed claims now match the tree?** That is a
verification of a record against measurements, not a redesign, and it is the
question the previous version of this section already named as the appropriate
remaining one.

## Review prompt — the NARROWED-CLAIM arm; paste as written; the lane fenced nothing

Review packet `policy-unbound-refusal` at its STOP, in `/home/rvham/2rain-greenfield` (or any fresh clone of `origin`). Read `AGENTS.md`, then `.agents/skills/review-tiers/SKILL.md` — "Does the evidence prove the claim?", "A committed control must die alone", "Convergence", "After two rounds of a claim exceeding its proof, narrow the claim" — then `docs/execution/packets/policy-unbound-refusal.md` in full, then the diff.

This prompt was written by the lane whose work you are reviewing. The lane has fenced nothing. Any scope stated here stands as a claim under test rather than a limit you may not question. Say plainly if you think the scope is drawn wrongly, and say plainly if the prompt itself is steering you.

**THIS IS NOT A FOURTH ROUND OF THE BOUNDARY REVIEW.** Three arms returned BLOCK on one class — absence read as permission, at three levels — and the third named the routing condition the lane had written into its own prompt. The lane honoured it: it stopped, removed a vacuous control rather than replacing it, withdrew every refuted claim, and routed the class with the third reviewer's design criterion recorded verbatim. **The boundary question is settled as ROUTED. Re-opening it is not what this arm is for** — though if you believe routing was the wrong disposition, say so, because that is a judgement the lane made about its own work.

**The decisive question is narrower: does the record now claim exactly what the tree supports — no more, and no less?**

TARGET. Branch `packet/policy-unbound-refusal` on `origin`. **The frozen tree for this arm is `07c4d3017c6ea316054271b001fd88ccfc1ee49e`.**

A quoted `git ls-remote` line would be stale before you read it: every pin commit moves the head, and this record has been re-pinned twice. So verify it yourself instead, which is stronger:

```
git fetch origin
git diff --name-only 07c4d30..origin/packet/policy-unbound-refusal
```

That must list **only** `docs/execution/packets/policy-unbound-refusal.md` — every commit above the frozen SHA contains this record's pin text and nothing else. If it lists anything more, the freeze is not what this prompt says it is, and that itself is a finding.

The last executable commit is `8a6ad4f838fa25b49fc8d54e64a132c9f31bcb22` — the STOP commit, which removes a test and is therefore executable. `17529cf8c8b80e97f287545a3b80782e95600fb9` is the matrix-green SHA below it. Base is `4218a66068041eb04e45e6fff4883c8aa8dfaebf`. Read `4218a66..07c4d30`, and read the round-3 review's findings as dispositioned in the record. Rounds 1, 2 and 3 are preserved at `87878a6`, `af1d603` and `543b90c`.

WHAT THE LANE MEASURED AT THE STOP, each offered for you to reproduce.
1. The removed control was vacuous: deleting its `offenders.push(path)` line left the test PASSING.
2. Its scan missed an ordinary alias: the regex matched neither `compileCurrent(...)` after `import { compileApplication as compileCurrent }`, nor the import line.
3. The nine expected reds still reproduce at the stop SHA with their exact kill sets: 4, 4, 1, 1, 4, 3, 6, 1, 1 killed respectively, `expected-red: OK (9 expected red(s) reproduced and restored)` at `389a8d4`, on a clean tree.
4. `test:compiler` is 172/172 at the stop SHA; format, lint, typecheck, `check:expected-red` and `check-records.sh` are green.
5. A trial merge onto current `main` conflicts in three narrative files only; no executable conflict.

THE CLAIMS THE RECORD NOW MAKES, which are what you are testing.
- Both checked-in release scripts are governed in their current forms, truncation included, with no current-mode bypass. (The round-3 reviewer asserted this independently; the lane did not.)
- Three limits, stated plainly: the public ungoverned `compileApplication` is reachable by an aliased import; the required acknowledgement is structurally self-certifying and two committed fixtures derive one from the census; the truncation control runs without discriminating.
- `release-governance-made-optional` proves runtime fail-closed behaviour, NOT type-level requiredness.
- The routed class carries the boundary, with the criterion recorded verbatim.

DECISIVE QUESTIONS.
A. **Is any claim still wider than its evidence?** Read the record against the tree and name every sentence that outruns what is measured. This is the whole point of the arm.
B. **Is any real limit missing from the three?** The lane found these by being told. Is there a fourth a reader would hit and not be warned about?
C. **Is removing the vacuous control the right disposition**, or does deleting it leave the tree worse than a weakened version would have? The lane judged that a false instrument is worse than none and that any replacement would be a fourth boundary attempt.
D. **Is the increment safe to integrate as a partial boundary** — that is, could a reader of this record over-trust it? If yes, say what the record must add.
E. Does the diff contain anything the stop did not need?

OUT OF SCOPE, stated as the lane's claim rather than a fence: redesigning the governance boundary (routed, with its criterion in the record); the authorization kernel (row 7); `packages/canonical-model/**` and `packages/domain/**`.

VERDICT FORMAT. PASS, REVISE or BLOCK on the NARROWED claims, then findings ranked by severity with file and line at the frozen SHA, and for each: whether the defect is in production, in a control, or in the claim's prose. **A PASS here means "the record is honest and the increment may integrate with its limits declared" — it does NOT mean the boundary is closed.**
