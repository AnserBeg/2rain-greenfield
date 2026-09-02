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

**ROUND 2 — re-frozen after a BLOCK.** Round 1 froze at
`87878a69226957a5ac5a462f8093c1669bd8e8b3` (executable `c9062f5`, matrix green
there) and the review returned BLOCK on two production findings and one
architecture finding; the round-1 record is preserved in git at that SHA and
its dispositions are in *Round 1 review and what changed* below. Round 2's
executable freeze is `afe67f7ca20f0bda5b139d5a8a208bd367d9e7b5`: `209e3fc` is the
correction, `5de9f1f` and `afe67f7` test fixes measured against it (below).

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

## The mechanism — an acknowledged-unbound ratchet

`validateUnboundPermissionAcknowledgement` in `packages/compiler/src/conformance.ts`,
called from `validateWholeModel` in `compiler.ts` **before** the version-gated
module-conformance cells, on the versioned revision itself, so it runs for every
language version the compiler accepts (round 1 sat inside
`validateModuleConformance`, which returns nothing below `v2`; the v0 shell demo
never reached it). It runs under `current` conformance only, exactly like every
other whole-model cell — recorded lineage entries are reproduced, never re-judged.

- **Input:** `CompilerExecutionOptions.unboundPermissionAcknowledgement`, one
  `{ packageId, entries[{permissionId, resource}] }` handed in by the caller.
  Not part of `CompilerInput`; hashed into nothing.
- **Subject explicit, fail closed:** `packageId` must equal the compiled
  package's id, and the value must be exactly that shape, or the compile refuses
  with `COMPILER_PERMISSION_ACKNOWLEDGEMENT_INVALID` (subject = the package). A
  mislabelled or malformed acknowledgement never ungoverns.
- **Census:** `packageRevision.permissions` of the normalized package — never
  source text. Every lifecycle.
- **Bound set:** `EVALUATOR_BOUND_PERMISSION_IDS`, **empty by construction**,
  with the comment naming row `7` as what populates it.
- **`COMPILER_PERMISSION_EVALUATOR_UNBOUND`** (subject = the permission id): a
  declared permission not in the bound set and not acknowledged.
- **`COMPILER_PERMISSION_ACKNOWLEDGEMENT_STALE`** (subject = the entry's
  permission id): an entry naming a permission the package does not declare —
  **whether or not its resource entity still exists**; an entry whose resource
  disagrees with the declaration; an entry for a permission the bound set
  contains; a duplicated entry.
- **Absence:** a compile handed no acknowledgement is a fixture or standalone
  compile and is not governed. That is a fact about the caller's code, not
  about a key in a mutable list. Both release scripts always pass one, and
  their loader throws before compiling when the checked-in list has no entry
  for their package.
- **Row `7` empties the list.** At zero entries the refusal is absolute.

**What "the list can only shrink" means, precisely.** The compiler enforces a
**snapshot invariant**: every entry handed to it is true of the package in
front of it right now, and every unbound declared permission is named. It does
not enforce repository-history monotonicity — adding a newly declared
permission to the list compiles, by design, and *Test it yourself* step 2 does
exactly that. Shrinking is the review policy over the checked-in file, written
in its header, and row `7` is what drives it.

**The list and its loader.** `apps/web/release/unbound-permission-acknowledgement.json`
sits beside the release inputs it acknowledges, keyed by package id:
**65** entries for `northstar.app:package.application` and **1** for
`northstar.shell:package.demo`. `apps/web/scripts/unbound-permission-acknowledgement.ts`
reads it **strictly** — exactly the keys `header`, `packages`, `schemaVersion`;
a non-empty header; entries exactly `{permissionId, resource}` with non-empty
strings — and throws before any compile when the requested package has no key.
The path is derived from the release input's directory, so the
`NORTH_STAR_APP_AUTHORED_PATH` override the tests already use redirects the
acknowledgement with the input; there is no separate path to point elsewhere.
`compile-app-release.ts` passes it on every current compile of the authored
source (the serving head under `--check`, the candidate under build); the
bootstrap — the same package with every family emptied — gets an explicitly
empty acknowledgement; `--truncate-invalid-lineage` recompiles recorded bytes
whose census is not today's and carries no acknowledgement for those entries,
which is stated in the script rather than papered over with today's list.
`compile-demo-release.ts` passes the shell's entry.

## Controls

Twelve tests in `test/compiler/g2-module-conformance.test.ts`. Ten carry the
prefix `unbound-permission acknowledgement:`, two carry `unbound-permission
release script:` and spawn the real `compile-app-release.ts --check` against a
temp copy of the three release inputs (about five seconds each).

| test | claim it holds |
|---|---|
| the unchanged composed application builds under its acknowledgement, which is exactly its declared census | admission twin through the real loader and the real compiler; the entries equal the declared `{permissionId, resource}` census with no duplicates; a compile with no acknowledgement is stated to be ungoverned |
| a permission the composed application declares and nothing acknowledges refuses the release by name | claim 1, through the real compiler on the real composition under the real list |
| the rule runs at language v0 too — the shell demo builds under its acknowledgement and refuses an unacknowledged permission by name | review finding 2 closed: the v0 shell is governed |
| removing the acknowledgement of a permission the package still declares refuses it by name | claim 3, at the rule level |
| an entry naming a permission the package does not declare is stale, whether or not its resource exists | claim 4, with the round-1 entity-presence skip gone |
| an entry whose resource disagrees with the declaration is stale | a re-pointed permission re-announces itself |
| a permission an evaluator binds leaves the list, and stays listed only as rot | the shrink direction row `7` will drive |
| a duplicated entry is stale | the list carries nothing twice |
| an acknowledgement for another package, or an unreadable one, fails closed rather than ungoverning | review finding 1 closed at the compiler: subject mismatch and nine malformed shapes each refuse with `COMPILER_PERMISSION_ACKNOWLEDGEMENT_INVALID`, also through `compileApplication` |
| the checked-in document is read strictly and a package with no key is refused before any compile | review finding 5's parser half: nine malformed documents each throw; a missing key throws by package name |
| release script: `check:app-release` on an untouched copy of the release inputs is green | the real script, real inputs, real list: admission |
| release script: a list with no key for the composed package makes `check:app-release` refuse before compiling | review finding 1's required control: the build itself refuses a one-character key typo, for the missing subject and nothing else |

## Expected-red manifest — the recorded reds

`test/evidence/policy-unbound-refusal.expected-red.json`, seven entries, each
varying one property. Every rule-level entry runs the `unbound-permission
acknowledgement` population; the key-typo entry runs both populations so the
real release script is in it.

| entry | mutation | kills | measured |
|---|---|---|---|
| `unbound-check-removed` | `conformance.ts`: a bare `continue` at the top of the unbound branch | probe test, v0 shell test, removed-acknowledgement test | 3 killed at `5de9f1f` and again at `afe67f7` |
| `governance-wiring-removed` | `compiler.ts`: the whole-model call guarded by a constant false | probe test, v0 shell test, mislabelled-acknowledgement test | 3 killed at `5de9f1f` and again at `afe67f7` |
| `subject-check-removed` | `conformance.ts`: the subject compared against itself | mislabelled-acknowledgement test | 1 killed at `5de9f1f` and again at `afe67f7` |
| `stale-check-removed` | `conformance.ts`: the stale membership test keyed on the acknowledgement instead of the declared census | undeclared-entry test | 1 killed at `5de9f1f` and again at `afe67f7` |
| `acknowledgement-entry-removed` | the list: the `party_create` entry deleted | census test (`COMPILER_PERMISSION_EVALUATOR_UNBOUND … party_create`), probe test (two diagnostics) | 2 killed at `5de9f1f` and again at `afe67f7` |
| `stale-entry-added` | the list: an entry for `stock_count_probe_stale` appended | census test (`COMPILER_PERMISSION_ACKNOWLEDGEMENT_STALE … stock_count_probe_stale`), probe test | 2 killed at `5de9f1f` and again at `afe67f7` |
| `governed-package-key-renamed` | the list: the composed package key misspelled by one character | **the real release script's `--check` on untouched inputs**, plus the three tests that read the composed entries through the loader — all for `names no entries for package northstar.app:package.application` | 4 killed at `5de9f1f` and again at `afe67f7` |

The admission twin is measured by the runner itself: every entry's population
must pass with production restored before the mutation is applied.

**Vectors NOT individually controlled, and why.** (a) The domain-edit route
(append a permission to a module definition, regenerate, build) is exercised by
hand in *Test it yourself*, not by a manifest entry: a mutation of a file
outside this lease couples the manifest's `original` text to a file the next
module packet will edit. The probe test appends the same object to the same
composition through the same compiler and the same list. (b) The "bound
permission stays listed" and "duplicate entry" branches are tested, not
mutated; Band B is one discriminating red per claim, not per branch. (c) The
parser's individual shape clauses are each covered by a throwing document in
the strict-read test, not by mutations. (d) The truncation path
(`--truncate-invalid-lineage`) is not exercised by any test; its behaviour is
stated in the script.

## What this packet does NOT claim

- It does not authorize anything. Every principal still holds every declared
  permission; row `7` is the kernel and this packet is the announcement.
- **Ungoverned by construction:** any compile handed no acknowledgement — the
  synthetic fixtures, standalone module compiles, and `--truncate-invalid-lineage`'s
  recompiles of recorded historical bytes. The `platform` module is not mounted
  in any release; when it is, its permissions enter the composed census and
  refuse by name.
- The acknowledgement is not hashed into any artifact. A list change alone
  mints no lineage entry and moves no root; a release root says nothing about
  the list it was built under.
- Recorded lineage entries are reproduced under `historicalReproduction`,
  which skips every whole-model cell including this one, by design.
- `check:app-release` on **changed** authored source refuses as *stale* before
  any candidate compile; the permission diagnostic is produced by
  `build:app-release` (and by `--check` on unchanged source, which recompiles
  the serving head under current conformance). Round 1's header said otherwise
  and was wrong.
- **What row `7` inherits, filed as one line in the archive:** the bound set
  is a compiler-internal constant. The runtime's evaluator registry cannot be
  imported by the compiler (dependency boundaries), so the binding census will
  have to reach the compiler as data the same way the acknowledgement now does
  — through execution options from the release build.

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

Round 2, at the executable freeze `afe67f7` unless stated (`209e3fc` and
`5de9f1f` where noted; the deltas between them are test files and the manifest). Round 1's gate
history, including its three matrix attempts and their causes, is preserved in
the record at `87878a6`.

| gate | result |
|---|---|
| `format`, `typecheck`, `lint`, `check:boundaries` | green |
| the twelve packet tests, run alone | 12/12, 11.7 s including two release-script spawns (at `209e3fc`) |
| `test:unit` | 155/155 at `5de9f1f` |
| `test:compiler` | 169/169 at `5de9f1f` (168/169 at `209e3fc`, the truncation fixture; see *Declaration*) |
| `test:integration` | 149/149 at `5de9f1f` |
| `check:app-release`, `check:demo-release` | green; `build:app-release` rebuild byte-identical; `build:demo-release` differs in JSON indentation only (pre-existing, reverted) |
| `check:expected-red` | OK, 69 entries in 7 manifests |
| `check:expected-red-controls` | run as a matrix stage (below); it refuses an unfrozen tree, so it was not run separately while the record was being written |
| `evidence:expected-red` (this packet's seven entries, `--run`, exclusive lock, detached worktree, at `5de9f1f` and again at `afe67f7`) | OK, 7 expected reds reproduced and restored; every entry's population passing with production restored (10 tests for the rule-level entries, 12 for the key-typo entry, which runs the two release-script spawns); tree identical to HEAD on exit |
| full matrix at `5de9f1f` (`run-matrix.sh policy6`, detached worktree) | **FAILED at `test:postgres` 218/223**, every earlier stage green (performance 5/5, unit 155/155, compiler 169/169, integration 149/149, agent 3/3, architecture 189/189, contracts 29/29): three reds from the two release-script workspaces with no acknowledgement beside them (fixed in `afe67f7`, see *Declaration*) and one from the WSL clock step in `release-activation.test.ts` |
| full matrix at `afe67f7`, first two attempts (`policy7`, `policy8`, detached worktree) | `policy7` ended in three minutes with its output lost to the lane's own log filter — reported as unexplained rather than guessed at; `policy8` was **INDETERMINATE at its first stage**: `COMPILE_BUDGET_INDETERMINATE: observed CPU idle 83.3% is below required 90.0%; rerun the exclusive gate`, another lane's architecture run having just released the slot |
| full matrix at `afe67f7`, third attempt (`policy9`, detached worktree, after a settle) | **FAILED at `test:postgres` 214/215**, every earlier stage green (performance 5/5, unit 155/155, compiler 169/169, integration 149/149, agent 3/3, architecture 189/189, contracts 29/29): the one red is `composed-application.test.ts` › *composed product activates through the kernel and persists tenant-scoped gateway data* with `composed release activation did not verify: NO_SWAP_TERMINAL` — the WRONG-OUTCOME manifestation `container-pressure-forges-outcomes` records verbatim as pre-existing on `main` at `b289911`; the same file was 17/17 on this tree an hour earlier under the exclusive lock, and Docker held 39 leaked anonymous volumes again. The lane pruned dangling volumes only and re-ran. |
| full matrix at `afe67f7`, fourth attempt (`policy10`, detached worktree, after the prune reclaimed 809 MB) | **PASS — `FULL_MATRIX_PASS_SHA=afe67f7ca20f0bda5b139d5a8a208bd367d9e7b5`**: performance 5/5, unit 155/155, compiler 169/169, integration 149/149, agent 3/3, architecture 189/189, contracts 29/29, PostgreSQL 223/223, locale 1/1, browser 93/93, observability producer 11/11, language coverage PASS (2050 obligations), reachability 106/106, security scans passed, schema 23 migrations verified, both release checks green, expected-red validation and its 38 self-test controls green as matrix stages |
| `test:architecture` and `format` re-run at the narrative head | run after this record was committed; the result is quoted in the pin commit above this one |
| `scripts/check-records.sh` | green against the draft at every executable SHA; re-run after this record was committed, result in the pin commit above |

## Declaration

The last executable commit is `afe67f7ca20f0bda5b139d5a8a208bd367d9e7b5`; the
commits above it are narrative. Round 1's four executable commits (`1f6eca2`,
`fbc2104`, `c191221`, `c9062f5`) are its ancestors; `209e3fc` is the round-2
correction, `5de9f1f` two test fixes measured against it, and `afe67f7`
a third. **The correction changed the release script's contract — a release-input
directory must carry its acknowledgement — and that contract reached three
pre-existing fixtures that run the real script against temp workspaces:** the
`--truncate-invalid-lineage` control in `test/compiler/compiler-semantic-profile.test.ts`
(`test:compiler` 168/169 at `209e3fc`) and two workspaces in
`test/postgres/composed-application.test.ts` (`test:postgres` 218/223 at
`5de9f1f`: the loader's ENOENT at the head, a strict-refusal control that then
died of that instead of its compiler diagnostic, and a 300 s timeout behind
them). Each fixture now writes an acknowledgement derived from the definition it
writes, beside its authored file, exactly as the checked-in one is derived from
the composed application. `test/postgres/**` was not in the lease; the user's
grant covered it and the lane states the crossing here. The key-typo entry's
declared reason for the strict-read test was also corrected to the assertion
that actually dies. **The fourth PostgreSQL red at `5de9f1f`,
`release-activation.test.ts` › *overdue recovery completion is derivable without
its alarm projection*, is `assert.ok(overdue.completionAt >= overdue.deadlineAt)`
— the WSL wall-clock step `AGENTS.md` §7 records; this packet changes nothing
under `test/postgres/**` that test reads, `packages/postgres-provider/**` or
`packages/runtime/**`, and it is re-run in the matrix below.** `packages/compiler/src/unbound-permission-acknowledgement.json`
existed only between `1f6eca2` and `209e3fc`, so it is in no path of this
range.

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "policy-unbound-refusal",
  "base": "4218a66068041eb04e45e6fff4883c8aa8dfaebf",
  "head": "afe67f7ca20f0bda5b139d5a8a208bd367d9e7b5",
  "changedPaths": [
    "apps/web/release/unbound-permission-acknowledgement.json",
    "apps/web/scripts/compile-app-release.ts",
    "apps/web/scripts/compile-demo-release.ts",
    "apps/web/scripts/unbound-permission-acknowledgement.ts",
    "packages/compiler/src/compiler.ts",
    "packages/compiler/src/conformance.ts",
    "packages/compiler/src/diagnostics.ts",
    "packages/compiler/src/protocol.ts",
    "test/compiler/compiler-semantic-profile.test.ts",
    "test/compiler/g2-module-conformance.test.ts",
    "test/evidence/policy-unbound-refusal.expected-red.json",
    "test/postgres/composed-application.test.ts"
  ],
  "symbols": [
    {
      "path": "packages/compiler/src/conformance.ts",
      "name": "validateUnboundPermissionAcknowledgement"
    },
    {
      "path": "packages/compiler/src/conformance.ts",
      "name": "EVALUATOR_BOUND_PERMISSION_IDS"
    },
    {
      "path": "packages/compiler/src/compiler.ts",
      "name": "validateWholeModel"
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
      "name": "readAcknowledgementDocument"
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

## Review prompt — round 2; paste as written; the lane fenced nothing

Review packet `policy-unbound-refusal`, ROUND 2, in `/home/rvham/2rain-greenfield` (or any fresh clone of `origin`). Read `AGENTS.md`, then `.agents/skills/review-tiers/SKILL.md` — "Evidence depth follows FAILURE OBSERVABILITY", "Does the evidence prove the claim?", "A refusal control needs its admission twin", "A negative control must vary one property", "Convergence" — then `docs/execution/packets/policy-unbound-refusal.md` in full, then the diff.

This prompt was written by the lane whose work you are reviewing. The lane has fenced nothing. Any scope stated here is the orchestrator's, and it stands as a claim under test rather than a limit you may not question. Read whatever you judge relevant to the decisive questions, say plainly if you think the scope is drawn wrongly, and say plainly if the prompt itself is steering you.

TARGET. Branch `packet/policy-unbound-refusal`, frozen at {{FREEZE}}. `git ls-remote origin refs/heads/packet/policy-unbound-refusal` returned, at freeze time:

{{LS_REMOTE}}

The last executable commit is `afe67f7ca20f0bda5b139d5a8a208bd367d9e7b5`; the commits above it are narrative, and `git diff --name-only afe67f7 {{FREEZE_SHORT}} -- . ':!docs' ':!.agents' ':!CLAUDE.md' ':!AGENTS.md' ':!learnings.md'` is empty. Base is `4218a66068041eb04e45e6fff4883c8aa8dfaebf`, `origin/main` at cut. Read the whole delta `4218a66..{{FREEZE_SHORT}}`; the round-1 tree is preserved at `87878a6` and the round-1 review's findings are dispositioned in the record's *Round 1 review and what changed*. Full matrix: Full matrix **PASS — `FULL_MATRIX_PASS_SHA=afe67f7ca20f0bda5b139d5a8a208bd367d9e7b5`**: performance 5/5, unit 155/155, compiler 169/169, integration 149/149, agent 3/3, architecture 189/189, contracts 29/29, PostgreSQL 223/223, locale 1/1, browser 93/93, observability producer 11/11, language coverage PASS (2050 obligations), reachability 106/106, security scans passed, schema 23 migrations verified, both release checks green, expected-red validation and its 38 self-test controls green as matrix stages (fourth attempt at the same SHA; attempts 1–3 — one lost to a log filter, one indeterminate under load, one the recorded `NO_SWAP_TERMINAL` container-pressure forgery — are in the record).

TIER. Critical — a compiler refusal placed in the release build's path. Band B declared: the failure is visible the first time a release is built, and round 2's controls include the real release script refusing.

THE CHARTER'S SCOPE AND THE BRIDGE (claims under test, not fences). Program review R7 small (a): a declared permission with no evaluator binding must announce itself at compile time; the authorization kernel is queue row 7 and is not this packet. The original lease was `conformance.ts`, `diagnostics.ts`, the list, `test/compiler/**`, the manifest and narrative. After round 1's BLOCK the lane requested a bridge and the user granted it verbatim ("do whatever you need to to fix this"); round 2 therefore also changes `packages/compiler/src/compiler.ts`, `packages/compiler/src/protocol.ts` (one optional field on `CompilerExecutionOptions`, in a file ENUM-WIDEN's live diff also touches at other lines), and `apps/web/scripts/*`. `packages/canonical-model/**`, `packages/domain/**`, `packages/compiler/src/index.ts` and `storage.ts` are untouched.

THE LANE'S CLAIMS, WRITTEN TO BE TESTED.
1. The rule is called from `validateWholeModel` in `compiler.ts` before the v2-gated module-conformance cells, on the versioned revision, so it governs every language version the compiler accepts; the v0 shell demo is governed and a test proves it refuses an unacknowledged permission by name.
2. The acknowledgement is an explicit execution option naming its subject: a `packageId` that is not the compiled package, or any value that is not exactly `{packageId, entries[{permissionId, resource}]}`, refuses with `COMPILER_PERMISSION_ACKNOWLEDGEMENT_INVALID`. Nothing is inferred from absence of a key in any list.
3. A compile handed no acknowledgement is not governed. The lane claims that is acceptable because it is a fact about the caller's code rather than about data, and because both release scripts always pass one and their loader throws before compiling when the checked-in list has no key for the package — proven by a test that spawns the real `compile-app-release.ts --check` against a temp copy with a one-character key typo and observes the refusal.
4. Stale no longer depends on entity presence: every entry must name a declared permission on its declared resource; duplicates and bound-but-listed entries are stale.
5. The compiler holds no module identity: no compiler file imports the list, which lives at `apps/web/release/unbound-permission-acknowledgement.json` beside the inputs it acknowledges, and is read by a strict app-side loader.
6. Nothing reaches the artifact: the option is not in `CompilerInput` and is hashed into nothing; `app.compiled.json` rebuilds byte-identical; `shell.compiled.json` rebuilds identical modulo JSON indentation that predates this packet.
7. `check:app-release` on unchanged source recompiles the serving head under current conformance with the acknowledgement; on changed source it refuses as stale before any candidate compile, and the permission diagnostic is produced by `build:app-release`. The record says so; round 1 said otherwise.
8. Seven expected-red entries each vary one property and kill exactly the declared tests for the declared reasons, including the real release script under the key typo.

WHAT THE LANE DID NOT VERIFY, COULD NOT VERIFY, OR VERIFIED ONLY BY ITS OWN CONSTRUCTION.
- The absence-means-ungoverned semantics at the compiler level (claim 3) is a design judgement. A caller that forgets to pass the option compiles ungoverned; the only callers that matter are the two release scripts, and they are tested, but nothing structural prevents a third release script from forgetting.
- `--truncate-invalid-lineage` recompiles recorded historical bytes with no acknowledgement (their census is not today's); the lane stated this in the script and did not test that path.
- The bootstrap compile is handed an explicitly empty acknowledgement; the lane reasons that the bootstrap declares no permissions by construction (`emptyApplicationDefinition`) and did not add a control for a bootstrap that declares one.
- The protocol.ts edit sits in a file another live lane holds; the lane verified their hunks do not overlap but cannot verify the merge order.
- The "bound permission stays listed" and "duplicate entry" branches and the parser's individual clauses are tested, not mutated.
- All controls are self-chosen.

DECISIVE QUESTIONS.
A. Is there any current-mode path by which a first-party permission reaches a compiled release without the rule running with a correct acknowledgement — trace `compile-app-release.ts` (build, `--check` on unchanged and on changed source, initial lineage, truncation) and `compile-demo-release.ts` — that the record fails to name as a limit?
B. Does the explicit-subject design actually close round 1's finding 1, or does "no option means ungoverned" reproduce it one level up? Say which, with the threat model in mind.
C. Do the seven reds each vary exactly one property, kill exactly the declared victims, and die for the declared reason? Does every branch of the rule, and the loader's refusal, die alone under deletion?
D. Is the `apps/web/release/` home and the `CompilerExecutionOptions` boundary the honest resolution of round 1's finding 3, and is the compiler now free of module identity?
E. Does the bridged diff exceed what the fix needed, and does the record claim more than the evidence proves?

OUT OF SCOPE PER THE ORCHESTRATOR'S CHARTER (stated as claims, not fences): the authorization kernel itself (row 7); RLS on `module_storage_backfill_checkpoints` (R7 small b); binding the compiler's bound set to a runtime evaluator registry; anything under `packages/canonical-model/**` or `packages/domain/**`.

THREAT MODEL. Foundation stage: accidental and plain omissions by honest developers or AI writers — a module packet declaring permissions and forgetting the vacuum, a typo in the list, a whole module removed — not an adversary editing the acknowledgement to hide a permission.

VERDICT FORMAT. PASS, REVISE or BLOCK, then findings ranked by severity, each with file and line at the frozen SHA, what you observed versus what the record claims, and whether the defect is in production, in a control, or in the claim's prose. A round with zero production defects converges the review (ruled 2026-09-01).
