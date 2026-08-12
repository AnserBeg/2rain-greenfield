# dev-environment — the application can be opened and looked at

**Tier:** Behavioral. The diff changes what a human sees when they run the
application and how a container-bearing path ends its life. It adds no
invariant, no gate, and no compiler or release output.

**Branch:** `packet/dev-environment`, cut from `main` at `08d6465`.

**Worktree:** `/home/rvham/2rain-greenfield-devenv`, per the convention
`git worktree list` shows and `matrix-must-pin-its-tree` prices.

---

## 1. The charter's premise was wrong, and that is the packet's first finding

The `dev-environment` row says nobody can open the application, that
"every human view of a data surface goes through a test harness", and that
"the mechanism to fix it already exists four times over and is test-only" —
naming `test/fixtures/g2/{catalog,location,party,saved-filter}/runtime-harness.ts`.

**A composed-application dev server already exists and is not a test harness.**

`apps/api` — a workspace package with a `dev` script — has since `G2-P5e`:

- read `apps/web/release/app.compiled.json`, the compiled release, as its only
  definition source (`composition-root.ts:77-82`);
- installed it with `createComposedApplicationRuntime`
  (`packages/postgres-provider/src/composed-application-runtime.ts`, 2,177
  lines of **provider-owned production code**, not a fixture);
- seeded records through the real `SemanticOperationGateway`;
- served them through `createSurfaceRuntimeServer` with the full gateway set,
  on `http://127.0.0.1:4174`;
- started its own PostgreSQL container to do it.

The ledger already records a human using it. `G2-P5e`'s row states the
orchestrator "created a Party through the browser form (POST 200, 'Create
complete.'), read it back through the list, and confirmed the row directly in
PostgreSQL". Four later packet records — `G2-P5d-a`, `G2-P5d-a1`, `G2-P5d-b`,
`G2-P5d-nav` — carry `pnpm --filter @north-star/api dev` in their
"Test it yourself" steps.

**How the row came to be wrong is more useful than the fact that it is.** The
measurement behind it was of `apps/web`'s `pnpm dev`, and every statement it
makes about that script is correct: `demo-server.ts` is hardcoded to
`shell.compiled.json`, serves four shell surfaces, and cannot be pointed at
`app.compiled.json` for exactly the structural reason given. The row then
generalised from one package's `dev` script to the repository. `apps/api`'s
`dev` script was never examined.

**The four harnesses would have been the wrong mechanism to derive from.**
They compile *per-module fixtures* — `compileCatalogFixture()` and its
siblings — and assemble a runtime around one module. Deriving a dev server
from them would have hand-assembled a variant of the application from module
fixtures, which is precisely the second-authority hazard the row's own
constraint (2) forbids. The correct mechanism was the one the row did not
name.

**They are also not four instruments.** `catalog` and `location` are 706-line
files differing in **46 lines** after module-name normalisation — 93%
identical; `party` is the same machinery again. `saved-filter` is a different
thing entirely (an admission-refusal observer, 349 lines, no server, no
`withReal*Runtime`). So the shape is *three copies of one harness plus one
unrelated file*. Filed as a queue row; not repaired here, because those files
gate `test:postgres` and `test:browser` and the repair's risk profile has
nothing to do with letting a person open the application.

## 2. What was actually broken

Three defects, all in the dev path that existed.

### 2.1 The dev container was named into the matrix's refusal namespace

`main.ts` defaulted its container to **`north-star-composed-app`**.

`scripts/guard-ephemeral-postgres.mjs` scans `name=^/north-star-` and is
invoked from `scripts/run-matrix.sh:88` — **after** the exclusive lock is
acquired at line 69. Consequences, both measured from the source:

- A dev container younger than `NORTH_STAR_CONTAINER_STALE_SECONDS` (3600)
  makes the matrix print `POSTGRES_CONTAINER_CONTAMINATION` and exit **76**,
  having already taken and burned the slot. With three lanes queueing for that
  slot, the dev environment and the test matrix were mutually exclusive.
- A dev container older than an hour is `docker rm --force`d by `sweepStale`,
  which checks **age only** and never asks whether an owner is alive. A dev
  session past the hour mark would have its database destroyed under it.

The four packet records above instruct the user to set
`NORTH_STAR_DATABASE_CONTAINER=north-star-g2-…`, so the hazardous name is not
hypothetical — it is copy-pasteable out of the repository's own docs.

### 2.2 The container outlived its session by construction

`main.ts`'s `stop` closed the HTTP server and the runtime pools. **Nothing
stopped or removed the container.** It kept running, holding its port and its
volume, after the process that created it exited — which is the shape
`leak-guard-orphan` records, arrived at deliberately rather than by a
guardian failure.

### 2.3 The seed rebuilt module identifiers by string concatenation

`composition-root.ts` built its field and operation identifiers as
`` `${applicationNamespace}:field.${localField}` ``. The modules declare those
identifiers in `APPLICATION_IDS` (`packages/domain/src/app/builder.ts`). A
seed that reconstructs them keeps compiling after a module renames a field —
constraint (3)'s "second authority in a different costume", present in the
existing code.

It was also 12 records: 4 parties, 4 items, 4 locations. Below the point where
any list paginates (`maximumResultCount` is **100**) or any search is worth
pressing.

## 3. What this packet changed

| Path | Change |
|---|---|
| `packages/domain/src/app/seed.ts` | **New.** Seed authored beside the module definitions, bound to `APPLICATION_IDS`. Two profiles. |
| `apps/api/src/composition-root.ts` | Seed table removed; takes a `seedProfile` option, default `demo`. |
| `apps/api/src/main.ts` | Container renamed out of `north-star-*` and the prefix **refused**; container stopped on exit; asks for the `distributor` profile; prints the surface URLs. |
| `apps/api/package.json` | `dev:stop`, `dev:reset`. |
| `apps/web/package.json` | `dev` → `serve:shell-fixture`. |
| `package.json` | Root `dev` → the composed application. |
| `packages/domain/package.json` + 5 index files | **Bridge, forced.** `"type": "module"` and four `.js` extensions — see §3a. |

### 3a. The bridge this packet had to take, and why it is not optional

**`packages/domain` was the only workspace package without `"type": "module"`.**
`postgres-provider`, `compiler`, `runtime` and `canonical-model` all declare it.

This was invisible until constraint (3) was satisfied. Authoring the seed beside
the modules means `apps/api/src/composition-root.ts` imports
`packages/domain/src/app/seed.ts`, and the browser suite imports
`composition-root.ts`. Playwright therefore pulled `packages/domain` into its
transform for the first time, treated it as **CJS** because the manifest said
nothing, and `require('./builder.js')` looked for a literal `builder.js` that
does not exist:

```
Error: Cannot find module './builder.js'
Require stack:
- packages/domain/src/app/seed.ts
```

**Every file in `packages/domain` uses `.js` specifiers**, so this is not about
one import. Rewriting specifiers instead was tried and rejected: dropping the
extension in `seed.ts` moved the identical failure one level down, into
`builder.ts` and its four `../<module>/definition.js` imports.

**So the constraint the charter set — seed data authored where the modules are
— is unsatisfiable from the composition root until `packages/domain` is an ES
module.** The fix is 9 lines: the manifest, plus `.js` extensions on five
re-exports that only resolved because the package was CJS (`node16` resolution
rejects extensionless relative specifiers under ESM).

**This is a bridge outside the charter's pre-authorised list and it touches a
shared package manifest, so it is declared rather than absorbed:**

- **`packages/domain/src/index.ts` is held by `packet/pur-1`**, which is adding
  a purchasing module export. My change is four `.js` suffixes on adjacent
  lines; a merge will likely need a hand resolution, and the resolution is to
  keep both.
- It makes `packages/domain` consistent with every sibling package, and
  corrects a real import shape: before it, a dynamic `import()` of a domain
  module yielded `{ default: … }` instead of its named exports. Measured both
  ways.
- It was verified rather than assumed — see §6b.

### The seed profiles

- **`demo`** — the previous 12 records, **serialization-identical**. The first
  version of this claim said "byte-identical" and was **not measured**: the
  scratch comparison sorted the value keys before comparing, so it established
  *deep* equality only, and the four Location records genuinely had different
  bytes because the new builder emitted `code, type, name` where the old one
  emitted `code, name, type`. Round 1 review caught both halves. The key order
  is restored, and `test/unit/dev-environment.test.ts` now compares
  `JSON.stringify` output against the prior seed **recorded as a literal in the
  test**, so the expectation cannot be moved by the subject. This matters
  because
  `apps/web/test/browser/composed-application.spec.ts:2281` asserts
  `seededRecords` has length 12 and line 872 reads back the
  `Alpine Office Supply` cell — **and that file is held by `packet/pur-1`**, so
  it must not need editing.
- **`distributor`** — a superset: **176 records — 119 items, 45 parties, 12
  locations.** 119 items is above the declared page size of 100, so the item
  list paginates. Items are authored as families expanded into variants so the
  catalogue reads like a real one rather than `Item 037`.

### The rename

The row asks for one: *"the fixture server should be named for the fixture it
serves, and `dev` should mean the application or not exist."*

- `apps/web`'s `dev` → **`serve:shell-fixture`**. It serves
  `shell.compiled.json`, a compiled shell fixture; the name now says so.
  Nothing else in the repository referenced that script.
- Root **`dev`** now runs the composed application, so `pnpm dev` means the
  application.

`repository-hygiene` pins only `test:*` suite scripts, so neither rename
touches a gate.

## 4. The three constraints

**(1) No second authority for how the application is composed.** The dev path
reads `app.compiled.json` and installs it through
`createComposedApplicationRuntime`. It does not compile, does not assemble a
variant, and does not import a module definition to build a runtime. The only
thing this packet added on that axis is *data*. The compiled release remains
the authority — as it already was.

**(2) The container.** Discussed in §5.

**(3) Seed beside the modules — and the first version of this claim was
false.** Round 1 review found it, and it is worth stating exactly.

`seed.ts` sits in `packages/domain/src/app/` beside `builder.ts` and takes its
identifiers from `APPLICATION_IDS`. **That is not the same as being bound to
the module declarations.** Each module builds its identifiers privately through
its own `ids(namespace)` factory; `APPLICATION_IDS` is a *second,
hand-maintained spelling* of the same strings in `builder.ts`, and nothing
makes the two agree. Renaming `field.location_code` inside
`location/definition.ts` leaves `APPLICATION_IDS.location.fieldIds.code` — and
therefore the seed — fully type-correct. The original claim that a rename
"breaks the seed at the type level" was **wrong**, and so was the implication
that constraint (3) was met by construction.

Two identifiers were also still built locally: the `option.warehouse` and
`option.store` values, which the Location module generates independently from
`['warehouse', 'Warehouse']`.

**What is true now.** The seed still reads `APPLICATION_IDS` — that table is
not eliminated, and eliminating it means deriving it from the module `ids()`
factories, which is a change to `builder.ts` (**held by `packet/pur-1`**) and
is filed rather than taken. What closes the gap instead is a control that
checks the seed against **the compiled release**, which is the program's stated
authority and cannot be moved by either table:
`test/unit/dev-environment.test.ts` decodes
`app.compiled.json`'s head `normalizedDefinitionBytesBase64` and asserts every
seeded operation ID, every seeded field ID, and every seeded enum *value*
exists in it.

**The same control covers the startup banner**, which was an unguarded path the
review found: `main.ts` prints three surface URLs from `APPLICATION_IDS`, so a
surface rename would produce a valid compiled release and a banner of dead
links. Those three IDs are now asserted against the release too.

## 5. The container decision, stated explicitly

**It does not take a lease, and it is not offered one.**

A lease would be wrong on its face: the matrix lock serialises *suites*, and a
dev database is held for hours. Taking the exclusive lease would block every
lane; taking a shared one would claim a participation in the lock protocol it
does not have.

**What stops it racing a matrix:**

- **It cannot trip the container guard.** The guard's subject is
  `name=^/north-star-`. The dev container is `dev-composed-app-postgres`, and
  `main.ts` now **throws** if the name is configured into that prefix — the
  hazard is made unrepresentable rather than documented, because four packet
  records still carry the hazardous invocation.
- **No port race.** It publishes one fixed port (55432, configurable).
  Ephemeral test containers publish ephemeral ports.
- **No volume accumulation.** One named volume, reused across sessions.
  `matrix-machine-decay` priced *per-run* volume growth — 481 volumes, 12.96GB
  reclaimed. A single reused volume does not participate in that.
- **It stops when the session stops.** `SIGINT`/`SIGTERM` stop the container.

**Round 1 review found this section understated the leak, and it was right.**
The original code installed its signal handlers *after* `docker run` and after
a 60-second install, so a Ctrl-C during migration or the 176-record seed, an
occupied port 4174, or any database failure left the container running — none
of which is `kill -9`. `application.close()` rejecting also skipped
`docker stop` entirely, and a failed `docker stop` was swallowed by a
boolean-returning helper and exited 0. What is written above was true only of
the happy path. Now:

- handlers are installed **before** the container starts;
- **`containerAttempted` is set synchronously BEFORE the create/start command
  is launched, and the pending command is retained**; shutdown waits that
  command out before stopping. Recording ownership after the awaited
  `docker run` was the round-2 defect; recording it before is necessary but not
  sufficient, because the stop would then race ahead of the creation it undoes.
  There is no `containerExists` variable in the final tree;
- startup is wrapped, and `startComposedApplication` closes its runtime if
  seeding or `listen` throws, so the caller is never handed nothing to close;
- shutdown runs each step independently, collects failures, prints them, and
  **exits 1** — a failed `docker stop` is now an observable failure that also
  prints the `dev:stop` command.

**Observed, at `fa1b024`:** SIGTERM to the dev process mid-startup, before the
ready line → container `Exited (137)`. Port 4174 occupied against a warm
database → `START_FAILED … EADDRINUSE`, exit **1**, container `Exited (0)`. A
database connection failure during install → exit 1, container `Exited (0)`.

**What does NOT stop it, stated plainly:**

- **`kill -9` leaks it.** There is no detached guardian. The existing one
  (`test/helpers/postgres-container-guardian.mjs`) hard-requires a
  `north-star-` prefix at line 17, so reusing it means editing the mechanism
  every PostgreSQL test depends on — a blast radius out of proportion to this
  packet. The residual is **one** named container on **one** fixed port with
  **one** bounded volume, invisible to the matrix guard, removed by
  `pnpm --filter @north-star/api dev:stop`. That is categorically unlike the
  test-container leak, where each leak is a *new* container and a *new*
  volume. Filed as a queue row rather than pretended closed.
- **It contends for CPU, RAM and disk like any other process.** An idle
  PostgreSQL is small, but `matrix-machine-decay` shows timing-bounded tests
  running near their limits, so running a dev database during a matrix is a
  real if modest cost. Nothing enforces this; it is the user's call.

## 6. `lease-derivation` — which trigger fires

The row's trigger: *the first packet that adds a new test entry point, a new
container-bearing path, or a third registry producer.*

**This packet fires none of the three, and the reason is the finding in §1.**

- **No new test ENTRY POINT** — no suite script is added, so the trigger does
  not fire on that axis. **But one new test FILE is added**,
  `test/unit/dev-environment.test.ts`, so **`test-inventory-third-copy` does
  apply and was honoured**: it is registered in all three inventories that row
  names — `package.json`'s `test:unit`, `repository-hygiene`'s reviewed list,
  and `test/helpers/reachability-producers.ts`. *(An earlier revision of this
  record said no test file was added and the row did not apply. That was
  written before the controls existed and was false by the time it shipped;
  round 5 caught it.)*
- **No new registry producer.**
- **No new container-bearing path.** The container-bearing path is
  `apps/api/src/main.ts`, and it has stood up a container since `G2-P5e`. This
  packet renames it and gives it an ending; it does not create it.

**What this packet assumes about the row's answer**, since it does not solve
it: that the authority for "container-bearing path" must be **a real process
edge**, not a helper-call marker. Concretely —

`test/architecture/test-lock-observability.test.ts:39` derives the set with
`containerCallPattern = /\bwithEphemeralPostgres\s*\(/u`, and its own comment
records that "workspace manifests are not scanned here at all". So
`apps/api`'s `dev` script is invisible on **both** counts: it is a workspace
manifest script, and it reaches Docker through
`execFileAsync('docker', ['run', …])` rather than through the helper.

**A container-bearing path has therefore been outside the census since
`G2-P5e`** — which is `lease-derivation`'s abstract claim ("a gate that asserts
a *necessary* condition where its name claims the *sufficient* one") with a
concrete, pre-existing instance attached. This packet does not close it; it
supplies the specimen.

## 6a. What was observed by running it

Measured on `5bfd1ab`, worktree `/home/rvham/2rain-greenfield-devenv`.

| Claim | Observation |
|---|---|
| The application serves the composed release | `COMPOSED_APPLICATION_READY {"baseUrl":"http://127.0.0.1:4174","releaseRoot":"b0177bf4…2bbb","seededRecords":176}` |
| Lists paginate | Item list pill reads **`1–100 of 119`**, 100 data rows, and a `Next page` link carrying a `cursor` |
| The other lists fill | Parties **`1–45 of 45`**, Locations **`1–12 of 12`** |
| Records open | `party_detail&record=71000000-…-0001` renders `<h1>Alpine Office Supply</h1>` |
| Search works | `&q=Cascade` on the party list → `1–1 of 1`, "Cascade Fastener Works" |
| Navigation exists | 12 compiled groups: Party, Party role, Catalog, Location, Inventory movement, On-hand lookup, Inventory period lock, Inventory transaction line, Inventory transaction, Legal entity, Stock count line, Stock count |
| The write path works | POST to `location_form` → *"Create complete. The saved record is reflected below and its trust evidence is linked."*, State Active, revision 1; list then reads `1–13 of 13` |
| The container stops with its session | `SIGTERM` → `Exited (0)`, port 4174 stops answering |
| Data survives a restart | Second `pnpm dev`: same `tenantId`, same `releaseRoot`, 176 records, `1–13 of 13` still including the hand-created record — **the seed is idempotent against a persisted database** |
| The dev container is invisible to the matrix guard | With `dev-composed-app-postgres` **running**, `docker ps --all --filter name=^/north-star-` (the guard's exact filter) returns empty, and the `DEVENV` matrix passed `guard-ephemeral-postgres.mjs post-lock` without `POSTGRES_CONTAINER_CONTAMINATION` |
| `kill -9` leaks the container | **Observed.** `kill -9` of the app left `dev-composed-app-postgres` `Up`. This is `dev-container-unguarded`, measured rather than predicted. |

**Two open rows confirmed live, neither repaired (out of scope by charter):**

- **`ux-picker`** — every form field is a bare `<input>`. `location_form`,
  `item_form` and `party_role_form` render **zero `<select>`, zero
  `<datalist>`, zero `<textarea>`** between them. `location_type` is a
  declared 2-option enum and still renders as a text box into which the
  operator must type `northstar.app:option.warehouse`.
- **`ux-list-usability`** — the Record column renders `71000000…0001`. The row
  does link through to the detail surface, so the list is navigable; the
  identity shown is the truncated UUID.

**Consequence for the checkpoint, stated because the charter asked for
something that does not exist yet:** there is **no dropdown of any size** in
this application today, so "a dropdown with more than five options" cannot be
demonstrated. The seed makes the *data* exceed five options many times over —
45 parties, 119 items — and `ux-picker`/`ux-reference-picker` are the lanes
that will render them. What the seed does deliver now is a list that
paginates, a search that discriminates, and a record that opens.

## 6b. Gates — the full matrix is GREEN at the candidate SHA

**This section describes the FINAL tree only.** Earlier revisions accumulated
one round's SHAs after another; round 5 blocked on exactly that, because an
integrator following a stale acceptance SHA would verify the wrong tree.

| | |
|---|---|
| **Candidate SHA** | `e0f25521fa60e92858fff9bfbfb7b462e46cd9bc` |
| **Base** | `8cab25a2a434b75d3dc732bd5bf40dbaa8536524` (`main`) |
| **Matrix** | `FULL_MATRIX_PASS_SHA=e0f25521fa60e92858fff9bfbfb7b462e46cd9bc` |
| **Exit** | `MATRIX_EXIT=0` |
| **Tree pin** | `PINNED_BEFORE` and `PINNED_AFTER` both `e0f2552` |
| **Failures** | **0**, every suite |

Suite totals from inside the log: performance 5, unit **120**, compiler 145,
integration 127, agent 3, architecture 141, contracts 16, postgres **197**,
locale 1, browser **77 passed**, plus 11 in the load-tolerant tail.
`check:language-coverage`, `check:reachability` and the security scans all ran.
`format` and `lint` pass — `packet/matrix-unblock` landed the repair for the 14
format and 7 lint failures that had made a green matrix unreachable from `main`
for every lane, and that row is closed by its integration rather than by
anything here.

**The closeout commit above this SHA is docs-only.** The evidence that the
`e0f2552` matrix still applies is the empty executable diff:

```
$ git diff --name-only e0f2552 HEAD -- . ':!docs'
        (empty)
```

Written against `HEAD` deliberately rather than a literal successor SHA: this
record IS the closeout commit, so any SHA quoted here is stale the moment the
commit is created or amended. The check is the invariant, not the hash.

Under AGENTS.md §6 a run over an identical executable tree observes nothing
new, so `e0f2552`'s matrix is the acceptance run for the closeout tip. `main`
is an ancestor, so integration is a fast-forward.

**Read one detail honestly:** the log contains three `TEST_GATE_LOCK_BUSY`
lines. All three are **TAP comments** (`#`-prefixed) from
`test-lock-observability`'s own controls against `*-control-*` lock paths with
0s timeouts — that suite provokes lock-busy deliberately.
`grep -c '^TEST_GATE_LOCK_BUSY'` is **0**: the matrix never hit it.
`lockout-reads-as-silence` warns about missing a real one; this is the mirror
case, and the discriminator is the `#` prefix and the `-control-` path.

**Windows spent, and why.** Two runs refused before testing anything with
`COMPILE_BUDGET_INDETERMINATE` (59.8% and 84.6% idle against a 90% floor). In
neither case was a repository command responsible: `ps --sort=-pcpu` found
**six `ccd-cli` agent sessions at `--effort xhigh`** holding ~75% of CPU — the
orchestration tooling starving its own gate. Filed as
`foreign-detector-misses-cpu-heavy-gates`. Subsequent runs were launched by a
poller that waits for ≥93% idle and a free lock.

## 7. What this packet did NOT verify

Listed for the reviewer, not excused. Rewritten after round 1, which found two
claims in the previous version of this list that were themselves wrong.

**Now covered by committed controls** (`test/unit/dev-environment.test.ts`,
**14 tests**, registered in all three inventories `test-inventory-third-copy`
names). Each was driven red one at a time, and each mutation isolates to a
single failing test:

| Negative control | Result |
|---|---|
| Location value keys emitted in the old order | 1 red — the serialization test |
| A distributor-only **location** given an undeclared operation ID | 1 red — the release check |
| A distributor-only **item** given an undeclared field ID | 1 red — the release check |
| A distributor-only record given an undeclared enum option | 1 red — the release check |
| A distributor-only record with entirely valid identifiers (admission twin) | **stays green** |
| A printed banner surface renamed in `APPLICATION_IDS` | 1 red — the surface check |
| The `north-star-` prefix refusal deleted | 1 red — the prefix test |
| The retired-variable refusal deleted | 1 red — the retired-variable test |
| **The settle step removed from shutdown** | 1 red — the in-flight signal test |
| **Ownership recorded AFTER the awaited `docker run` — the exact round-2 defect** | 1 red — the in-flight signal test |
| **`process.exit(failures.length > 0 ? 1 : code)` → `process.exit(code)`** | 1 red — the stop-failure test |
| **The `COMPOSED_APPLICATION_SHUTDOWN_FAILED` writes deleted** | 1 red — the stop-failure test |
| **The `dev:stop` hint deleted** | 1 red — the stop-failure test |
| **The `dev:stop` hint moved outside its `failures.length > 0` branch** | 1 red — the clean-shutdown twin |
| A **successful** stop with the diagnostics intact (admission twin) | **stays green**: exit 0; stderr contains neither `COMPOSED_APPLICATION_SHUTDOWN_FAILED` nor the `dev:stop` cleanup hint; no container survives |

**The test's own title is still broader than its assertions**, and that is
recorded rather than repaired: `test/unit/dev-environment.test.ts:552` reads
*"exits zero and stays quiet when the container stop succeeds"*, while the
assertions exclude only the two diagnostics above and never require stderr to
be empty. Renaming it would change executable content and forfeit this
closeout's docs-only status — which is what carries the `e0f2552` matrix
forward. Whoever next touches that file should narrow the title to match; it is
a naming defect, not a coverage one.

Round 3 review found the shutdown controls stopped one layer short, and it was
right: `runShutdown`'s tests observed the helper's returned failures, while the
externally visible behaviour — writing the diagnostic and choosing exit 1 —
lives in `main.ts` *after* that helper returns. Both of the cheapest broken
trees it named were verified green against the round-3 controls before the fix:
deleting the exit-code choice, and deleting the diagnostic writes. The
spawned-entry-point harness is now parameterised on whether `docker stop`
succeeds, and a failing stop is observed **at the process boundary** — exit
code and stderr — with an admission twin, a **successful** stop. **What that
twin proves, exactly:** the process exits 0, stderr contains neither
`COMPOSED_APPLICATION_SHUTDOWN_FAILED` nor the `dev:stop` cleanup hint, and no
container survives. It does **not** prove stderr is empty; other output remains
admissible. An earlier revision claimed the twin proved the shutdown "stays
quiet", which is wider than the assertions.

**Round 4 (closure-only) returned BLOCK on that twin, and it was right.** The
twin asserted exit 0, no `COMPOSED_APPLICATION_SHUTDOWN_FAILED`, and no
surviving container — but **never that stderr lacks the `dev:stop` hint**. So
moving the hint out of its `failures.length > 0 && containerAttempted` branch
left **14/14 green** while every successful shutdown would falsely tell the
operator their container may still be running. Verified before fixing. The
assertion is added, and the hint's *placement* is now pinned from both sides:
making it unconditional reds the twin, deleting it reds the failure test. The
same round found this table describing the twin as "a failing stop"; it is
`stopFails: false`, a successful one, and the row is corrected above. The stub's failing stop deliberately returns a
*non-absence* error, because `stopContainer` treats "no such container" as
success and an absence message would prove nothing.

Round 2 review found the release-binding controls exercised only one of that
test's three checks: deleting the operation-ID or field-ID assertion would have
left every recorded result unchanged. Both now have isolated specimens. The
operation-ID mutation is applied to **location** records rather than items,
because mutating the item operation ID also empties the page-size test's filter
and reds two tests — varying two properties, which is the defect the checklist
names.

**A recorded limit of that test, not an implied claim:** it proves identifier
**membership** — that each seeded operation, field, enum value and printed
surface exists in the compiled release. It does **not** prove the operation,
entity and field compose into an executable write, and it would not catch a
field that exists but belongs to another entity.

**Still NOT verified by any control:**

- **`application.close()` rejecting is still only proved at the helper
  boundary.** The failing-stop path is now observed at the process boundary;
  the rejecting-close path is not, because reaching it needs a started
  application and the stub harness never gets one.
- **The hand-run observations in §5 remain hand-run.** SIGTERM-mid-startup,
  EADDRINUSE and the database-failure case were observed at `fa1b024` and are
  not reproducible from the tree. What IS now reproducible is the harder case
  round 2 identified — a signal while `docker run` is still executing — via a
  spawned-process control against a stub `docker`, plus direct controls for the
  rejecting-close and failing-stop branches.
- **The stub is not Docker.** The in-flight control proves the *ordering*
  property: the process waits out the create and issues a stop for what it
  created. It does not prove the real daemon behaves as the stub does, and a
  real `docker run` that leaks in some other way would not be caught.
- **`kill -9` is not covered by a control**, only observed once.
- **The seed is still not derived from the module `ids()` factories.** The
  control proves the seed agrees with the compiled release; it does **not**
  make `APPLICATION_IDS` and the module definitions unable to disagree. If they
  drift, the compiled release moves with the modules and the control reds —
  which is the outcome that matters — but the duplication itself remains, filed
  as `application-ids-is-a-second-spelling`.
- **The three-inventory registration is verified only by `test:architecture`
  passing.** No control proves the three lists agree with each other; that is
  `test-inventory-third-copy`'s open subject.
- **`build`, `check:schema`, `check:demo-release`, `check:app-release` and
  `test:locale` results** are recorded in the completion report; if any is
  absent there, it did not run.
- **`ux-list-usability`, `form-write-untyped-wire` and `form-empty-means-nothing`
  are out of scope by charter** and were not investigated.
