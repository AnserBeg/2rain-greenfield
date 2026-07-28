# Current plan — active execution state

**Read this after AGENTS.md and before proposing or running any packet.** It is the
narrative companion to `ledger.md`: the ledger records what each packet *was*, this
records what we are doing *next* and *why*. Update it whenever the queue changes;
delete rows once they are accepted and recorded in the ledger.

Last updated: 2026-07-27. Most recent change: the **competitive architecture review**
(section below the queue) routed five findings — D1 durable-execution substrate, D2 the
compiler's discarded reference graph, D3 policy-as-predicate, D4 permission binding as a
compile obligation, D5 never mounting two renderings — onto existing rows 1, 3, 4, 5 and 7
at their latest responsible moment. **Only D2 has a closing window**: it must be scoped
before row 4's v3 bump is cut, or it costs a second bump. Prior change: the
**domain-model one-way doors** ruling (ADR-0015 – ADR-0018) and section G of the
prior-art audit — see below, ahead of the queue, because it constrains G3 rather than the
current slot.

## Operating model

- The user drives Codex `gpt-5.6-sol` sessions and pastes their reports back.
- The assistant is **orchestrator + adjudicator**: it hands the user self-contained
  packet prompts, adjudicates review findings and lease-bridge requests by reading the
  code, and runs multi-model **debates** directly (it does not write product code).
- One packet at a time, user-selected, per `mission-cadence`. New Codex session per
  packet — every prompt reconstructs state from disk.
- Reviews follow `review-tiers` (fresh naive spawns, mandatory charter, two-REVISE cap).
- Acceptance requires the **full CI matrix green at the integrated SHA** (not a
  packet-chosen subset) — the rule PR-1 put in force.

## Where we are

| Stage | State |
|---|---|
| G0 | COMPLETE (no stage-gate evidence doc — tracked debt) |
| G1 | COMPLETE — release kernel, compiler, pinning, gateways, surface shell |
| G2 | IN PROGRESS |

Accepted in G2: `G2-P0` (stage cut) · `G2-P1` (trust substrate) · `G2-P2a/b/c`
(**Freeze F ratified** — compiled module storage, materializer, generic Q0/O0 runtime) ·
`G2-P3a` (generic surface↔gateway data binding) · `G2-P3c` (resolver authority,
language v2) · `G2-P3b` **Party — first real walking slice, Freeze G established**.

Then a whole-app **program review** (2026-07-24, dual max-effort) produced three
correctives, all accepted: `PR-1` (gate integrity) · `PR-2` (semantic preservation —
executable verification, archive-restrict, enum contracts, typed errors) · `PR-3`
(operation mediation — confirmation grants, classification, invocation evidence,
idempotency).

`PR-6` (**relation index coverage** — additive `relation` index kind, forced-RLS `EXPLAIN` probe requiring the index by name, and `runtime-slos.md`) is accepted, as is `PR-6b` (**folded-column index mechanics** — stored C-collated generated folds make forced-RLS resolve and unique lookup use their declared indexes; the useless raw-column `search` btree is retired; the fold function refuses replacement rather than healing before measurement).

Two gate-completeness correctives followed, both accepted: `PR-4` (quoted globs, the
two orphaned compiled-shell guards wired, doctrine/debt coverage, external reviews
archived) · `PR-4b` (**executed-file reachability** — every test file must be observed
running in the current run, evidence bound to one run token and the reporter's observed
argv; static CI-selection inference is gone) · `PR-5` (**idempotency scope** — durable
receipt identity narrowed across primary key, lookup, advisory lock, and RLS; a retry
after an activation, a recompile, or from another principal no longer re-executes, and
migration 0010 refuses rather than rewriting immutable receipts).

**`G2-P6` Catalog is accepted — and it was authored with ZERO press changes.** One
377-line declarative definition plus test scaffolding produced a complete module: no
file under `packages/compiler`, `canonical-model`, `postgres-provider`, `runtime`,
`platform-runtime`, `dev-tooling`, `apps/web/src`, or `db/migrations` was touched.
This is the first module authored against an already-built platform, and it validates
the north-star claim that a module is data, not code.

**`G2-P7` Location is accepted — also ZERO press changes.** Two consecutive modules
authored against an already-built platform with no press edit. The fan-out's second data
point is honestly the weaker one: the typed-unsupported hierarchy seam and its only
natural relation were descoped after the factory test found a real press limit, so
Location proves per-tenant code uniqueness and exact-code resolution but not relation
access.

**`G2-EK1` Expression kernel is accepted** — ADR-0012 ratifies the ceiling (total, terminating, no loops, no operation invocation, depth ≤ 24), position profiles across five execution targets, SQL admissibility as cost classes, and one owned evaluator per target. The triplicated trivial-predicate fence is converged onto one strict version-dispatched canonical-model entry point. Two rulings land downstream: a **formula/rule projection family IS required**, so queue row 3 now carries two families on one v3 bump; and search input is **literal text**, not a wildcard pattern, which unblocks and specifies row 2.

**`PR-6c` Materializer DDL is accepted** — `deferredOnlineFamily` elements, previously classified then processed in no path, now execute as transactional locking DDL; index verification requires both `indisready` and `indisvalid`; DDL and step receipts are atomic; migration `0011` adds a superuser-owned event-trigger witness with snapshot capture so dropping it is detected. Full matrix green at integrated SHA `4042842`.

**Sequencing question resolved 2026-07-26:** Q1 does **not** depend on the v3 packet. ADR-0012 states that existing query and operation catalogs continue to own their embedded v0 predicates and are not copied into the new formula/rule family as a second authority — that family is for first-class `FormulaRuleDefinition` objects, which are G6-era. **So v3 is not G3-blocking, and the G3 critical path is Q1 alone**, which can be pulled forward whenever accelerating toward inventory is worth more than completing G2 in order.

**`PR-6d` Prefix search is accepted** — substring search escapes `%`, `_` and `!` so input is literal text per ADR-0012, and prefix search lowers to C-collated range predicates for forced-RLS index access. One REVISE round: emission was widened to search-mapped non-unique fields without execution evidence for that class, closed by a probe with a dropped-index red of 9,999 rows removed by filter.

**`G2-P4` Surface-grammar conformance is accepted** — §8.6's suite now gates every stage from G2 onward, with the bespoke-screen antibody proven by an executed red rather than a green assertion. **G2 has four packets left: P5a, P5b, P8, P9.**

**`G2-P5a` Shared List behaviour is accepted** — bounded paging with coverage, stable sort, authorized pre-page search over relation labels and formatted values, archive visibility, bound cursors, and one shared result consumed identically by UI, Semantic Query and agent. **Freeze I.** Three risks recorded and routed on its ledger row: numeric sort is silently lexicographic (routed to P5b), the count/page coverage race under read-committed, and search that cannot use folded indexes for enum or relation-label arms.

**`G2-P5b` Saved filters is accepted** — canonical predicate envelopes, release-pinned validation failing closed, Semantic Operation writes, and the **first first-party platform package**, which compiled through the unchanged press: the third zero-press-change result and the first for a *platform* module.

## UX conformance — found 2026-07-27, and it re-sequenced the queue

An independent review compiled the three real modules and ran G2-P4's own conformance checker against them. **Party fails 64, Catalog 33, Location 33 — 130 violations — while the architecture suite reports 68/68**, because the suite's only input is a synthetic fixture. `checkSurfaceGrammarConformance` has two call sites: its definition and that fixture test. **No real module has ever reached it.**

The trigger was a human operating the app and noticing the list and record pages were disconnected. That symptom is one of fifteen missing slots on Party alone. The systemic cause is that **every layer is gated against inputs shaped to its own scope and nothing gates the composition** — and the module template replicates it, so Catalog and Location inherited the defect verbatim from the "zero press changes" result we twice celebrated.

Rows 1-3 are the response, in that order: ratchet so nothing new can be added, burn down the anatomy, then write the skill that codifies the template — because writing the skill first would make the defect doctrine.

**SCOPE RULING 2026-07-27 — G2 must be demonstrable.** The user has ruled that G2 ships something a person can open and use, not a set of per-module harnesses. That makes the **composed application G2 scope**, not deferred: one shell carrying the real modules, records reachable, the anatomy present enough that create/save/navigate work, and no error page or `UNSUPPORTED_COMPONENT` panel as the first thing a visitor sees. G2-P9 cannot certify the stage until that is true. This is a constraint on the remaining packets, not an open question.

**Superseded — the earlier framing of this decision:** there is no composed application. `pnpm dev` serves a shell with four `home` surfaces and no domain module, so every "test it yourself" checkpoint so far has exercised a per-module harness rather than the product. A stage gate run today certifies the harnesses. Either G2 ships a composed shell, or G2-P9 states plainly what it does and does not certify — a scope call, not a packet call.

**Not yet started:** G2-P8 import, and everything after.

## Active queue

Ordered. Each row names its source and why it holds its slot.

**Re-sequenced 2026-07-26 — G2 completion first.** The queue had grown to twelve rows of which only three were G2 stage packets; the rest were correctives, discovered work and pre-launch infrastructure that accumulated *around* the stage. Advancing it packet-by-packet preserved an order nobody had re-examined. **G2 has four packets left — P4, P5, P8, P9 — and they now hold the top slots.** Nothing below them blocks G2 closure: the v3 packet's capability disclosure is N1-scheduled per `doctrine-coverage.md`, prefix search is an optimisation plus a bug fix, and PR-7 and the policy kernel are both marked *before G3* rather than before the gate. This is the A1 discipline the prior-art audit asks for in its own words — treat repeated G3 slippage as the A1 signal, not as a scheduling problem.

**RE-SEQUENCED 2026-07-27 by the G2-composition program review.** Both arms
converged on one headline — *the organs are real, the organism is not* — and
both ruled composition, not further fan-out, the controlling acceptance axis.
The [converged record](program-reviews/2026-07-27-g2-composition.md) carries
fifteen ranked findings. Three change this queue's order:

- **AD-1 (adjudicator correction).** Codex ruled the composed application
  unrepresentable and wanted a full application-graph contract before anything
  else. I executed the probe instead: a three-module application package
  (Party + Catalog + Location, one namespace, distinct `orderKey`) **normalizes
  and compiles through the unchanged press** — releaseRoot `1eed139d…`, nine
  projection families, one instance each. The composed app needs **authoring,
  not a new contract**. Only *cross-package* composition is unsupported, and
  that is a tenant-authoring problem for later. This is what makes a
  demonstrable G2 reachable now.
- **A2 (Fable).** Slot dispatch and data rendering are two disconnected
  mechanisms. Every module surface renders `UNSUPPORTED_COMPONENT` **today**,
  and the working UI is a hardwired panel that ignores slots entirely. Row 1 is
  re-scoped accordingly — it is not "declare slots", it is "unify dispatch".
- **A4 (Fable).** Findings have been routed to destinations that do not exist.
  The composition gap itself was recorded four times and owned by no row. New
  standing lesson: *a recorded finding with no owning row is a disposition with
  no executing gate.*

| # | Packet | Tier | Why here |
|---|---|---|---|
| 0 | **G2-P5e — the composed application** | Critical | **NEW, and it holds the top slot.** Author one application package carrying Party, Catalog, Location and Platform as modules under a single namespace — proven legal and compilable today by AD-1's executed probe, with zero press change. Then build the one real composition root: persisted release loading (not a checked-in fixture), gateways wired to PostgreSQL, an honest demo authenticator, and the real approval→activation path rather than the superuser trigger-bypass every module harness uses. Its product journey must not import `test/fixtures`. **Existing pipeline is reused:** `apps/web/scripts/compile-demo-release.ts` already reads `shell.authored.json`, normalizes, compiles and writes `shell.compiled.json`, which `demo-server.ts` serves — the authored input becomes the composed package. From this packet onward **one composed-product browser journey joins the permanent matrix**: open the app, create, save, navigate, read back. That standing gate is the antibody to the whole finding-1/finding-11 class. |
| 1 | **G2-P5d — record and list anatomy** | Behavioral | **RE-SCOPED 2026-07-27: unify slot dispatch with the data path, then burn the anatomy down.** The count is **163, not 130** — the platform package added 33 of its own after the defect was identified. Fable's A2 established the deeper mechanism: `surface-runtime.ts:245-253` renders `renderedSlots` and a hardwired `renderedData` panel as *two separate mechanisms side by side*; every module slot carries `contentReferenceId` `northstar.<module>:capability.standard_surface_content`, registered nowhere, so all four modules render an `UNSUPPORTED_COMPONENT` diagnostic **today**. Growing the registry is necessary but not sufficient — the two paths must become one. Carry in the expressiveness gap: a slot capability must declare `supportStatus: 'supported'` or compilation fails (`compiler.ts:716-729`), so even the deliberate `c_unsupported` negative control must declare itself supported to compile — the language cannot say *"declared, intentionally unregistered."* Row 4's v3 disclosure family is the honest fix. (Fable read this as a shipped false claim; on inspection `future_insights` is a negative control, not a defect — the gap is real, the falsehood is not.) **The 130 violations, burned down.** `SURFACE_SLOTS.record` requires seven slots — breadcrumb, titleStatus, commandBar, keyFacts, sections, childTables, activity — and `list` requires four. Party declares **one each**: `['list','list','dataGrid']`, `['detail','record','keyFacts']`, `['form','record','sections']`. Catalog and Location copy the same template. Consequences a user actually hits: no breadcrumb, so no way back; **no commandBar, so no Save, New, Edit or destructive actions** — which strands the archive/restore and human-confirmation flows as *dead UI*, real tested code nobody can reach; no activity rail, so §8.5's promise that "what happened" is answerable on every record is answerable nowhere. Only **three components are registered** (`error_probe`, `release_summary`, `setup_checklist`), so declared slots would render `UNSUPPORTED_COMPONENT` diagnostics — the registry must grow with the anatomy. **Derived navigation falls out of this** rather than needing its own packet: row→record and New→form compute from the `dataSource` entity two surfaces share, and the affordances live in commandBar and the grid. Cross-entity navigation stays deferred. **One free constraint to write into the unified dispatch (competitive review D5):** §8.5's responsive contract derives compact and full renderings from the same `SurfaceDefinition`, and the obvious implementation — render both, hide one with CSS — is a documented production failure in prior art, where a desktop and mobile table were both mounted and every data subscription therefore ran twice, contributing to a component re-rendering twenty times per event at sustained 100% CPU. **Compact and full are alternative renderings, never simultaneously mounted.** One sentence in the surface-runtime contract while the dispatch is being unified; a profiling incident if discovered later. |
| 1a | **Disposition-integrity rule + one-time sweep** | Mechanical | **Cheapest correction on the whole list; take it immediately.** Binding rule: no review finding, packet limit, or "routed" risk may terminate in prose — every disposition names an existing ledger/queue row or creates one. Then sweep the known orphans: saved-filter **F1** (routed to a "write-path-hardening follow-on" that exists nowhere — `grep` returns only the ledger row that names it), the trust read-model/activity rail (the 2026-07-24 review's NC3, still slotless), query-side denial evidence, the ADR-0011 platform contradiction, and the plan §4.4 repo-shape mapping. This is the process defect that manufactured the program review's own trigger. |
| 1b | **Release-admission verification integrity** | Critical | **Violates ADR-0020 as ratified.** `assertReleaseIdentity` validates `verificationEvidenceId` with `assertUuid` and nothing else (`release-repository.ts`); executed results live in a process-local `WeakSet` (`verification.ts:68`); no production service writes the canonical preparation that `createApproval` loads; module harnesses supply `randomUUID()`. ADR-0020's enforcement clause requires that *no code path admits a candidate with an unexecuted verification set*. An immutable release can therefore make a false statement about its own verification, and human approval can bind evidence digests with no connection to any execution. Persist durable content-bound verification results, require exact plan/result conformance at admission, provide the canonical preparation writer, and prove that missing, stale, partial, fabricated and differently-rooted result sets each fail closed. **Ban random evidence IDs and direct pointer mutation from any product-conformance journey** — which is also what row 0's real activation path needs. |
| 1c | **Platform classification — resolve the ADR-0011 contradiction** | Critical | **The first spore of the dual-lineage disease, and both arms flagged it.** `platform/definition.ts:156` declares `dedicatedTable`, but the compiled storage projection is cargo: migration 0012 hand-authors the real table with per-principal RLS no compiled module can express, and `saved-filter-executor.ts` is 1,000+ lines of bespoke SQL inside a press package. ADR-0011 says verbatim: *"No module-specific Q0/O0 handler, SQL, route, tool, kernel branch, or registry is emitted or admitted."* A ratified ADR is being contradicted by a ledger row — a lower-authority artifact — with no amendment and no corrective. **Binary choice, do not retain both:** make saved filters genuinely generic through the compiled mapping and interpreter, or amend ADR-0011 with a declared Tier-B platform tier and strip the decorative `dedicatedTable` plus the two queries that return `unsupported`. Either way this hollows or restores the "third zero-press-change data point" — the platform module compiled through the press but does not run through it. |
| 1d | **Correctness in shipped modules — F7 + F1** | Critical | **Promoted from row 11 by the program review; correctness in accepted modules outranks baseline and curve rows.** (a) **F7 archive-aware uniqueness:** `storage.ts:578` emits `UNIQUE (tenant_id, environment_id, column)` with no archive predicate while Catalog and Location both declare `tenantEnvironmentCaseInsensitiveUnique` and both ship archive/restore — so archiving a location coded `WH-A` reserves that code permanently, surfacing as an opaque unique violation on create. PostgreSQL partial unique indexes make the fix cheap; it touches Freeze F's uniqueness contract and the drift verifier (which already reads `indpred`). (b) **Saved-filter F1:** the update path checks revision but never lifecycle, so a revoked filter can be renamed, re-targeted and have its criteria replaced while no read surface shows it — and since List now excludes archived rows and `get` throws, no read surface yields an archived row's revision, making `restore` practically unreachable once the archive receipt is lost. Row 11's own text already conceded it "arguably outranks several rows above it." |
| 1e | **Consolidate the press guards** | Mechanical | **The enforcement instrument of the north-star law is itself a copied-per-module artifact, and it has already diverged.** Party's guard scans 3 press directories, Catalog's and Location's scan 7, and `northstar.platform` is banned nowhere at all; `db/`, `scripts/` and `test/` are outside every scan; only literal IDs are policed. Replace the four with one data-driven guard that auto-discovers modules — the pattern the conformance ratchet already proves at `surface-grammar-conformance.test.ts:63-76`, where omitting a module turns the gate red instead of silently excluding it. Cheap, and it removes a multiplier of exactly the kind this review was called to examine. |
| 1f | **Record and repo hygiene** | Mechanical | **Program-review finding 12, and the destination for orphaned small defects.** Created 2026-07-27 — its absence was itself a disposition leak, caught while adjudicating a G2-P5e bridge. Contents: plan §4.4's recommended repo shape versus the actual layout (contracts→canonical-model, gateways living in `packages/runtime` which §4.4 never names, `test-contracts` an empty husk misnaming the real contracts suite); ADR-0007's inventory exemption hardcoding `packages/domain-inventory`, a path that will never match the real layout (fail-closed today, a false red awaiting G3); deep relative imports bypassing export maps (`postgres-provider` → `platform-runtime/src/trust`); current-plan row 9's stale `compiler-slos.md` claim; the surface vocabulary duplicated between `constants.ts` and `apps/web/src/surface-contract.ts` and pinned only by a regex-over-source proxy; the G2-P5c packet-versus-ledger status disagreement. **Added 2026-07-27 by bridge ruling 2:** `packages/postgres-provider/package.json` exports `"." → ./src/migrations.ts` in a package with no barrel — the provider's root export is its migration runner and nothing consumes it; harmless but wrong-shaped, and it should be repointed or removed deliberately rather than discovered again. **Added 2026-07-27 from the G2-P5e review:** (a) `test/postgres/party-runtime.test.ts:357` — the archive/create race accepts either winner around :284-327 but :357 assumes one, so the suite is flaky; it cost G2-P5e a retry and Fable correctly refused to patch it out of lease. One-liner: scope the role count to the created party, or pin the race winner before counting. (b) Two new deep relative imports at `composed-application-runtime.ts:41-45` reach `../../runtime/src/semantic-{operation,query}-gateway.js` because `@north-star/runtime` exports only three subpaths — add the two export-map entries and convert the imports. (c) **Adding one gate to this repository requires editing three separate inventories** — `repository-hygiene.test.ts`, `test-reachability.test.ts`, and `.github/workflows/ci.yml` — which taxes every future gate and is the same copied-inventory shape the program review flagged in the press guards. Consider one discovered-scripts source of truth. |
| 1g | **Release advancement for a persistent deployment** | Critical | **Created 2026-07-27 by the G2-P5e review (Codex High finding 3).** The composition root activates only when there is no pointer yet — `composed-application-runtime.ts:168` runs its approval/activation branch under `if (pointer.releaseId === null)`, and any existing pointer that does not name the new application release throws *"the active pointer names a release outside this composed application."* So the composed root is a **one-time bootstrapper, not an ongoing release path**: a persistent deployment cannot advance to the next compiled revision, and iterating the demo requires dropping the database volume. This matters beyond convenience — plan §11.5 and the G2-P9 gate both require a complete compile → verify → activate → **rollback** journey, and rollback is unreachable if forward advancement is. Scope: carry an exact previous→candidate compiled transition, select it only when its source matches the active pointer, and prove it with a test that writes data under release A, closes all pools, starts release B, activates it, and rereads the same row unchanged. **Sequencing:** not demo-blocking, but it blocks G2-P9. Take it after G2-P5d unless a demo needs upgrade-in-place sooner. |
| 2 | `adding-a-module` skill | Mechanical | **Still after the anatomy packet — both arms independently endorsed that call.** Written against the proven Freeze G template; the fan-out consumes it. **Moved after the anatomy packet 2026-07-27:** the skill codifies the module template, and the current template is what replicated the one-slot defect into Catalog and Location verbatim. Writing it first would make the defect doctrine for every future module. |
| 3 | G2-P8 import → G2-P9 stage gate | — | Completes G2. **Carries the durable-execution substrate decision (competitive review D1), and it is the latest responsible moment.** Plan §4.2 names one background worker for "outbox, durable jobs, verification, exports, and later workflow activities"; `apps/worker/` contains a `package.json` and nothing else, and the trust substrate already writes `platform.trust_outbox` rows that **no consumer reads** — so one half-built consumer exists today. Import is the first packet that genuinely needs durable execution (§11.5 item 6 requires dry-run, row diagnostics, idempotency and a result artifact), and four more consumers follow: bulk (§9.2.4), outbox delivery, agent execution, N2 workflows. **Binding constraint on this packet: import does not invent a job mechanism.** It either builds the shared substrate or explicitly declares its mechanism to be the shared one, with the retry/checkpoint/cancellation contract written down either way. Unifying two mechanisms is a packet; unifying five is a project. One earned detail worth carrying in from prior art: retry policy is **per activity class**, and a tool/handler activity should get exactly one attempt so its error survives as feedback rather than being retried away, while platform activities retry. |
| 4 | **v3 canonical language evolution — capability disclosure family + kernel structure** | Critical | **Created 2026-07-26 by the G2-P7a stop.** The former row 1 (capability support-status) decided seam (b) — a distinct canonical disclosure object, so `capabilityRequirements` stays fail-closed runtime authority — then proved with evidence that this is a **language/profile version event**, and stopped without changing a file. Measured on unchanged input: `vertical-v1.authored.json` normalized bytes 5460 → 5487, definition digest `82cb27f8…` → `2b5c6375…`, and the current reader rejects the new bytes with `CANON_SCHEMA_INVALID`. Packages declaring **zero** disclosures still move: canonical fixture `00444e2e…` → `24a10122…`, bootstrap `20ad5c1b…` → `54e0c173…`, vertical v2 `c35ec43a…` → `c24a48b1…`, and vertical v1's release root `70c310f5…` → `39543c8a…`. Root cause: `normalizedShape` (`schemas.ts:733`) is wrapped by `z.strictObject` (`:756`), so a new family collection is a closed-set change, and language contract T10 fixes family/collection bounds per version. Scope: v2→v3 language and normalization-profile dispatch retaining v0/v1/v2 readers; the v3-only disclosure family with its bounded `STRUCTURAL_LIMITS_V0` entry; normalization ordering, duplicate detection and authored round-trip; semantic-model and release-manifest output; provider validation and persisted round-trip; hardcoded v2 module definitions and fixture harnesses; canonical, G1/G2, structural-release, determinism and demo-shell artifacts; and the §5.1-versus-§5.5 plan-tension disposition. **Row 1 answered: it does.** ADR-0012 rules that existing query and operation catalogs cannot represent the cross-position contract plan §5.8 requires, so this packet grows by **one formula/rule projection family** carrying binding-position profile, phase, purity, target and absent/error behaviour — riding the same bump rather than buying a second. This packet therefore carries **two** families now, and its prompt must be written against both. **One shape requirement to carry in:** boolean binding positions (guards, visibility) need a **reason channel** alongside the boolean so an explanation exists and a future escape body must supply one — validation profiles already get this free via pass/fail-plus-message. A sentence here; a canonical change later. Do not cut it until row 1 is accepted. **SCOPING DECISION DUE BEFORE THIS PACKET IS CUT (competitive review D2) — this row has the only closing window on that list.** The compiler computes the full reference graph during resolution and **discards it**; what survives is `diff.ts`'s `impactCodes`, which is projection-family granularity ("the query catalog changed"), not element granularity ("changing this field breaks these three surfaces and two operations"). Three already-committed obligations need the finer form: ADR-0020's rule that verification scope narrows **only by recorded impact analysis**; §12.13's builder, which must discover and negotiate against existing objects; and the agent-discovery projection. Because this row already measured what a new family costs — every golden artifact, every release root, packages declaring zero of the new thing still move — a dependency/impact projection is either a **third rider on this same bump or a second bump later**. Decide it when the prompt is written; do not discover it at G6. |
| 5 | **Q1 compositional query tier** | Critical | **Also owns plan §5.12 floor item F1 — absent-value semantics.** Optional is the default field presence, so the moment Q1 lowers a `notEquals` or a negation over an optional field, IR two-valued logic and PostgreSQL three-valued logic can disagree and silently drop rows from a saved view. ADR-0012 defers *cross-target* semantic pinning to G6; the filter-position ruling cannot wait that long, because Q1 is where the divergence becomes reachable. **G3-blocking**, per verdict S2: G3's correctness contract is `SUM(posted movement.quantity_delta)`, so without Q1 the inventory stage hand-rolls aggregation against ADR-0011's grain. The plan already specifies the tier (§5.1, §5.9, §9.2.2) — filters, traversal, joins, grouping, aggregates, reports, exports over semantic entities. Today the gateway rejects every tier above Q0 and every filter other than literal `true`. Placed after the fan-out so it is designed against three real modules. Also the answer to "can the agent analyse data" — see verdict R8/R9. **Depends on the accepted G2-EK1 expression kernel:** Q1 is the first tier to compile and SQL-lower non-trivial filters, so the expression ceiling, position profiles and cost classes must be ratified before it is designed. **Owns the precondition field-locality defect** surfaced by the expression-kernel debate: query filters enforce source-entity locality (`normalize.ts:1050-1064`) but operation preconditions validate scalar type only and can reference a field from any entity in the package (`:1074-1083`). Latent solely because the runtime fence rejects non-trivial preconditions — this row opens that door, so it closes the hole or explicitly re-routes it. **Also the trigger for L2-L4** (see "LLM-assisted verification" below): the first non-trivial SQL lowering makes the parity corpus, the model-assisted dispatch tripwire, and the scenarios-as-specification prototype all due here — one body of work, not three. Scope them at admission; if they do not fit, cut them as a paired follow-on rather than deferring past G3. **MUST CARRY A POLICY-PREDICATE SEAM (competitive review D3).** Q1 sits at row 5 and the policy kernel at row 7, so the tier that owns SQL lowering is designed **before** the kernel that will need to narrow it. Policy narrowing cannot be an application-layer post-filter over fetched rows: prior art rejected exactly that design and named the decisive reason — **post-filtering is incompatible with pagination.** Ask for 50, remove 20 by policy, return 30, and the cursor no longer means anything. Our own G2-P5a coverage race is the same failure one level down, since count and page are already two statements whose consistency the gateway asserts. So Q1's lowering must expose a seam where a policy-contributed predicate joins the compiled `WHERE` clause, with the seam proven by an executed test that supplies a narrowing predicate and observes it in the plan — even though row 7 supplies the only real narrowing later. Retrofitting this after the lowering ships means reopening the most expensive layer in the tier. |
| 6 | PR-7 — provider hot path | Behavioral | Release-load cache (flagged by two independent reviews), relation N+1, round-trip reduction, advisory-lock namespacing. Before G3. |
| 7 | Policy/identity kernel | Critical | **Both program-review arms confirmed this is the whole security posture's missing half, and both hard-gated it before G3.** Storage isolation is strong and verified — forced RLS with tenant/environment predicates, an unprivileged runtime role that rejects smuggled identity, no destructive grants, no SQL-injection surface. Against that: every `CurrentPolicyGateway` in the tree returns ALLOW, and permission IDs compile into reference data that nothing ever evaluates, so within a tenant every principal currently holds every declared permission. RLS is defense in depth; it is not authorization. **Fold in three sub-items the review surfaced:** `module_storage_backfill_checkpoints` carries tenant columns but has no RLS while writable by the module role; migration 0010's principal check was dropped from the receipt INSERT policy and is compensated only in app code; and all policies are PERMISSIVE with no RESTRICTIVE kernel base, which was the team's own stated target. Also owns query-side denial evidence — `semantic-query-gateway.ts` has no `recordNonAccepted`, so a denied read leaves no persisted trace. **Demonstrate a real DENY through the composed app**, not a harness. The one kernel seam with **no owner** — see decisions below. After fan-out, before G3. **Bound by the accepted G2-EK1 expression kernel:** `PolicyDefinition` carries "narrowing conditions" (plan line 643) and §12.2 line 2338 claims policy narrowing for the Formula family, so the kernel's jurisdiction ruling applies here — otherwise a second condition format is born in the trust layer, the most expensive place to unify later. Narrowing may only restrict a live ALLOW and must fail closed; it can never grant, nor override the mandatory kernel predicates (archive exclusion, tenant/environment RLS, record identity, optimistic revision, authorization). **Consumes row 5's policy-predicate seam (competitive review D3):** narrowing lowers into the compiled `WHERE` clause through that seam and is never applied as a post-fetch filter, because post-filtering breaks pagination — the reason prior art rejected the same design. **Also owns the compile-time permission obligation (competitive review D4).** Today a module declares `permissionId`s that compile into reference data nothing evaluates; that state was reachable because our instruments **detect** missing enforcement rather than **prevent** it. Prior art's stronger pattern is to generate a hole that must be filled: an endpoint that ships without an authorization check does not compile. Our equivalent is a compiler rule — a declared permission with no evaluator binding fails the candidate, in the same shape as `validateModuleConformance`. Cheapest at four modules; a migration at forty. Land it with this packet so the rule and its first satisfier arrive together. |
| 8 | Capability cycle-time baseline | Mechanical | **[Lever 4](coverage-strategy-levers.md) Half A, and the only part with a real cost of delay.** §15.7 measures module-building effort from *existing* capabilities — the wrong axis. Record, for each capability we add, the decision latency (gap identified → admitted) and implementation latency (admitted → shipped supported across all ten cells). **Startable now, before any tenant:** PR-6's `relation` index kind and row 4's two canonical families are capability additions whose cycle time is measurable today, and a baseline not started cannot be reconstructed. Small and order-independent — **take it any time; it does not displace Critical work.** |
| 9 | **Publish-path breadth envelope** | Mechanical | **PROMOTED by the PR-6d Fable confirm — take it next among the order-independent rows.** ADR-0020 §3 says the envelope curve is the only part with a real cost of delay, because a baseline not started cannot be reconstructed, and its enforcement expects `compiler-slos.md` to carry the `publishPath` family — that file carries neither. **PR-6d then grew exactly the quantity the curve exists to track:** it widened physical emission to one folded btree per search-mapped non-unique field, adding a deferred-family element and a maintained index per opted field, with no numeric record of index-count-versus-breadth anywhere. Fable's ruling: this violates no gate — ADR-0020 says "startable now" and changes no current gate — but the next emission-widening packet should land on a baseline rather than an argument. Record **searchable-field count** and **per-entity index count** as curve dimensions. Note also that runtime *write* amplification is budgeted nowhere: `runtime-slos.md` is read-path only and ADR-0020 budgets publish latency and exclusion, not INSERT cost. **[ADR-0020](../decisions/ADR-0020-publish-path-budget-and-verification-integrity.md)'s only decaying obligation.** Today's gated ≤5,000 ms budget measures one module at the maximum field count; publish cost scales with a tenant's *whole* application, so the envelope that matters is a curve across N modules. Record it as a curve artifact, not a pass/fail assertion, until G6 sets an objective. Pairs directly with row 11 — both exist so a later decision has data instead of an argument, and "incremental compile, triggered by measured need" is unactionable without one. **Startable now, order-independent; take it any time and it does not displace Critical work.** |
| 10 | **Online DDL strategy for populated tables** | Critical | **Earned by measurement, not argument.** PR-6c built the transactional locking path under an orchestrator ruling that required the blocking window be measured and a numeric promotion trigger recorded — then its own rehearsal crossed that trigger: 10k rows 1,317.647 ms, **25k rows 3,502.750 ms against a 2,000 ms trigger**, with the 100k rehearsal hitting the container's 256 MiB limit and yielding no sample at realistic scale. Must absorb both PR-6c review findings. (a) **The window is platform-wide, not table-local** — a rewrite holds the single advisory key shared with kernel migrations for its full duration, so every other tenant's materialization fails `MIGRATION_LOCK_TIMEOUT`, and sooner than configured because `maximumRetries: 5` at ~50 ms trips near 300 ms while `timeoutMilliseconds: 5_000` is unreachable. (b) **The trigger is procedural, not mechanical** — nothing in the activation path consumes rehearsal evidence, so it holds only if an operator runs it. This packet makes it a **coded admission input**, which is also what [ADR-0020](../decisions/ADR-0020-publish-path-budget-and-verification-integrity.md) needs to budget platform exclusion as a real quantity. **Pre-launch, not pre-G3** — no populated deployment exists, so it blocks first in-place upgrade rather than G3. |
| 11 | **Archive-aware uniqueness (floor item F7)** | Critical | **PROMOTED TO ROW 1d 2026-07-27** by the G2-composition program review, which agreed with this row's own closing argument. Retained here for provenance; the work is row 1d. **A live defect in accepted modules, not a future concern.** The compiler emits `UNIQUE (tenant_id, environment_id, column)` with no archive predicate (`packages/compiler/src/storage.ts:578`), while Catalog and Location both declare `tenantEnvironmentCaseInsensitiveUnique` and both ship archive/restore. Archiving a location coded `WH-A` therefore reserves that code permanently, and the same holds for any retired SKU — a business that retires and reuses codes cannot, and the failure surfaces as an opaque unique violation on create. Plan §5.12 F7. A **storage** primitive, not an expression one: a declared uniqueness scope that excludes archived rows, which PostgreSQL partial unique indexes make cheap. Touches Freeze F's uniqueness contract and the drift verifier (which already reads `indpred`), so Critical rather than Mechanical. **Sequencing is your call** — it is small, but it is a correctness defect in shipped modules, so it arguably outranks several rows above it. |

## Competitive architecture review — 2026-07-27

Source: a read of the nearest competitor's public engineering record (thirteen posts,
product pages, and outside coverage) against this repository. They are three years
ahead on product and are **currently building our architecture** — their in-progress
roadmap is an application language, a deployment toolchain for it, and versioned
modules with explicit imports/exports, retrofitted under a live system whose customer
configurations are already free-form. Nothing here reopens a ratified decision; five
findings are cheap corrections or free rulings, each routed to an **existing** row per
the row-1a disposition-integrity rule.

| ID | Finding | Owning row | Latest responsible moment |
|---|---|---|---|
| **D1** | One durable-execution substrate; no packet invents a second job mechanism. `apps/worker/` is empty and `trust_outbox` already has no consumer | **row 3** (G2-P8 import) | Import is the first genuine consumer; four more follow |
| **D2** | Keep the reference graph the compiler already computes and discards, at element granularity | **row 4** (v3 bump) | **The only closing window.** Ride this bump or buy a second one |
| **D3** | Policy narrowing lowers into the compiled predicate; post-filtering breaks pagination | **rows 5 and 7** | Seam at Q1 (row 5), because it precedes the kernel (row 7) |
| **D4** | A declared permission with no evaluator binding fails compilation — prevent, don't detect | **row 7** (policy kernel) | With its first satisfier; cheapest at four modules |
| **D5** | Compact and full are alternative renderings, never simultaneously mounted | **row 1** (G2-P5d) | While slot dispatch is being unified |

**Deliberately not taken**, recorded so it is not re-argued: their multi-store topology
(seven systems, four staleness boundaries), application-layer write authorization
(which they label Phase 1 themselves), and free-form graph configuration — the thing
three of their four in-progress roadmap items exist to escape.

**One finding needs no action.** Their formula engine kept one language and added a
second execution target when scale demanded it, changing no authored syntax. That is
direct external validation of ADR-0012's per-target evaluators and cost classes, and it
means the execution-target choice for `SUM(posted movement.quantity_delta)` is freely
deferrable **provided on-hand is a declared aggregate rather than hand-written SQL in an
inventory service** — which is already the recorded Q1-before-G3 constraint. It adds
weight to that ruling; it creates no work.

## Settled by debate (2026-07-25)

The [RLS index-access debate](debates/pr6-rls-index-access-verdict.md) is CLOSED and
binding. Ratified: stored generated folded columns as the index mechanism; advisory
resolve keys covered, not just unique business keys; prefix search lowered to
leakproof range quals; unanchored substring stays a bounded partition scan whose cost
is invariant in tenant count. Rejected: `LEAKPROOF` marking (superuser + silent
`CREATE OR REPLACE` reversion), schema-per-tenant (measured to die at 1,000-2,000
tenants), agent-written SQL and SQL-over-emitted-views (ADR-0009 stands). End-state
topology is pooled pods with whale tenants tiered — **no decision needed now, shard
count of one is today**. Aggregation is **Q1**, already specified by plan §5.1/§5.9/
§9.2.2, and it **must exist before G3** because G3's on-hand is itself an aggregate.

## Settled by debate (2026-07-26)

The [expression-kernel debate](debates/expression-kernel-verdict.md) is CLOSED, converged,
and **RATIFIED** — binding on packet writers, who follow it and do not relitigate it.
Ratified: `PredicateExpression` becomes the Formula IR's
wire-compatible v0 by declaration, never by rename; the language is total and terminating
(term sorting in `normalize.ts` already bakes in evaluation-order-independence, so
short-circuit semantics are inexpressible by construction); one language with per-position
profiles across five execution targets; SQL admissibility as cost classes with paired
execution-observed probes; the kernel lives inside `canonical-model`, exposing a
wire-shaped `parse(unknown) -> IR` keyed on each node's own `schemaVersion` because
pinned releases must be read forward forever; workflow mutation steps invoke **whole
Semantic Operations**, never `EffectGraph` nodes, and compensation is a named correcting
operation. Rejected: G6 as the deadline; a hybrid client evaluator now (deferred behind a
seven-point admission bar, with the server evaluator environment-neutral from birth so the
client lowering stays a compile-target decision); an ADR-only packet (a declared rule with
no executing gate, and Mechanical by tier); a new `expression-kernel` package; relocating
the existing fence unchanged.

**The governing lesson is from our own quarry.** `/home/rvham/2rain_erp` already had ONE
unified `RuntimeConditionAst` with six declared consumers — guard, validation, filter,
automation, metric, surface — and it still forked, because the metric service
re-implemented the same AST with strict `===` against the canonical evaluator's coercing
`scalarEqual`, compiled it separately to SQL strings, and diverged again on
`localeCompare`. **One language is necessary but not sufficient; the invariant is one
owned evaluator per execution target**, and the out-of-kernel dispatch tripwire must cover
the server, not only the browser.

Two defects surfaced and are routed: the current trivial-predicate fence is **not
fail-closed** (`assertQueryDefinition` requires only that `filter` be an object, so
unknown-version and unknown-property predicates execute as `true`), and operation
preconditions have **no field-locality check** where query filters do
(`normalize.ts:1050-1064` vs `:1074-1083`) — latent only while the fence rejects
non-trivial preconditions, a cross-entity leak the day it opens.

## LLM-assisted verification of the expression kernel — what lands when

**Status: proposed by the orchestrator, not ratified.** Each row becomes real work
only when its trigger fires and a packet is selected. Recorded here so the sequencing
is not rediscovered, and because two of the three are cheapest to build for our own
evaluator before they ever face a tenant.

The governing constraint is the ratified verdict's own boundary: an LLM may author at
compile time, operate at runtime only by selecting registered operations, and critique
offline — **it may never evaluate a business rule at runtime.** Everything below is
CI-time or authoring-time and produces artifacts a deterministic check then judges.

| # | Item | Trigger — not a date | Owning row/stage | Why exactly then |
|---|---|---|---|---|
| L1 | **Obligations named, nothing built** | now | row 1 (ADR-0012) | The ADR already requires per-evaluation explanation and a static out-of-kernel dispatch scan recorded honestly as a proxy. It builds no corpus and no model-assisted gate. Correct: today the fence admits only literal `true`, so there is nothing to diverge and nothing to fork. |
| L2 | **Differential parity corpus, v1** | first non-trivial SQL lowering | row 8 (Q1) | Q1 is the first tier to compile and SQL-lower real filters. From that moment IR semantics and PostgreSQL semantics can disagree — absent values against three-valued logic, exact-decimal ordering against `numeric`, case-fold parity against the database-owned `nsm_unicode_case_fold_v1`. The verdict calls this drift **invisible**, which is why it needs a corpus rather than review. LLM generates adversarial cases; **the differential judges them, never the model**. Unbounded to enumerate by hand, bounded to check by machine. |
| L3 | **Model-assisted dispatch tripwire** | same trigger as L2 | row 8 (Q1) | Worth having only once the evaluator has behavior worth re-implementing. Strengthens, never replaces, the execution receipts. Justified by our own history: the quarry's second evaluator was a `switch` on `condition.kind` inside a metrics function (`runtime-metric-service.ts:478`) — semantically a fork, syntactically invisible to a pattern scan. Remains a proxy; its limits stay recorded per AGENTS.md §6. |
| L4 | **Scenarios-as-specification prototype** | alongside L2 | row 8 (Q1) | Expressions are total, terminating and small, which makes the kernel the safest possible first consumer: generate scenarios, verify deterministically, have a human approve *behavior* rather than *implementation*. Build it for our own evaluator, where a mistake costs a red build. |
| L5 | **Corpus becomes bidirectional and production-critical** | server-side production evaluation exists | G6 | G6 adds validation, guards, defaults and visibility evaluated on the server for real. Only then do both targets run in production and the parity corpus guards live behaviour in both directions rather than one compiled direction. |
| L6 | **Scenarios-as-specification becomes tenant-facing** | first customer-authored customization | G6 | Promotes L4 into the customization publication lifecycle (plan §10.1). This is the scheduled answer to the prior-art audit's **E1** finding — a tenant author writing both the customization and the assertions that verify it reproduces Salesforce's 75%-coverage ritual. Compiler-derived assertions gate the candidate; author-supplied scenarios are additive only, never the whole gate. See [prior-art-failure-modes.md](prior-art-failure-modes.md). |

Reading of the schedule: **L1 is the only item inside the current packet, and it builds
none of this.** L2-L4 all fire on the same trigger — the first non-trivial SQL lowering,
which is Q1 (row 8, G3-blocking) — so they are one body of work, not three. L5-L6 are
G6 promotions of that same machinery, not new inventions. Building it once for our own
evaluator is how the tenant-facing version is de-risked before it faces tenants.

**The authoring counterpart is tracked separately.** L1-L6 are all *verification*. The
highest-value authoring play — the builder **negotiating the requirement** against the
existing vocabulary before declaring a gap — is recorded as `prose-only` in
[`doctrine-coverage.md`](doctrine-coverage.md). It reduces the primitives a requirement
consumes from the *demand* side rather than the supply side, which is the one direction
consolidation cannot reach, and it carries no safety surface because its output is still a
semantic patch the compiler validates. Its failure mode — an over-eager negotiator talking a
user into a near-miss — is caught by L4/L6: the user approves *scenarios*, so an alternative
that does not meet the real need fails them.

What LLMs do **not** address here, stated so it is not re-litigated: the evaluator
itself (roughly two hundred lines — writing it was never the bottleneck; nobody writing
a *second* one is the point), and the semantic rulings on absent values, decimal
ordering, fold parity and literal-versus-pattern search input. Those are frozen into an
immutable language, so a model may enumerate options and consequences but ratification
is human.

## Domain-model one-way doors — RULED 2026-07-26

An independent re-derivation of the prior art (recorded as **section G** of
[`prior-art-failure-modes.md`](prior-art-failure-modes.md)) found eleven failure modes the
audit's sections A-F did not cover. Sections A-F are almost entirely about *customization
architecture*; section G is about the **domain model, the operational envelope, and the
business**, and that is where the remaining exposure now sits.

Four of them are one-way doors that close permanently when the first inventory movement is
posted. They are ruled, user-authorized, and carried by four ADRs:

| Audit | Decision | ADR |
|---|---|---|
| G2 | `legalEntityId` on every business record from creation, as a **business** dimension — deliberately **not** a second tenancy axis, so ABI leading keys and RLS predicates are untouched and cross-entity consolidated reporting stays reachable | [ADR-0015](../decisions/ADR-0015-legal-entity-business-dimension.md) |
| G1 | Stock identity is a declared versioned dimension set; every movement stamps its version; `unspecified` is a member, not a null; extension is governed with a re-baseline operation; base unit is immutable once a movement exists | [ADR-0016](../decisions/ADR-0016-stock-identity-dimension-set.md) |
| G3 | Capture the inputs, compute nothing: receipt lines record actual cost or an **explicit absence**; movements carry no amount; `inventory.value` is `unsupported` | [ADR-0017](../decisions/ADR-0017-cost-capture-without-valuation.md) |
| G6 | Distinct effective/recorded time with recorded time never editable and **never discarded by any projection**; tenant-declared zone and business day; per-entity period lock enforced inside the posting transaction | [ADR-0018](../decisions/ADR-0018-temporal-authority.md) |

Two more section-G findings were closed the same day. Their deadlines are softer — nothing
becomes impossible on a given day — but each carries one piece that decays:

| Audit | Decision | ADR |
|---|---|---|
| G4 | **Tenant completeness manifest** (every table in every plane classified exactly once, verifier fails closed) plus three named recovery tiers — R1 in-band logical, R2 governed PITR reconciliation under a write freeze, R3 reconstruction into a fresh environment — and the binding rule that **no recovery path writes business rows into a live tenant by direct DML** | [ADR-0019](../decisions/ADR-0019-tenant-completeness-and-single-tenant-recovery.md) |
| G7 | The budgeted unit is the **publish path**, not the compiler; **platform exclusion imposed on other tenants** is a second axis with a different remedy; a **breadth envelope** across N modules replaces the single-maximal-module point; and **verification scope narrows only by recorded impact analysis** | [ADR-0020](../decisions/ADR-0020-publish-path-budget-and-verification-integrity.md) |

**What decays in those two:** the manifest is cheap at roughly ten tables and an archaeology
project at a hundred (G3 cut, item 7); the breadth envelope is a curve that cannot be
reconstructed if it is never started (startable now — see queue row 12). Everything else in
ADR-0019/ADR-0020 is scheduled at G7 and G6 respectively.

**Two connections worth carrying forward.** ADR-0020's verification-integrity clause shares its
root with audit **E1**: Salesforce's 75%-coverage ritual and its documented
disable-synchronous-compile guidance are the same failure at two ends — verification that
exists to be satisfied rather than to be true. And ADR-0020's second axis promotes PR-6c's
platform-wide advisory-key finding from a recorded note into a budgeted quantity, which is what
eventually lets the procedural 2,000 ms trigger become a coded admission input.

**The deadline is real and it is not a date.** The four one-way doors close when G3 posts its
first movement,
not on a calendar. Plan §11.6 now carries them as **binding prerequisites** ahead of the
build list, the G3 gate proves each one with negative controls, plan §17 makes each a stop
rule, and ledger rows `G3-P0`/`G4-P0` are seeded with their obligation lists in
[`stage-cut-inputs.md`](stage-cut-inputs.md) §G3 and §G4. The G3 cut may not disposition any
of them as a deferral past the posting service.

**Two rulings worth carrying forward, because they were the non-obvious part:**

- Legal entity is a *business* dimension, not a tenancy axis. Modelling it as tenancy would
  have made cross-entity consolidated reporting — an ordinary authorized requirement —
  unreachable by construction, and would have forced an ABI change reopening Freeze F, the
  PR-6 relation indexes and the PR-6b folded columns. The physical-column-reservation
  alternative for stock dimensions was offered and rejected for the same reason in reverse:
  the version stamp achieves governed extension without carrying four unused columns through
  every index from G3 to N3.
- The general form is: **excluding a capability never authorizes discarding what that
  capability will need.** Plan §2.3 now says so, for stock dimensions, unit conversion,
  valuation and bitemporal reporting alike.

## Authoring architecture — recorded 2026-07-27

A working session on primitive coverage produced four plan sections and one new strategy
lever. Nothing here is a scheduling change; it is doctrine that was being assumed rather
than written.

| Plan | What it fixes |
|---|---|
| **§5.12** the primitive floor (F1-F7) | Head-of-distribution holes: the predicate language admits only `field OPERATOR literal`, so `shippedQuantity > orderedQuantity` is inexpressible. Escapes are the wrong instrument for that |
| **§5.13** the realization cascade | An ordered cascade over program rule #5's dispositions, restoring the **CAPABILITY** (Tier B) route and adding **CONNECTED** for network-shaped demand, which no position body can serve. Realizations are named rather than lettered, because ADR-0019 already owns R1/R2/R3 for recovery tiers. A single "bounded work over held data" test routed tax determination and period-lock enforcement into the expression language; the cascade instead keys on §5.9's **declared capability families** first — so a novel tax requirement routes to CAPABILITY even before any tax capability exists — then on whether the requirement *invokes, alters, or produces* a published authoritative input/output. Merely **reading** such a field does not route there, or every cross-record validation would. **REMAINDER** replaces bare deferral |
| **§5.14** iteration contexts | The no-loops rule binds *expressions only*. Bulk and workflow iterate durably. The governing principle is "anything evaluated while a caller waits must be provably finite" |
| **§5.15** domain reference corpus | Expressibility and safety do not make a change *correct for its domain*. Capability-attached, tiered, reference-never-authority, pinned, no live retrieval in the authoring path |
| **§10.6** authority boundary | Tenants own decisions; the platform owns figures that accumulate. Plus: every Tier B pack must declare a typed configuration surface |

[Lever 5](coverage-strategy-levers.md) carries the reasoning: **AI as translator makes
verbosity free**, which removes the ergonomic pressure that historically capped declarative
languages and produced audit B4's ratchet. It also records why "just build the sandbox"
fails despite producing an identical coverage number — bodies cannot lower to SQL, cannot
be filtered or aggregated on, cannot be re-applied on upgrade, and are opaque to our own
operations agent.

**Three measured findings worth carrying forward:**

- A predicate node kind touches **four files, ~20 lines**, all in `canonical-model`. Primitives
  are not expensive; the **evaluator-plus-parity harness** is the one-time fixed cost, and it
  is the highest-leverage unbuilt thing — ahead of both more primitives and the sandbox.
- **Body density**, not coverage, is what distinguishes a floor-plus-escape system from an
  escape-only one. Both reach the same coverage number. Nothing measures it.
- **Recursive hierarchy is a genuine, unowned gap.** G2-P7 descoped Location's hierarchy on
  exactly this boundary. No loop or escape body resolves it — a body cannot fetch rows. The
  answer is compiler-maintained ancestry paths lowering descendant queries to a prefix match.

**The sequencing argument, corrected.** An earlier draft claimed that shipping the sandbox
before the floor means the floor never ships. That is retracted as unfalsifiable, and audit
B4 leans against it — escape-first vendors extended their declarative layers for a decade
afterward. The defensible form is mechanical: shipping escapes first puts the §17 stop rule
in immediate tension with real demand, so every head-shaped request either trips the rule or
forces its repeal. **Floor-first is the only order in which that stop rule is cheap to
honour.**

## Plan-level decisions still pending before G3

These are **not code work**. They change the storage model or the launch scope, so they
are cheapest to decide before inventory exists.

1. **Erasure / data-subject rights.** No-hard-delete + additive-only + append-only trust
   facts + one shared database currently has **no erasure path**. Raised independently by
   two external reviews. Crypto-shredding (per-subject key, delete the key) is the standard
   answer and changes the storage model. The debate removed the `DROP SCHEMA` escape:
   schema-per-tenant relocates only module tables, leaving release, trust, audit,
   outbox and receipt rows shared. Potential launch blocker in EU jurisdictions.
   Now also [audit G5](prior-art-failure-modes.md); it is a binary jurisdictional gate, not
   a cost curve, which is why it is not ranked against the engineering items.
2. **Identity/policy kernel ownership.** `CurrentPolicyGateway` and `AuthenticateRequest`
   are well-designed deny-capable ports whose only implementations are allow-all stubs.
   Every module declares `permissionId`s that nothing evaluates. Plan §13 has no work-package
   ID for identity/roles/policy, and it had no `doctrine-coverage.md` row until PR-4.
   Now also [audit G8](prior-art-failure-modes.md), which records the consequence for this
   document's other verdicts: F3 and F6 are graded on *structure*, and the structure is
   right, but the gateway those paths consult currently says yes to everything. ADR-0015's
   entity narrowing depends on the same kernel.
**Closed 2026-07-26:** the former decision 3, single-tenant restore, is now
[ADR-0019](../decisions/ADR-0019-tenant-completeness-and-single-tenant-recovery.md). The
*mechanism* is decided; what remains at G7 is the **commercial** question of whether it is a
published promise with an RTO/RPO or an operator capability with a best-effort target, and
ADR-0019 recommends the latter for R2 because its tenant write freeze makes a hard RTO
dishonest.

### Section G items that are not plan decisions

Recorded so they are not silently dropped: **G9** distribution and channel economics (belongs
in the tracked risk register, and no architectural work retires it); **G10** agent cost per
completed journey (add the field to §15.6's existing evidence artifact — now carried by
[`stage-cut-inputs.md`](stage-cut-inputs.md) §G7 item 4); **G11** symmetry and the late Tier C
escape hatch compounding, which promotes audit B5 to the highest-ranked genuinely open item.

## Review sources feeding this queue

| Review | Where | Status |
|---|---|---|
| Whole-app program review (dual max-effort, converged) | `docs/execution/program-reviews/2026-07-24-g2-p3-party/` | Archived; produced PR-1/2/3 |
| External design review — 7 derived-decision problems | [request](program-reviews/2026-07-24-external-design-review/request.md); [review](program-reviews/2026-07-24-external-design-review/review.md) | Archived |
| External performance/scaling review — F1–F12 | [review](program-reviews/2026-07-24-external-performance-scaling/review.md) | Archived |
| External architecture review — 7 findings | [review](program-reviews/2026-07-24-external-architecture/review.md) | Archived |

### Findings inventory (dispositioned)

**Acted on / queued** — idempotency scope (PR-5) · index coverage F1–F3 (PR-6) ·
release-load cache F4 + relation N+1 F5 + round trips F6–F10 + advisory-lock namespace
F12 (PR-7) · glob/CI blind spots (PR-4) · identity-policy coverage row (PR-4).

**Routed to owning packets** — RLS policies must be `RESTRICTIVE` with one kernel-owned
permissive base, plus restoring the `principal_id` `WITH CHECK` that PR-5's migration 0010
dropped from the receipt INSERT policy where only SELECT needed widening (policy kernel packet) · movements table partitioned by `(tenant, period)`
**from creation**, TigerBeetle-shaped two-phase reservation, anchor row as *derived cache
with a proof obligation*, natural-key idempotency `(source_type, source_id, source_line,
revision, posting_role)` (G3) · coexistence horizon / release lease to make tightening debt
collectible (cleanup family) · signed approval→root, superuser-owned DDL event-trigger
witness, unknown-kind blocks *activation* not *serving*, `indisvalid` in declared shape,
step-receipt in the same transaction as its DDL (next materializer packet) · mutation
testing, concurrent probes, canary tokens for absence invariants (conformance suite) ·
opaque resolver handles + gateway-enforced confirmation binding, or the agent re-creates
auto-select one layer up (agent packet) · approval-diff renderer treated as a security
control (G6) · PITR restore must replay materialization to the union of live roots ·
rollback conformance scenario (the pointer-swap rollback story is currently untold).

**Tracked debt (documentation)** — see the owned
[documentation-debt register](documentation-debt.md) for the missing artifact, why it
matters, and the condition that closes each obligation.

## Standing lessons (why the queue looks like this)

- Every escaped defect so far was **a declared rule with no executing gate**. The fix is
  always the gate, not the instance: executable verification (PR-2), full-matrix acceptance
  (PR-1), executed-file reachability (PR-4b), `EXPLAIN` coverage (PR-6).
- Reviews are excellent at what their charter points them at and **structurally blind to
  everything else**. Four max-effort passes missed all twelve performance findings because
  no charter ever asked about plan quality. Vary the charter, not just the reviewer.
- Latent defects in accepted packets surface when a *later* packet exercises them
  (manifest version, monotonic clock, case-fold uniqueness, resolver authority). This is the
  one-real-module-before-fan-out discipline working as designed.
