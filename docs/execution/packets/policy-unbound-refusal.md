# policy-unbound-refusal — a declared permission no evaluator binds announces itself at compile time

Cut from `4218a66068041eb04e45e6fff4883c8aa8dfaebf` (`origin/main`) on branch
`packet/policy-unbound-refusal`, in the detached worktree
`/home/rvham/2rain-greenfield-pur` (the shared checkout is `ENUM-WIDEN`'s).
Tier: **Critical** — a compiler refusal that can stop a release. Evidence band:
**Band B, declared** — the failure this packet guards against is visible the
first time a release is built: `check:app-release` throws with the diagnostics
in the message, naming the permission. One discriminating recorded red per
claim, and the vectors not individually controlled are named below. (The
`lanes.md` row proposed Band C for the refusal itself; the charter said Band B,
and Band B is what is declared here.)

Program review 2026-08-20, finding **R7, small (a)**. The full authorization
kernel is queue row `7`, deferred by user ruling, and is NOT this packet.
Stops: **0** of the 2-stop cap.

**Frozen SHA: `87878a69226957a5ac5a462f8093c1669bd8e8b3`**, the tip that carries the
matrix result, the ledger, lane and archive rows. Quoted from the remote at
freeze time:

```
$ git ls-remote origin refs/heads/packet/policy-unbound-refusal
87878a69226957a5ac5a462f8093c1669bd8e8b3	refs/heads/packet/policy-unbound-refusal
```

The branch head is one commit above that SHA; its only content is this block,
the SHA filled into the rows and the review prompt, and the two gate results
measured at `87878a6`. `git diff 87878a6..packet/policy-unbound-refusal` shows
nothing else. The executable freeze is `c9062f5`;
`FULL_MATRIX_PASS_SHA=c9062f5f68aed64b6b437f9a8519342cf3395997`.

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

**Taken: a JSON data file beside the rule**,
`packages/compiler/src/unbound-permission-acknowledgement.json`, imported by
`conformance.ts` with `with { type: 'json' }` (typechecks under the root
`NodeNext` config and runs under tsx; measured before designing). The press
law scans no `.json`, and that is not an evasion: the list is a debt register a
reviewer reads — the same family as the routed-debt table in
`module-press-law.test.ts` — not press. The compiler-hermeticity test scans
only `.ts` and bans ambient inputs; a static JSON import is neither. No
canonical byte moves and no lease outside the charter was touched.

**(2) Does the diagnostic or the list reach the compiled artifact?** No. A
diagnostic exists only on a failed compile, which mints nothing; the list is
read at validation time and is hashed into no release root, manifest, or
attestation. Measured: `check:app-release` green at `1f6eca2`, then
`build:app-release` rewrote `apps/web/release/app.compiled.json` and `git diff
--stat -- apps/web/release` was **empty**. `check:demo-release` green.
**Nothing under `apps/web/release/**` was regenerated or changed.** The
consequence is stated plainly: the acknowledgement is a build-time gate, not
an artifact fact — a release root says nothing about which list it was built
under.

## The mechanism — an acknowledged-unbound ratchet

`validateUnboundPermissionAcknowledgement` in `packages/compiler/src/
conformance.ts`, called from `validateModuleConformance` beside the other
package-level cells, so it runs inside `compileApplication` under `current`
conformance (not under `historicalReproduction`, exactly like every other
conformance cell — recorded lineage entries are reproduced, never re-judged).

- **Census:** `packageRevision.permissions` of the normalized package — never
  source text. Every lifecycle; a retired permission still compiles into
  reference data.
- **Bound set:** `EVALUATOR_BOUND_PERMISSION_IDS`, **empty by construction**,
  with the comment naming row `7` as what populates it.
- **Governed scope:** exactly the keys of the list's `packages` object; today
  `northstar.app:package.application`. A package with no key is ungoverned,
  which is what keeps the synthetic fixtures (`northstar.modulefixture`,
  standalone module compiles, the shell demo) compiling.
- **`COMPILER_PERMISSION_EVALUATOR_UNBOUND`** (subject = the permission id): a
  declared permission not in the bound set and not acknowledged.
- **`COMPILER_PERMISSION_ACKNOWLEDGEMENT_STALE`** (subject = the entry's
  permission id): an entry whose permission the package no longer declares
  while the entry's resource entity is still present; an entry whose resource
  disagrees with the declaration; an entry for a permission the bound set
  contains; a duplicated entry. **The list can only shrink.**
- **An unreadable list fails closed:** any shape other than the versioned one
  governs every package with an empty acknowledgement, so every declared
  permission is refused rather than silently ungoverned.
- **Row `7` empties it.** At zero entries the refusal is absolute.

Why a stale entry is judged only when its resource entity is present: three
fixtures strip whole modules from the composed application (entities and
permissions together — `surface-grammar-conformance.test.ts`,
`module-storage-transition.test.ts`) and keep the composed package id. Judging
their missing permissions as rot would be a false red on a partial
composition. Whole-entity removal is instead caught by the census test below,
which reads the full composition and compares the list to it exactly.

## Controls

Nine tests in `test/compiler/g2-module-conformance.test.ts`, all prefixed
`unbound-permission acknowledgement:` — the name pattern the manifest runs.

| test | claim it holds |
|---|---|
| the unchanged composed application builds, and the acknowledgement is exactly its declared census | admission twin, plus the rot closer: the composed package is a key, and the entries equal the declared `{permissionId, resource}` census with no duplicates |
| a permission the composed application declares and nothing acknowledges refuses the release by name | claim 1 — a new permission not on the list REDS, through the real compiler on the real composition |
| removing the acknowledgement of a permission the package still declares refuses it by name | claim 3, at the rule level |
| an entry naming a permission the package no longer declares is stale while its resource is present | claim 4 — the list cannot rot |
| an entry whose resource entity is absent is not judged | the partial-composition limit, stated as a test |
| an entry whose resource disagrees with the declaration is stale | a re-pointed permission re-announces itself |
| a permission an evaluator binds leaves the list, and stays listed only as rot | the shrink direction row `7` will drive |
| a duplicated entry is stale | the list carries nothing twice |
| a package the list does not key is ungoverned, and an unreadable list fails closed | the scope limit and the fail-closed shape |

## Expected-red manifest — the recorded reds

`test/evidence/policy-unbound-refusal.expected-red.json`, five entries, each
varying one property.

| entry | mutation | kills | measured |
|---|---|---|---|
| `unbound-check-removed` | `conformance.ts`: a bare `continue` at the top of the unbound branch, so an unacknowledged permission is skipped with nothing emitted and nothing thrown (the first cut compared the lookup against `null` and died of a `TypeError` on the next line instead of the vacuum — re-cut in `c191221`) | claim-1 test, claim-3 test, fail-closed test | 3 killed at `c9062f5` |
| `acknowledgement-entry-removed` | the JSON: the `party_create` entry deleted | the census test, `COMPILER_PERMISSION_EVALUATOR_UNBOUND … party_create` | 2 killed at `c9062f5` |
| `stale-entry-added` | the JSON: an entry for `stock_count_probe_stale` on the present `stock_count` entity appended | the census test, `COMPILER_PERMISSION_ACKNOWLEDGEMENT_STALE … stock_count_probe_stale` | 2 killed at `c9062f5` |
| `stale-check-removed` | `conformance.ts`: the presence check keyed on the permission id instead of the entry's resource | claim-4 test | 1 killed at `c9062f5` |
| `governed-package-key-renamed` | the JSON: the composed package key misspelled, so the release is ungoverned | the census test (`must be governed`), claim-1 test | 2 killed at `c9062f5` |

The admission twin is measured by the runner itself: every entry's suite must
pass with production restored before the mutation is applied, and the census
test is in every entry's population.

**Vectors NOT individually controlled, and why.** (a) The domain-edit route —
appending a permission to `packages/domain/src/*/definition.ts` and building —
is exercised by hand in *Test it yourself* rather than by a manifest entry,
because a mutation of a file outside this lease couples the manifest's
`original` text to a file the next module packet will edit (the
`migration-range-encoded-in-a-test-title` class). The claim-1 test appends
the same object to the same composition through the same compiler; the only
difference is who appends it. (b) The press law not flagging the JSON is shown
by `test:architecture` green, not by a mutation. (c) `check:app-release`
refusing a real edit is observed, not mutated — see *Test it yourself*.

## What this packet does NOT claim

- It does not authorize anything. Every principal still holds every declared
  permission; row `7` is the kernel and this packet is the announcement.
- **Ungoverned today:** the `platform` module (not mounted, so no release
  carries its five permissions — the moment it is mounted they enter the
  composed census and refuse by name), the shell demo release
  (`northstar.shell:package.demo`, one permission, served by `demo-server.ts`
  only), and standalone module compiles in unit tests. The gate is on the
  application release build, which is what the charter asked for.
- A partial composition that removes an entity and its permissions is not
  accused of rot; the census test is the closer, and it reads the full
  composition on every `test:compiler` run.
- The acknowledgement is not hashed into any artifact. A list change alone
  mints no lineage entry and moves no root.
- Recorded lineage entries are reproduced under `historicalReproduction`,
  which skips every conformance cell including this one, by design.
- **What row `7` inherits, filed as one line in the archive:** the bound set
  is a compiler-internal constant. The runtime's evaluator registry cannot be
  imported by the compiler (dependency boundaries), so when row `7` binds
  evaluators the binding census will have to reach the compiler as data the
  same way the acknowledgement does — a second checked-in list, or a compiler
  input — and that is a design decision row `7` owns.

## Gates and SHAs

All at the executable freeze `c9062f5` unless stated. Cheap gates were also
green at every intermediate commit.

| gate | result |
|---|---|
| `format` | green |
| `typecheck` | green |
| `lint` | green |
| `test:unit` | 155/155 (at `1f6eca2`; no unit-suite input changed after it) |
| `test:compiler` | 166/166 at `1f6eca2`; the nine new tests 9/9 at every later commit — the full-matrix line below covers `c9062f5` |
| `check:app-release` | green; `build:app-release` rebuild byte-identical, `git diff --stat -- apps/web/release` empty |
| `check:demo-release` | green |
| `check:expected-red` | OK, 67 entries in 7 manifests |
| `check:expected-red-controls` | OK, 38 controls |
| `evidence:expected-red` (this packet's five entries, `--run`, exclusive lock) | OK — `unbound-check-removed` 3 killed, `acknowledgement-entry-removed` 2 killed, `stale-entry-added` 2 killed, `stale-check-removed` 1 killed, `governed-package-key-renamed` 2 killed; every entry's suite 9 passing with production restored |
| `test:integration` | 149/149 (at `1f6eca2`) |
| `test:architecture` | **188/189 at `1f6eca2`** — PRESS006 read a module permission id in the rule's own doc comment; corrected in `fbc2104`, `module-press-law.test.ts` 46/46 after it; the full-matrix line below covers `c9062f5` |
| full matrix, first attempt (`~/2rain-missions/run-matrix.sh policy`, detached worktree `/home/rvham/2rain-greenfield-pur-matrix` at `c9062f5`) | **FAILED at `test:postgres` 222/223**, every earlier stage green (schema, both releases, unit 155/155, compiler 166/166, integration 149/149, agent 3/3, architecture 189/189, contracts 29/29). The one red is `module-storage-transition.test.ts` › *fold-function drift surfaces the specific diagnostic before a terminal claim mismatch* with `ephemeral PostgreSQL is ready inside its container but its published endpoint is unavailable: ECONNREFUSED 127.0.0.1:51966` — the READINESS manifestation `container-pressure-forges-outcomes` records verbatim from `PUR-2a` round 6. That file is `ENUM-WIDEN`'s and byte-identical to `main` in this tree; nothing in this packet touches a container. Docker held **462 dangling anonymous volumes** (10.3 GB reclaimable) at the time. The lane pruned dangling volumes only (the user's four stopped dev containers were left alone) and re-ran at the same SHA. |
| full matrix, second attempt (same command, same worktree, same SHA, six seconds after the prune reclaimed 10.2 GB) | **INDETERMINATE at its first stage**, `test:performance` 4/5: `COMPILE_BUDGET_INDETERMINATE: observed CPU idle 57.1% is below required 90.0%; rerun the exclusive gate` — the gate refusing to judge under load rather than a red; the same suite run alone thirty seconds later was 5/5 with the first attempt's cold compile at 1235 ms against a 5000 ms budget. |
| full matrix, third attempt (same command, same worktree, same SHA) | **PASS — `FULL_MATRIX_PASS_SHA=c9062f5f68aed64b6b437f9a8519342cf3395997`**: performance 5/5, unit 155/155, compiler 166/166, integration 149/149, agent 3/3, architecture 189/189, contracts 29/29, PostgreSQL 223/223, locale 1/1, browser 93/93, observability producer 11/11, language coverage PASS (2050 obligations), reachability 106/106, security scans passed, schema 23 migrations verified, both release checks green |
| `test:architecture` and `format` re-run at the narrative head `87878a6` | architecture **189/189**, prettier clean — the two suites that read narrative, re-run past the docs commits per `git-workflow`; `git diff --name-only c9062f5 87878a6` outside `docs/` is empty, so every other suite carries forward |
| `scripts/check-records.sh` at `87878a6` | `records: OK (138 record(s), 6 declaring: 47 claimed path(s) and 73 claimed symbol(s) observed in their frozen trees; 159 ledger row(s), ids unique)` |

Three expected-red rounds were needed before the manifest was honest, and
each was the runner doing its job: the first found an undeclared victim (the
fail-closed test rides the unbound branch), the second found the mutation
dying of a `TypeError` rather than the vacuum it claimed, the third found the
probe test dying under both list mutations because the refusal then names two
permissions. All three are in the commit history rather than hidden.

## Declaration

The last executable commit is `c9062f5f68aed64b6b437f9a8519342cf3395997`; the
commits above it are narrative (this record, the ledger, lanes and archive rows).
Four executable commits: `1f6eca2` (the rule, codes, list, tests, manifest),
`fbc2104` (the fail-closed kill declared; the press-law literal removed from the
rule's comment), `c191221` (the first mutation re-cut as a silent skip),
`c9062f5` (the probe test declared as a kill of both list mutations).

```record-claim
{
  "schemaVersion": "northstar.record-claim/v1",
  "packet": "policy-unbound-refusal",
  "base": "4218a66068041eb04e45e6fff4883c8aa8dfaebf",
  "head": "c9062f5f68aed64b6b437f9a8519342cf3395997",
  "changedPaths": [
    "packages/compiler/src/conformance.ts",
    "packages/compiler/src/diagnostics.ts",
    "packages/compiler/src/unbound-permission-acknowledgement.json",
    "test/compiler/g2-module-conformance.test.ts",
    "test/evidence/policy-unbound-refusal.expected-red.json"
  ],
  "symbols": [
    {
      "path": "packages/compiler/src/conformance.ts",
      "name": "validateUnboundPermissionAcknowledgement"
    },
    {
      "path": "packages/compiler/src/conformance.ts",
      "name": "readUnboundPermissionAcknowledgement"
    },
    {
      "path": "packages/compiler/src/conformance.ts",
      "name": "EVALUATOR_BOUND_PERMISSION_IDS"
    },
    {
      "path": "packages/compiler/src/diagnostics.ts",
      "name": "COMPILER_DIAGNOSTIC_COPY"
    },
    {
      "path": "test/compiler/g2-module-conformance.test.ts",
      "name": "composedPermissionCensus"
    }
  ]
}
```

## Test it yourself (under ten minutes, no diff reading)

From the repository root on branch `packet/policy-unbound-refusal`, with
`corepack pnpm install --offline` done. The release build reads the checked-in
`apps/web/release/app.authored.json`, which `generate-app-authored.ts` derives
from the domain — so every domain edit below is followed by the generator.
The lane ran this exact sequence at `c9062f5` and recorded what it saw.

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
   to the array in `packages/compiler/src/unbound-permission-acknowledgement.json`
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
   git checkout -- packages/compiler/src/unbound-permission-acknowledgement.json apps/web/release/
   corepack pnpm check:app-release
   ```

   Observed: `git status` clean, `check:app-release` exit 0.

## Review prompt — paste as written; the lane fenced nothing

Review packet `policy-unbound-refusal` in `/home/rvham/2rain-greenfield` (or any fresh clone of `origin`). Read `AGENTS.md`, then `.agents/skills/review-tiers/SKILL.md` — "Evidence depth follows FAILURE OBSERVABILITY", "Does the evidence prove the claim?", "A refusal control needs its admission twin", "A negative control must vary one property" — then `docs/execution/packets/policy-unbound-refusal.md` in full, then the diff.

This prompt was written by the lane whose work you are reviewing. The lane has fenced nothing. Any scope stated here is the orchestrator's, and it stands as a claim under test rather than a limit you may not question. Read whatever you judge relevant to the decisive questions, say plainly if you think the scope is drawn wrongly, and say plainly if the prompt itself is steering you.

TARGET. Branch `packet/policy-unbound-refusal`, frozen at `87878a69226957a5ac5a462f8093c1669bd8e8b3`. `git ls-remote origin refs/heads/packet/policy-unbound-refusal` returned:

```
$ git ls-remote origin refs/heads/packet/policy-unbound-refusal
87878a69226957a5ac5a462f8093c1669bd8e8b3	refs/heads/packet/policy-unbound-refusal
```

The last executable commit is `c9062f5f68aed64b6b437f9a8519342cf3395997` (`git diff --name-only `c9062f5f68aed64b6b437f9a8519342cf3395997` `87878a69226957a5ac5a462f8093c1669bd8e8b3` -- . ':!docs' ':!.agents' ':!CLAUDE.md' ':!AGENTS.md' ':!learnings.md'` is empty; the commits above it are the packet record, ledger, lanes and archive rows). Read the delta `4218a66..`87878a69226957a5ac5a462f8093c1669bd8e8b3``. Base is `4218a66068041eb04e45e6fff4883c8aa8dfaebf`, `origin/main` at cut. Full matrix: Full matrix **PASS — `FULL_MATRIX_PASS_SHA=c9062f5f68aed64b6b437f9a8519342cf3395997`**: performance 5/5, unit 155/155, compiler 166/166, integration 149/149, agent 3/3, architecture 189/189, contracts 29/29, PostgreSQL 223/223, locale 1/1, browser 93/93, observability producer 11/11, language coverage PASS (2050 obligations), reachability 106/106, security scans passed, schema 23 migrations verified, both release checks green (third attempt at the same SHA; the first failed one PostgreSQL test on the recorded container-readiness manifestation, the second was indeterminate under post-prune CPU load — both in the record).

TIER. Critical — a compiler refusal placed in the release build's path; wrong in one direction it blocks every release, wrong in the other it certifies the silent vacuum it was built to end. Band B declared: the failure is visible the first time a release is built.

THE CHARTER'S SCOPE, AS THE ORCHESTRATOR WROTE IT (a claim under test, not a fence): program review R7 small (a) — a declared permission with no evaluator binding must announce itself at compile time. The full authorization kernel is queue row 7 and is not this packet. The lease was `packages/compiler/src/conformance.ts` and `diagnostics.ts` (the rule and codes), the acknowledgement list, `test/compiler/**`, the packet's expected-red manifest, and narrative; `packages/canonical-model/**`, `packages/domain/**`, `db/migrations/**`, `packages/compiler/src/storage.ts`, `module-storage-materializer.ts`, `protocol.ts` and `index.ts` were not the lane's.

THE LANE'S CLAIMS, WRITTEN TO BE TESTED.
1. The rule reads its census from `packageRevision.permissions` of the normalized package and never from source text, and it is wired into `compileApplication` under `current` conformance beside the other conformance cells.
2. On the unchanged tree, `check:app-release`, `check:demo-release` and the composed-application census test are green, and a `build:app-release` rebuild leaves `apps/web/release/**` byte-identical: neither the list nor the diagnostic reaches the compiled artifact or any release root.
3. A permission the composed application declares and the list does not name refuses the compile with `COMPILER_PERMISSION_EVALUATOR_UNBOUND` whose `subjectId` is that permission id, and nothing else.
4. The list can only shrink: an entry naming a permission the package no longer declares on that resource, an entry whose resource disagrees with the declaration, an entry for a permission the bound set contains, and a duplicated entry each refuse with `COMPILER_PERMISSION_ACKNOWLEDGEMENT_STALE`.
5. An unreadable list fails closed: every declared permission in every package is refused, none is silently ungoverned.
6. Governance is keyed by package id and the composed application is the only key; the census test pins that key and pins the entries as exactly the declared `{permissionId, resource}` set, so the key and the entries cannot drift silently.
7. The list is JSON because a TypeScript constant spelling module permission ids inside the generic press trips PRESS006 (`module-press-law.test.ts`) — measured: the rule's own doc comment tripped it once — and because a field on the canonical permission object would be a language-version event under ADR-0021's rule. The lane claims this is the honest home and not an evasion of the press law.
8. Five expected-red entries each vary one property and kill exactly the declared tests for the declared reasons; the runner recorded them at the frozen tree.

WHAT THE LANE DID NOT VERIFY, COULD NOT VERIFY, OR VERIFIED ONLY BY ITS OWN CONSTRUCTION.
- The stale check is judged only when the entry's resource entity is present, so a partial composition that strips an entity and its permissions is not accused of rot. The closer is the census test reading the full composition. The lane did not construct a fixture that keeps an entity but strips only some of its permissions on the composed package id; it grepped for such fixtures and found none, which is a read, not a control.
- The shell demo release (`northstar.shell:package.demo`), the unmounted `platform` module, and standalone module compiles are ungoverned by construction. The lane asserts this is the charter's "application release build" and nothing more; you may disagree.
- The domain-edit route (append a permission to a module definition, build, watch the refusal) is exercised only by hand in "Test it yourself" and by the claim-3 test appending the same object to the same composition; it is not a manifest entry, and the lane's reason (coupling the manifest to a file outside its lease) is a judgement.
- No mutation covers the "bound permission stays listed" or "duplicate entry" branches; they are tested but not mutated. Band B was declared: one discriminating red per claim, not per branch.
- Whether the acknowledgement being un-hashed (a release root says nothing about the list it was built under) is acceptable is a design claim the lane made, not measured.
- All controls are self-chosen. `review-tiers` says a self-chosen table measures its author's model and is worth strictly less than an independent replay.

DECISIVE QUESTIONS.
A. Does the claim-3 control (a permission appended to the real composition refused by name through `compileApplication`) prove the release build refuses, given that `check:app-release` and `build:app-release` compile the serving head through `mustCompile` under `current` conformance? Trace it; do not take the record's word.
B. Is there any path by which a first-party permission reaches a release without passing this rule — `historicalReproduction`, `--truncate-invalid-lineage`, the demo release, a package id other than the composed one — that the record fails to name as a limit?
C. Do the five reds each vary exactly one property, kill exactly the declared victims, and die for the declared reason? Would deleting each rule branch red at least one committed control (the "dies alone" test)?
D. Is the JSON-beside-the-rule home honest under the press law, or is it an evasion the routed-debt table should have recorded instead? Say which.
E. Does anything in the diff exceed the lease or the tier, and does the record claim more than the evidence proves?

OUT OF SCOPE PER THE ORCHESTRATOR'S CHARTER (stated as claims, not fences): the authorization kernel itself (row 7); RLS on `module_storage_backfill_checkpoints` (R7 small b); binding the compiler's bound set to a runtime evaluator registry; anything under `packages/canonical-model/**` or `packages/domain/**`.

THREAT MODEL. Foundation stage: accidental and plain omissions by honest developers or AI writers — a module packet declaring permissions and forgetting the vacuum — not an adversary editing the acknowledgement list to hide a permission.

VERDICT FORMAT. PASS, REVISE or BLOCK, then findings ranked by severity, each with file and line at the frozen SHA, what you observed versus what the record claims, and whether the defect is in production, in a control, or in the claim's prose. A round with zero production defects converges the review (ruled 2026-09-01).

