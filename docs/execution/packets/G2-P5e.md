# G2-P5e — The composed application

Status: evidence ready; frozen candidate reported in the writer handoff
Tier: Critical
Branch: `packet/g2-p5e`
Base: `a769981e2648b78764303190e89fb0c71b42faf3`
Frozen candidate: reported in the writer handoff because a commit cannot contain
its own SHA

## Outcome

G2-P5e turns the three accepted G2 business modules into one product a person
can start and use:

- Party, Catalog and Location are instantiated from their existing definition
  factories under one `northstar.app` namespace and owned by one canonical
  application package;
- the unchanged production normalizer and compiler generate a checked-in
  authored artifact and compiled application envelope without a compiler or
  canonical-model change;
- the PostgreSQL provider registers the bootstrap and application releases,
  materializes the module storage plan, obtains a real human approval, and
  activates through `PostgresReleaseActivationService` while the exact-swap
  trigger remains enabled;
- the provider constructs the existing request-view, Semantic Query and
  Semantic Operation gateways over least-privilege database pools;
- the previously empty `apps/api` is now the thin composition root and starts
  the existing web renderer against those real gateways; and
- a permanent PostgreSQL test and Playwright journey create a Party through the
  operation gateway, read it through the query gateway, reconstruct the
  composition root, and observe the same PostgreSQL row afterward.

The existing diagnostic shell is unchanged. Its authored and compiled release
artifacts still carry the intentional unsupported and renderer-failure
controls, and `pnpm dev` in `apps/web` still serves that shell. The product has
its own release artifacts and `@north-star/api` entrypoint.

Platform/saved filters are deliberately absent. Cross-package composition is
still unsupported; this packet uses the already-legal shape of several modules
inside one package and does not touch the composition seam.

## Established baseline

The branch was cut in an isolated worktree from exact SHA
`a769981e2648b78764303190e89fb0c71b42faf3`. The full baseline was green on its
first attempt:

| Gate | Baseline observation |
|---|---:|
| `format`, `build`, `lint`, `typecheck`, `check:demo-release` | green |
| `check:boundaries` | 113 files |
| `check:schema` | 12 applied / 12 verified |
| `test:unit` | 36 / 36 |
| `test:compiler` | 52 / 52 |
| `test:integration` | 59 / 59 |
| `test:agent` | 3 / 3 |
| `test:architecture` | 73 / 73 |
| `test:contracts` | 6 / 6 |
| `test:postgres` | 85 / 85 |
| `test:locale` | 1 / 1 |
| `test:browser` | 14 / 14 |
| observability producer | 5 / 5 |
| `check:reachability` | 66 / 66 files from 9 producer artifacts |

The baseline reachability token was
`947f3292-cb1e-4ef0-8872-e401fde10a4c`.

`main` advanced during the packet and again during round-one review. Current
`main` is merged into the packet branch before its final frozen run so the
reviewed candidate remains an ancestor; `main` itself is never reset or moved
by the writer.

## One definition source, one application package

Each of the Party, Catalog and Location factories now accepts an optional
namespace. The default remains its pre-packet module namespace. Each file owns
one `ids(namespace)` helper, calls it once at module scope to preserve the
existing exported ID objects, and calls it inside the same definition factory
for the requested namespace. No definition body was copied and every existing
standalone caller keeps its prior behavior.

`composedApplicationDefinition()` invokes those three sources under
`northstar.app`, assigns the modules distinct order keys, replaces their owner
with the single application package ID, and deduplicates the identical shared
surface capability requirement. The checked-in authored JSON is compared
directly with this builder in the PostgreSQL test, so an independently edited
artifact cannot silently become a second lineage.

The generated application artifact records:

| Property | Observation |
|---|---:|
| application release root | `6bcd3c10ec184fc26a33452d1ac3105dacff3152555e614c78a4a82d8a5bf5e2` |
| bootstrap release root | `7619e59cba92a3cc786eae11c0d9f83a6bb344e3d613a3039b53a1d05cfa1a55` |
| modules | 3 |
| entities | 4 |
| queries / operations | 16 / 16 |
| surfaces | 12 |
| application artifacts | 21 |
| projection manifests | 10, one for every current required module family |

`apps/web/scripts/compile-app-release.ts --check` reconstructs both normalized
definitions and both compiler results and rejects a stale generated artifact.
The root `check:app-release` command invokes that verifier from both the
aggregate `test` chain and its own CI step beside `check:demo-release`. The demo
release root and canonical shell artifacts do not move.

There is no dedicated in-tree generator for `app.authored.json`. It is
regenerated from the application builder with this explicit serialization,
then the compiled envelope is regenerated separately:

```bash
node --import tsx --input-type=module -e "import {writeFile} from 'node:fs/promises'; import {format} from 'prettier'; import app from './packages/domain/src/app/builder.ts'; await writeFile('apps/web/release/app.authored.json', await format(JSON.stringify(app.composedApplicationDefinition()), {parser:'json'}));"
corepack pnpm --filter @north-star/web build:app-release
```

The PostgreSQL test independently requires the authored bytes to deep-equal
the same builder output. A dedicated authored-artifact generator remains a
mechanical follow-on rather than being hidden inside the compiled-artifact
reader in this review fix.

## Real persistence, preparation, approval and activation

The provider-owned factory, not web rendering code, owns PostgreSQL setup and
gateway construction. Startup:

1. loads and verifies the ordered migration stream;
2. creates or resolves the tenant, environment and local identities;
3. installs approver and executor authority through the existing stored
   authority functions;
4. persists the immutable normalized definitions and compiler bundles through
   `PostgresImmutableReleaseRepository`;
5. prepares and approves the empty bootstrap, then activates it through
   `PostgresReleaseActivationService`;
6. prepares and executes the compiled module storage plan, creates its approval,
   then activates the application through that same service; and
7. requires `active_release_pointer_exact_swap` to report `tgenabled = 'O'`
   before each activation and after the final swap.

No code disables that trigger and no code updates the active pointer directly.
The product serving path reads the checked-in compiler result; it does not
compile or synthesize a catalog at request time.

The provider uses separate `north_star_runtime`,
`north_star_module_materializer`, and `north_star_module_runtime` pools. The
web package exports only its existing server entry, while `apps/api` imports
the provider's explicit `./composed-application-runtime` subpath. Nothing under
`apps/web/src` changed, so the database-free rendering boundary remains at full
strength.

## Discovered findings

### Embedded connection users can defeat a separate pool `user` option, but the role fence fails closed

The first real provider run supplied an administrative URL plus a separate
node-postgres `user` property. The embedded URL username won, and the first
trusted transaction rejected startup with:

```text
UnsafeDatabaseRoleError: trusted request transactions require the unprivileged north_star_runtime login role
```

No privileged request ran. The composition factory now derives a role-specific
connection URL for every least-privilege pool, while the exact-role assertion
remains the first trusted transaction fence. This adjudicated lesson is also
recorded in `learnings.md`.

### Persistent startup must distinguish verified migrations from newly applied migrations

The first restart against the same PostgreSQL volume failed with:

```text
Error: not every migration was applied and verified
```

All 12 migrations had verified, but zero were newly applied. The shared
migration runner was already correct: it reports `applied` and `verified`
separately and permits zero applied. The fresh-database assumption lived only
in the new startup caller, so the fix remains inside this packet's provider
composition factory. Startup now requires the complete ordered stream to
verify and accepts any applied subset. `migrate.ts` and `migrations.ts` are
unchanged.

This is the first concrete persistent-product failure predicted by the
2026-07-27 program review: harnesses had only exercised fresh databases. The
composition axis exposed it immediately. The reusable rule is recorded in
`learnings.md`.

### A definition-shaped filename is part of the current conformance discovery contract

The first composed builder was named `packages/domain/src/app/definition.ts`.
The existing product conformance ratchet discovered it as a fifth standalone
domain module and correctly went red rather than silently excluding it. The
file is now named `builder.ts`; the ratchet and its baselines were not weakened
or updated, because the application builder is not another independently
conforming module.

### Lease deviation during the original writer round

The bridge granted `apps/web/package.json` for an exports map **only**, while
the original writer also added the genuinely required `build:app-release`
script without requesting the one-line lease extension. The review caught the
deviation and the orchestrator granted it retroactively. The script remains,
but the process failure is explicit: a harmless-looking necessary edit is not
permission to bend an exact lease, and the correct action was a bridge request.

## Executed negative controls

These are deliberately executed failures or isolation observations. They do
not mean the final suite remains red.

| Vacuity vector | Executed control | Observed result |
|---|---|---|
| the browser is still serving a three-module fixture by accident | temporarily remove Location from the composed builder, regenerate the authored and compiled product artifacts, then run the real Playwright journey | red at `getByRole('link', { name: 'Location list', exact: true })`: `element(s) not found`; source and generated artifacts were then restored |
| activation can ignore whether its bound approval is still live | create a real preparation, approval and prebound attempt joined to the candidate; revoke that approver's live eligibility; call `activate()` with the persisted attempt | decisive outcome `APPROVER_REVOCATION`, status `NO_SWAP_TERMINAL`, and no release ID; this is not `CANONICAL_RECORD_NOT_FOUND`; the pointer remains unchanged and `pg_trigger.tgenabled` is `O` before and after |
| the compiled product can drift because its verifier is not executed | change the first nibble of the application attestation's release root in `app.compiled.json`, then run the new root command | `corepack pnpm check:app-release` exits 1 with `Error: compiled application release is stale; run pnpm --filter @north-star/web build:app-release`; the artifact was restored and the same gate then passed |
| the created row comes from an in-process fixture or cache | create through the Semantic Operation gateway, read through a separate request/transaction, close every application pool, reconstruct the provider/runtime against the same PostgreSQL database, and read again | the exact generated record ID is returned both before and after reconstruction |
| the Playwright journey would also pass against the old demo shell | start the unchanged demo shell and point the composed journey at it through `COMPOSED_APPLICATION_BASE_URL` | red at `getByRole('link', { name: 'Party list', exact: true })`: `element(s) not found` |
| one tenant can read another tenant's module row | after tenant A creates and rereads the Party, create a complete independently activated runtime for tenant B against the same database and issue the same List query | tenant B observes `listCoverage.totalCount = 0` and `records = []`, while tenant A observes the persisted record ID |

The permanent PostgreSQL control also directly reads `pg_trigger`; a boolean
returned by the composition factory alone is not credited as trigger evidence.
An attempt row with no approval row cannot exist under the current contract:
`release_activation_attempts` has an immediate foreign key to
`release_approvals`, and activation loads them with an inner join. The executed
red therefore removes the live approval authority from a genuine persisted
attempt and requires the kernel's approval-specific `APPROVER_REVOCATION`, not
a not-found failure. The green side restores that authority and exercises the
same activation service against the same candidate release.

## Positive product observations

| Claim | Direct observation |
|---|---|
| real compiled product | the issued request view contains 12 surfaces and the exact Party, Item and Location List surface IDs |
| real operation ingress | the browser and PostgreSQL test create Party through `SemanticOperationGateway`; no module repository or direct module insert is used |
| separate read path | a later `SemanticQueryGateway` request returns the committed record ID |
| durable restart | provider pools and the HTTP composition root are closed and rebuilt, after which the row is still returned |
| real navigation | Playwright follows the compiled Party, Item and Location navigation links |
| honest unsupported state | the product renders `UNSUPPORTED_COMPONENT` for `standard_surface_content`, rather than hiding or substituting it |
| diagnostic shell preserved | `check:demo-release` passes and both `apps/web/release/shell.*` files have zero diff |
| approval-positive side | after approver eligibility is restored, a fresh preparation and approval for the same candidate makes the same `activate()` method return `SWAPPED` / `SWAPPED_VERIFIED`; the candidate becomes the active pointer and the exact-swap trigger remains `O` |

## Gate evidence

The pre-freeze aggregate test run had one first-attempt red. PostgreSQL reached
85/86; the test
`metamorphic random namespace executes the compiled declared-semantics contract without module code`
failed while opening its disposable database with:

```text
connect ECONNREFUSED 127.0.0.1:55282
```

The disposable container log already reported PostgreSQL ready. The working
tree was unchanged. One honest aggregate retry passed PostgreSQL 86/86,
browser 15/15, and reachability 68/68 from 9 producer artifacts. The first
attempt remains recorded rather than disappearing into the green retry.

The first focused review-fix architecture run was also honestly red at 72/73.
Its exact aggregate-command inventory had not yet admitted the newly required
`check:app-release` command. Bridge ruling 5 granted the single explicit
recognition clause; no allowlist or exemption changed, and the focused rerun
passed 73/73.

The prior reviewed candidate's complete matrix was green after its integration
with then-current `main`. After the review-fix commit and the merge from current
`main`, the complete matrix is run again at the exact new frozen SHA. The
observed final suite inventory after adding the two permanent files is:

| Gate | Candidate observation |
|---|---:|
| `format`, `build`, `lint`, `typecheck`, `check:demo-release`, `check:app-release` | green |
| `check:boundaries` | 122 files |
| `check:schema` | 12 applied / 12 verified |
| `test:unit` | 36 / 36 |
| `test:compiler` | 52 / 52 |
| `test:integration` | 59 / 59 |
| `test:agent` | 3 / 3 |
| `test:architecture` | 73 / 73 |
| `test:contracts` | 6 / 6 |
| `test:postgres` | 86 / 86 |
| `test:locale` | 1 / 1 |
| `test:browser` | 15 / 15 |
| observability producer | 5 / 5 |
| `check:reachability` | 68 / 68 files from 9 producer artifacts |

Both new test files are reached by their unfiltered CI-invoked suites and by
the successful reachability artifact. The CI-invoked application compiler
freshness check also passes:

```bash
corepack pnpm check:app-release
```

## Test it yourself

Prerequisite: Docker must be running. From a clean checkout, one command starts
both a persistent local PostgreSQL container and the composed product:

```bash
corepack pnpm --filter @north-star/api dev
```

Wait for `COMPOSED_APPLICATION_READY`, then open
<http://127.0.0.1:4174>. The compiled navigation shows Party, Party role, Item
and Location surfaces. To exercise the complete path in under ten minutes:

1. Click **Party form** in the navigation.
2. Enter a new Party Number, Party Name and Party Contact Summary, then click
   **Create record**. The page reports `Create complete`.
3. Click **Party list** and reload the browser. The new row remains visible.
4. Press `Ctrl+C` in the terminal, rerun the same command, open **Party list**,
   and observe the row still present. The app server stopped; the named Docker
   volume retained PostgreSQL data.
5. Click **Item list** and **Location list** to observe that all three business
   modules are served by the same active release and shell.

Two limitations are intentionally visible. Each composed page still shows an
`UNSUPPORTED_COMPONENT` panel because the declared
`standard_surface_content` capability is not registered; G2-P5d owns that
dispatch/anatomy work. Authorization is an honestly named local allow-all
policy; queue row 7 owns the real policy/identity kernel. Do not interpret this
entrypoint as a production security configuration.

## Known limits and what the gates cannot prove

- Authorization remains allow-all inside the tenant. Forced PostgreSQL RLS
  proves tenant/environment isolation, not principal-level authorization.
- Release admission still accepts an asserted verification-evidence UUID under
  the current contract. Product-authored JSON contains no random evidence ID,
  and this packet did not weaken admission, but the provider must mint the UUID
  the existing repository requires. Queue row 1b owns durable,
  content-bound verification integrity and a canonical preparation writer.
- For the same reason, this provider factory writes the canonical activation
  preparation records required by the existing approval service. It uses the
  real approval and activation services, but there is not yet a higher-level
  production preparation service.
- Startup can bootstrap an empty pointer and can converge when its exact
  compiled release is already active, but it cannot advance a persistent
  deployment from an older application release to newly compiled bytes. In
  that state startup fails closed because the active release is neither the
  generated bootstrap nor the new candidate. Iterating the local demo across
  a changed compiled revision therefore requires dropping its named PostgreSQL
  volume and losing that local demo data. The routed release-advancement packet
  must carry an exact previous-to-candidate compiled transition instead of
  teaching this bootstrapper to guess.
- Surface anatomy remains the existing one-slot-per-surface definition and its
  declared component is unavailable. The product is navigable and its current
  generic form/List data path is usable, but row G2-P5d owns unifying slot
  dispatch and completing the anatomy.
- Platform/saved filters are absent pending row 1c's ADR-0011 classification.
- The local Docker fallback uses PostgreSQL trust authentication bound only to
  `127.0.0.1` for the developer demo. Supplying `DATABASE_URL` bypasses that
  local convenience; no production credential or deployment design is claimed.
- No agent tool host, outbox consumer, API authentication, worker, native app,
  or cross-package tenant composition is added here.
- The Playwright journey proves one browser process against one local server;
  it does not prove multi-node deployment behavior or production availability.

## Program-review trigger evaluation

No new whole-program review is due before this candidate is integrated. The
2026-07-27 two-arm program review directly selected this composition packet,
and rerunning it against an unintegrated branch would violate the program-review
anti-trigger. Evaluate the triggers again after integration and at the G2 stage
gate, when the application plus the anatomy work can be judged as one product.

## Review evidence

Round one ran a fresh naive Codex xhigh review and a Fable max confirm against
`582d2a8f2b3a8f2d59b518d9839d2127502b63a2`; both returned REVISE. The
orchestrator adjudicated two in-scope findings: the activation negative stopped
at a nonexistent attempt, and the application freshness verifier had no CI or
aggregate caller. This revision replaces the first with a real persisted
attempt plus approval-revocation red and same-candidate successful activation,
and wires `check:app-release` into both execution paths with its own stale-file
red. The package-manifest lease deviation is recorded above; release
advancement, the Party race flake, and deep runtime imports are routed rather
than expanded here.

Per the review ruling, Codex need not re-review these two bounded fixes. Fable
must reconfirm the new frozen SHA. No acceptance is claimed by this writer
packet document.
