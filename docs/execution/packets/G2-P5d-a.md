# G2-P5d-a — Slot-driven list and record chrome

Status: evidence ready; frozen candidate reported in the writer handoff

Tier: Behavioral

Branch: `packet/g2-p5d-a`

Base: `5eebb4b752a1732046fa8cfe3936593a7016b45a`

Frozen candidate: reported in the writer handoff because a commit cannot contain
its own SHA

## Outcome

The composed application now looks and behaves like one application rather than
a working data panel mounted below a failed component:

- SurfaceRuntime renders ordinary List and Record content through compiled slots;
  the former hardwired sibling data panel no longer exists;
- the grammar-owned dispatcher is keyed by `(archetype, slot)`, while the existing
  closed component registry continues to dispatch shell-owned opaque content by
  `contentReferenceId`;
- List surfaces render a title, New affordance, covered data grid, and row links;
- Record detail surfaces render breadcrumb, title/status, command bar, and a
  simple key-facts field list;
- Record form surfaces render breadcrumb, title/status, Save command, and the
  existing semantic-operation form as sections;
- New, row-to-record, Edit, Save, archive, and restore are derived from compiled
  surfaces that share the same query source entity—there is no module-specific
  route or renderer, and lifecycle actions remain behind the command overflow;
  and
- startup seeds four plausible Parties, four Items, and four Locations through
  the Semantic Operation gateway. Their deterministic idempotency keys make
  restart safe, and the database retains both the records and linked trust facts.

The diagnostic demo shell remains byte-identical. Its intentional
`UNSUPPORTED_COMPONENT` and renderer-failure surfaces still exercise the old
content-ID registry and remain browser-tested negative controls.

## Established baseline

The branch was cut in an isolated worktree from exact SHA
`5eebb4b752a1732046fa8cfe3936593a7016b45a`. The observed baseline was:

| Gate | Baseline observation |
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
| `test:locale` | 1 / 1 |
| `test:browser` | 15 / 15 |
| observability producer | 5 / 5 |
| `check:reachability` | 68 / 68 files from 9 producer artifacts |

The first PostgreSQL attempt was honestly red at 85 / 86. Only
`saved-filter List excludes archived siblings and fails on an active corrupt sibling`
failed because the ephemeral container's published port returned `ECONNREFUSED`
for the full 30-second readiness window while PostgreSQL reported ready inside the
container. An explicit retry was 86 / 86. The flake is routed to the repository
hygiene row; it is not hidden inside the green summary.

## One rendering path

`renderedSlots` is now the whole product body for List and Record archetypes.
Every slot receives the pinned surface, all pinned surfaces, semantic query data,
operation bindings, and feedback. A separate literal `surfaceSlotRegistry` maps
only these pairs:

- `list:title` and `list:dataGrid`;
- `record:breadcrumb`, `record:titleStatus`, `record:commandBar`,
  `record:keyFacts`, and `record:sections`.

Dispatch is intentionally ordered as slot renderer, opaque content-ID renderer,
then `UNSUPPORTED_COMPONENT`. No Home, Task, or Builder pair is registered, so the
diagnostic shell's `home:exceptions` negative control cannot become supported by
accident.

The initial namespace ruling proposed module references to
`northstar.shell:component.*`. An actual compiler probe rejected that shape with
seven `CANON_ID_NAMESPACE_MISMATCH` and six
`CANON_REFERENCE_CROSS_PACKAGE_UNSUPPORTED` diagnostics: owned references must be
born in the package namespace and separate package composition remains unsupported.
The bridge ruling corrected the mechanism. Module-local
`contentReferenceId` values remain legal package data, and the already-global slot
grammar selects the platform renderer. This rule is now recorded in prose in the
`ux-grammar` skill; its machine-read component pin remains byte-unchanged.

The former `renderSurfaceDataComponent` implementation was relocated into
`list:dataGrid`, and the former form implementation into `record:sections`.
The exported list helper remains as a compatibility projection for non-browser
consumers, but SurfaceRuntime does not invoke it. There is one table renderer and
one form renderer, not a new implementation beside the old one.

Compiler-valid older fixtures can still carry only `record:sections` or
`record:keyFacts`. When `titleStatus` is absent, those same slot renderers keep the
operation feedback or lifecycle token inside the declared content slot. When
`commandBar` is absent, `sections` retains its Save control and `keyFacts` retains
the same overflow-contained lifecycle action. A browser journey compiles and uses
the unmodified one-slot fixture rather than rewriting its slots. This is a
backward-compatibility projection for a pinned release, not a second sibling panel;
current product surfaces take the title/status and command-bar paths and do not
duplicate them.

Compact and full layouts are explicitly alternative renderings of the same slot
set and must never be mounted together. This packet records that contract but does
not implement the deferred responsive projection.

## Declared anatomy and conformance ratchet

Party, Catalog, and Location retain one definition source each. Their standalone
and composed instantiations now declare the same partial anatomy:

| Surface role | Declared slots |
|---|---|
| List | `title`, `dataGrid` |
| Record detail | `breadcrumb`, `titleStatus`, `commandBar`, `keyFacts` |
| Record form | `breadcrumb`, `titleStatus`, `commandBar`, `sections` |

The production conformance checker observed the resulting debt reduction:

| Module | Before | After | Reduction |
|---|---:|---:|---:|
| Catalog | 33 | 19 | 14 |
| Location | 33 | 19 | 14 |
| Party | 64 | 36 | 28 |
| Platform | 33 | 33 | 0 |
| **Total** | **163** | **107** | **56** |

Platform stays at 33 deliberately. It is absent from the composed application,
and queue row 1c owns the binding decision about its storage and runtime
classification. Moving its UI template here would pre-empt that decision.

The regenerated product release has application root
`3c28c43afc674d24511706a4dbabb2d846e0cd4b50ba8185546bbcb2408ff343`.
It still contains three modules, four entities, sixteen queries, sixteen
operations, twelve surfaces, and twenty-one application artifacts. The bootstrap
root remains
`7619e59cba92a3cc786eae11c0d9f83a6bb344e3d613a3039b53a1d05cfa1a55`.
The diagnostic shell authored and compiled files retain their exact pre-packet
SHA-256 hashes (`9584ff11…` and `40e58628…` respectively).

## Seed lineage

`apps/api` seeds through exactly the same request entry, pinned runtime view,
operation gateway, mediation authority, and generic PostgreSQL interpreter as the
browser form. It does not import `pg`, issue SQL, or call a repository write.

The composed browser journey observes all twelve returned operation receipts and
joins each receipt's invocation, business-change document, domain event, and outbox
IDs in PostgreSQL under the runtime tenant/environment. It then observes the seeded
values through the browser List. This is stronger than a source scan: the gate
requires the persisted trust linkage that a direct insert would lack.

## Executed negative controls

These are restored scratch failures. The final candidate contains none of the
mutations.

| Vacuity vector | Executed control | Observed red |
|---|---|---|
| a hardwired panel still renders data when the compiled slot is absent | remove only Party List's declared `dataGrid` slot, regenerate the product artifacts, and run the composed journey | Playwright failed at `[data-platform-slot="list:dataGrid"]`: `element(s) not found`; the seeded table did not appear elsewhere |
| product pages still tolerate an unregistered component | remove only the `list:dataGrid` slot-renderer entry | the explicit absence assertion failed: `Expected: 0`, `Received: 1` for `[data-diagnostic-code="UNSUPPORTED_COMPONENT"]` |
| the conformance numbers were edited rather than observed | run the real product ratchet after adding slots but before updating its baseline | `FAIL (4 compiled product modules read; catalog=19/33, location=19/33, party=36/64, platform=33/33; 3 ratchet violations)` and architecture was 70 / 73 |
| seed rows could be direct writes with no operation trust lineage | replace one returned seed outbox ID with a non-existent UUID and run the composed journey | the PostgreSQL join assertion failed with `Expected: "1"`, `Received: "0"` |
| the one-slot compatibility path could still be display-only | remove only the conditional Save fallback and run the unmodified one-slot browser journey | Playwright timed out waiting for `getByRole('button', { name: 'Save' })` at `surface-data-binding.spec.ts:158`; 1 failed |
| Archive could remain a directly exposed command | replace only the command-bar overflow wrapper with the lifecycle form and run the enriched fixture journey | Playwright failed because `[data-platform-slot="record:commandBar"] details.action-overflow` was absent; 1 failed |

Positive observations complement those reds: product pages for Party, Item, and
Location each contain no `UNSUPPORTED_COMPONENT`; all twelve seed receipts have one
exact linked trust row; and the final real product ratchet reports
`catalog=19/19, location=19/19, party=36/36, platform=33/33`.

## Evidence and reproducible commands

Focused development evidence:

```bash
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test:architecture
corepack pnpm test:browser
corepack pnpm check:app-release
```

The architecture suite reports 73 / 73 and prints the four real product counts.
The browser suite reports 16 / 16; its composed journey exercises seeded lists,
New, Save, row-to-record, breadcrumb, Edit, update, reload, full server restart,
and persisted trust linkage. The final full-matrix observations are recorded in
the writer handoff after integration with current `main`.

The first post-integration aggregate at `ed53ab7e5454d65444846fa99db4f09d2e61b614`
was honestly red at integration 58 / 59 and stopped before later suites. The
unchanged one-slot v2 fixture's successful create no longer rendered
`data-operation-intent="create"`, because feedback had moved to a `titleStatus`
slot the old release did not declare. The compatibility projection above restores
that pinned-release observation without restoring the hardwired SurfaceRuntime
panel; the focused integration rerun is 59 / 59.

The first browser rerun after the review fix was honestly red at 13 / 16. The
Party, Catalog, and Location journeys still clicked Archive and Restore as direct
commands and therefore timed out after those consequential actions moved behind
the required overflow. Their expectations now open **More actions** before each
lifecycle transition, making the old consumers observe the new grammar rather than
weakening it.

## Test it yourself

From a clean checkout with Docker running, start an isolated persistent demo:

```bash
NORTH_STAR_DATABASE_CONTAINER=north-star-g2-p5da-check NORTH_STAR_DATABASE_PORT=55433 PORT=4175 corepack pnpm --filter @north-star/api dev
```

Open <http://127.0.0.1:4175>. You should see populated Party, Item, and Location
lists. On Party list, click **New**, enter a number, name, and contact summary,
then click **Save**. Return through the **Party list** breadcrumb or navigation,
click the new row's record link, and use **Edit** to change it. The consequential
**Archive** action is under **More actions**, not presented as a primary command.
No composed product page should show `UNSUPPORTED_COMPONENT`.

Press Ctrl-C and run the same command again. Refresh the browser: the created
record and seeded records remain because the named Docker volume is persistent,
while deterministic seed idempotency prevents duplicates.

What remains intentionally incomplete: List saved views and bulk actions; Record
child tables and activity rail; the compact/responsive projection; Platform/saved
filters; and authorization. Current policy is allow-all, so use only local demo
data.

## Recorded limits and what the gates cannot prove

- The composed `packages/domain/src/app/builder.ts` package is not itself consumed
  by the production-module conformance discovery. That discovery requires a
  `definition.ts` and assumes one module; applying it to this three-module package
  would currently throw. Its three source module definitions are gated, but the
  composed package shape is not independently conformance-ratcheted.
- The total remains 107 rather than zero. `savedViews`, `bulkActions`,
  `childTables`, and `activity` are deferred to G2-P5d-b. An activity rail needs a
  trust read model that does not yet exist.
- This packet records but does not implement the D5 compact/responsive contract.
  Automated contrast and 44px target checks remain inherited from G2-P4; this is
  not the broader G7 manual WCAG audit.
- Authorization is the existing allow-all policy and Platform is absent. Queue
  rows 7 and 1c own those limits respectively.
- The inherited composition root remains a one-time bootstrapper. It cannot
  advance an existing volume to a newly compiled release, so after a future
  product artifact changes this isolated demo volume must be replaced until row
  1g lands release advancement.
- The browser test proves the agent-independent product UI path, not an agent tool
  transport or outbox consumer.

## Review evidence

The first fresh naive Codex xhigh review at
`773682a538ca5aff76d03644b3d4fbe212a2f602` returned `REVISE`. It confirmed the
slot dispatch, generic navigation derivation, seed gateway lineage, trust evidence,
ratchet, diagnostic controls, and scope boundaries, then found two reachable
in-scope defects: compiler-valid one-slot Record surfaces had lost their action
controls, and Archive was directly exposed instead of living behind command-bar
overflow. The conditional fallbacks, generic overflow, browser journeys, and two
executed reds above are the bounded disposition. A fresh review result over the new
frozen SHA is reported in the writer handoff so review metadata does not recursively
change the reviewed commit.
