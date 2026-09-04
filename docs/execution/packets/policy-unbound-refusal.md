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

**ROUND 3 — re-frozen after a second BLOCK, and this round SUBSUMES rather
than sits beside.** Round 1 froze at `87878a6` and was blocked on two
production findings; round 2 froze at `af1d603` (executable `afe67f7`, matrix
green) and was blocked on one. **Both blocks were the same defect wearing a
different coat: an absent admission input silently meant "not governed".**
Round 1 read a missing key in a list that way; round 2 read a missing execution
option that way, and its own `--truncate-invalid-lineage` path took the bypass
on every recorded revision. The lane's round-2 record named that bypass as a
limit, and the reviewer was right that naming a live bypass does not make the
invariant true.

**The criterion that licenses a third round, named as `review-tiers` requires
from round three onward.** Question 1: the defect is **in production** →
CONTINUE. Question 3 is the honest one: rounds 1 → 2 were **ENUMERATING**, and
that alone would say STOP and route the class. Two things override it. The
first is `review-tiers`' own blast-radius override, which names this exact
class — *"a permission that is declared and unreachable … keep going."* The
second is that round 3's fix is **subsuming and terminal**, not another
instance: it does not move absence somewhere new, it makes absence
**unrepresentable** on the path that mints. `review-tiers`, "prefer
unrepresentable to detectable." If a fourth round finds absence-means-ungoverned
again, the charter is wrong and the class must be routed.

Round 3's executable freeze is `17529cf8c8b80e97f287545a3b80782e95600fb9`.

{{FREEZE_BLOCK}}

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

**Why this is terminal where round 2 was not.** Round 2's contract could be
satisfied by *saying nothing*, and saying nothing is what a forgetful caller
does. Round 3's release contract cannot be satisfied by saying nothing: there
is no value of "omitted" for a required parameter, so a new release path that
forgets governance **fails to compile** rather than building green. The one
remaining way to reach an ungoverned compile — calling `compileApplication`
from production — is closed by a committed control that scans every source
under `apps/` and `packages/` (excluding the compiler package, which defines
both) and fails if any of them calls it. Forgetting is a type error; reaching
for the ungoverned door is a red test.

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

Sixteen tests in `test/compiler/g2-module-conformance.test.ts`. Fourteen carry
the prefix `unbound-permission acknowledgement:`, two carry `unbound-permission
release script:` and spawn the real `compile-app-release.ts --check` against a
temp copy of the release inputs.

| test | claim it holds |
|---|---|
| the unchanged composed application builds under its acknowledgement, which is exactly its declared census | admission twin through the real loader and compiler; entries equal the declared census with no duplicates |
| **the release entry point governs unconditionally, so casting around its required parameter is refused rather than ungoverned** | **round 2's finding closed at the compiler:** `undefined`, `null` and `{}` forced past the type each refuse by the package's name, and the real acknowledgement still admits |
| **no production source calls the ungoverned compiler entry point** | **the structural half:** every `.ts` under `apps/` and `packages/` (excluding the compiler package) is scanned; a production caller of `compileApplication` fails the suite, and the scan is shown non-vacuous by finding both governed callers |
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
| `unbound-check-removed` | `conformance.ts`: a bare `continue` at the top of the unbound branch | {{RED1}} |
| `governance-wiring-removed` | `compiler.ts`: the whole-model condition inverted, defeating both the `required` arm and the supplied arm | {{RED2}} |
| **`release-governance-made-optional`** | `compiler.ts`: `compileApplicationRelease` downgraded to the caller-supplied contract — **round 2's exact fail-open defect, restored on purpose** | {{RED8}} |
| **`recorded-revision-narrowing-removed`** | the loader: narrowing returns the list unnarrowed, so a recorded revision is judged against today's census | {{RED9}} |
| `subject-check-removed` | `conformance.ts`: the subject compared against itself | {{RED3}} |
| `stale-check-removed` | `conformance.ts`: the stale membership test keyed on the acknowledgement instead of the declared census | {{RED4}} |
| `acknowledgement-entry-removed` | the list: the `party_create` entry deleted | {{RED5}} |
| `stale-entry-added` | the list: an entry for `stock_count_probe_stale` appended | {{RED6}} |
| `governed-package-key-renamed` | the list: the composed package key misspelled by one character | {{RED7}} |

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

## What this packet does NOT claim

- It does not authorize anything. Every principal still holds every declared
  permission; row `7` is the kernel and this packet is the announcement.
- **A FIXTURE compile of a permission-bearing package is still ungoverned**, by
  design and at measured cost (see the mechanism section). The guarantee is not
  "no compile is ever ungoverned"; it is "**no compile that mints a served
  release can be ungoverned, and no production code can reach the ungoverned
  entry point**". Those are different claims and the second is the one the
  evidence supports.
- The `platform` module is not mounted in any release; when it is, its
  permissions enter the composed census and refuse by name.
- The acknowledgement is not hashed into any artifact. A list change alone
  mints no lineage entry and moves no root; a release root says nothing about
  the list it was built under.
- Recorded lineage entries under `verifyExistingLineage` are reproduced by
  `reproduceHistoricalApplication`, which skips whole-model validation
  altogether by design — it can only verify an already-recorded root and can
  never mint.
- `check:app-release` on **changed** authored source refuses as *stale* before
  any candidate compile; the permission diagnostic comes from
  `build:app-release` (and from `--check` on unchanged source, which recompiles
  the serving head).
- **What row `7` inherits:** the bound set is a compiler-internal constant. The
  runtime's evaluator registry cannot be imported by the compiler (dependency
  boundaries), so the binding census will have to reach the compiler as data the
  same way the acknowledgement now does.

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
| `evidence:expected-red` (this packet's nine entries, `--run`, exclusive lock, detached worktree) | OK, 9 expected reds reproduced and restored at `17529cf`; 14 tests passing with production restored before each mutation; kill counts 4, 4, 1, 1, 4, 3, 6, 1, 1 |
| full matrix (`run-matrix.sh policy14`, detached worktree at `17529cf`) | **PASS — `FULL_MATRIX_PASS_SHA=17529cf8c8b80e97f287545a3b80782e95600fb9`**, first attempt: performance 5/5, unit 155/155, compiler 173/173, integration 149/149, agent 3/3, architecture 189/189, contracts 29/29, PostgreSQL 223/223, locale 1/1, browser 93/93, observability producer 11/11, language coverage PASS (2050 obligations), reachability 106/106, security scans passed, schema 23 migrations verified, both release checks green, expected-red validation and its 38 self-test controls green as matrix stages |
| `test:architecture` and `format` re-run at the narrative head | run after this record was committed; the result is quoted in the pin commit above this one |
| `scripts/check-records.sh` | green at every executable SHA of this round; re-run after this record was committed, result in the pin commit above |

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

The last executable commit is `17529cf8c8b80e97f287545a3b80782e95600fb9`; the commits
above it are narrative. Round 3's executable commits are `87496a9` (the release
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
  "head": "17529cf8c8b80e97f287545a3b80782e95600fb9",
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

## Review prompt — round 3; paste as written; the lane fenced nothing

Review packet `policy-unbound-refusal`, ROUND 3, in `/home/rvham/2rain-greenfield` (or any fresh clone of `origin`). Read `AGENTS.md`, then `.agents/skills/review-tiers/SKILL.md` — "Evidence depth follows FAILURE OBSERVABILITY", "Does the evidence prove the claim?", "A negative control must vary one property", "Convergence", "Write the claim from the measurement, and prefer unrepresentable to detectable" — then `docs/execution/packets/policy-unbound-refusal.md` in full, then the diff.

This prompt was written by the lane whose work you are reviewing. The lane has fenced nothing. Any scope stated here is the orchestrator's, and it stands as a claim under test rather than a limit you may not question. Read whatever you judge relevant to the decisive questions, say plainly if you think the scope is drawn wrongly, and say plainly if the prompt itself is steering you.

**Two prior rounds returned BLOCK, and the round-2 reviewer said its prompt steered.** Round 1 was blocked because a missing key in a list left a release ungoverned; round 2 because a missing execution option did. Both were the same defect — absence read as permission. Round 2's prompt framed compiler-level absence as acceptable and its two release scripts as the only callers that mattered, while one mode of one of those scripts took the bypass; that framing is withdrawn. **Do not accept this prompt's boundary either. Question B below asks you to attack it.**

TARGET. Branch `packet/policy-unbound-refusal`, frozen at {{FREEZE}}. `git ls-remote origin refs/heads/packet/policy-unbound-refusal` returned, at freeze time:

{{LS_REMOTE}}

The last executable commit is `17529cf8c8b80e97f287545a3b80782e95600fb9`; the commits above it are narrative, and `git diff --name-only 17529cf {{FREEZE_SHORT}} -- . ':!docs' ':!.agents' ':!CLAUDE.md' ':!AGENTS.md' ':!learnings.md'` is empty. Base is `4218a66068041eb04e45e6fff4883c8aa8dfaebf`, `origin/main` at cut. Read the whole delta `4218a66..{{FREEZE_SHORT}}`. Round 1's tree is preserved at `87878a6`, round 2's at `af1d603`; both reviews' findings are dispositioned in the record. Full matrix: Full matrix **PASS — `FULL_MATRIX_PASS_SHA=17529cf8c8b80e97f287545a3b80782e95600fb9`**, first attempt: performance 5/5, unit 155/155, compiler 173/173, integration 149/149, agent 3/3, architecture 189/189, contracts 29/29, PostgreSQL 223/223, locale 1/1, browser 93/93, observability producer 11/11, language coverage PASS (2050 obligations), reachability 106/106, security scans passed, schema 23 migrations verified, both release checks green, expected-red validation and its 38 self-test controls green as matrix stages.

TIER. Critical — a compiler refusal on the release build's path. Band B declared.

THE CHARTER AND THE BRIDGE (claims under test, not fences). Program review R7 small (a): a declared permission with no evaluator binding must announce itself at compile time; the authorization kernel is queue row 7 and is not this packet. The original lease was `conformance.ts`, `diagnostics.ts`, the list, `test/compiler/**`, the manifest and narrative. After round 1's BLOCK the user granted a bridge verbatim ("do whatever you need to to fix this") and reaffirmed it after round 2's. Round 3 therefore also changes `packages/compiler/src/compiler.ts`, `protocol.ts`, `index.ts`, `apps/web/scripts/*`, and two pre-existing fixtures in `test/compiler/compiler-semantic-profile.test.ts` and `test/postgres/composed-application.test.ts`. `packages/canonical-model/**`, `packages/domain/**` and `storage.ts` are untouched. **`index.ts` and `protocol.ts` are also in ENUM-WIDEN's live diff, at other lines.**

THE LANE'S CLAIMS, WRITTEN TO BE TESTED.
1. `compileApplicationRelease` takes the acknowledgement as a REQUIRED positional parameter, so a release path that omits governance does not typecheck; and it asserts governance unconditionally, so casting around the type and passing nullish is refused rather than admitted.
2. `compileApplication` remains the fixture entry point and is ungoverned when no option is supplied. The lane claims this is safe ONLY because no production source can call it, and a committed control scans every `.ts` under `apps/` and `packages/` (excluding the compiler package) to enforce that.
3. Together, 1 and 2 mean absence is unrepresentable on the path that mints: forgetting is a type error, and reaching for the ungoverned door is a red test. The lane claims this SUBSUMES rounds 1 and 2 rather than sitting beside them.
4. Truncation is decided, not excepted: a recorded revision is governed by the checked-in list narrowed to its own census, narrowing can only remove and never invent, and a recorded entry from an unlisted package gets an empty acknowledgement — stricter, because every permission it declares is then unbound and the entry is dropped.
5. The rule still governs every language version, still refuses unbound/stale/mislabelled/malformed, and the v0 shell is governed.
6. Nothing reaches the artifact; both compiled artifacts rebuild identical.
7. Nine expected reds each vary one property and kill exactly their declared victims.

WHAT THE LANE DID NOT VERIFY, COULD NOT VERIFY, OR VERIFIED ONLY BY ITS OWN CONSTRUCTION.
- **The fixture gap is real and deliberate.** A test compiling a permission-bearing package with no acknowledgement is ungoverned. The lane measured the alternative — mandatory governance for every current-mode compile reds 85/174 compiler and 27/155 unit tests, ~46 files across several live leases — and chose the required-parameter design instead. That is a judgement about cost, and you may rule it wrong.
- The production-caller scan is a source scan, not a type-level guarantee: it would not stop a production file that constructed the call dynamically, and it has no mutation control (the record explains why a one-property mutation cannot simulate the realistic defect without reddening for a `ReferenceError` instead).
- The truncation path's end-to-end behaviour is exercised only by the pre-existing v0-prefix control; the narrowing and retainable readers are tested directly.
- The `protocol.ts` and `index.ts` edits sit in a file another live lane holds; the lane verified the hunks do not overlap but cannot verify merge order.
- Two fixtures outside the original lease were changed to satisfy the new contract; both were found by suites, not designed for.
- All controls are self-chosen.

DECISIVE QUESTIONS.
A. Is there any path — `compile-app-release.ts` in all four modes, `compile-demo-release.ts`, or any other production source — by which a first-party permission reaches a compiled release without the rule running against a correct acknowledgement?
B. **Attack the boundary.** Does "required parameter on the release entry point plus a source scan forbidding the fixture entry point in production" actually make absence unrepresentable where it matters, or is it round 1 and round 2's defect a third time in a new place? If you can construct a plausible, accidental route to an ungoverned served release, this is a BLOCK.
C. Do the nine reds each vary exactly one property and kill exactly their declared victims? Does every branch of the rule, the loader's two readers, and the narrowing helper die alone under deletion?
D. Is the truncation semantics correct — is narrowing sound (never self-certifying), and is empty-for-unlisted genuinely stricter rather than a hole?
E. Does the bridged diff exceed what the fix needed, and does the record claim more than the evidence proves? The record now states the fixture gap as a cost; check that it does not understate it.

CONVERGENCE. This is round 3 and `review-tiers` requires the criterion to be named: the defect was in production (continue), the blast-radius override names this exact class, and round 3's fix is claimed to be subsuming rather than another instance. **If you find absence-means-ungoverned a third time, say so plainly — that is the signal to route the class rather than write round 4.**

OUT OF SCOPE PER THE ORCHESTRATOR'S CHARTER (claims, not fences): the authorization kernel (row 7); RLS on `module_storage_backfill_checkpoints`; binding the compiler's bound set to a runtime evaluator registry; `packages/canonical-model/**` and `packages/domain/**`.

THREAT MODEL. Foundation stage: accidental and plain omissions by honest developers or AI writers — a new release path forgetting governance, a typo in the list, a module removed — not an adversary deliberately editing the acknowledgement to hide a permission.

VERDICT FORMAT. PASS, REVISE or BLOCK, then findings ranked by severity, each with file and line at the frozen SHA, what you observed versus what the record claims, and whether the defect is in production, in a control, or in the claim's prose. A round with zero production defects converges the review (ruled 2026-09-01).
