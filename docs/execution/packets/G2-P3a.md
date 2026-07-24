# G2-P3a — Generic SurfaceRuntime semantic data binding

Status: evidence_ready
Tier: Critical
Frozen candidate: `f0ca4b51c051c9ada1c2adaccc0a1e03df5c794d`

## Goal and scope

Bind the accepted compiled `SurfaceRuntime` to the ratified Freeze-F semantic
runtime without adding a module or surface-specific handler. For every active
compiled surface, the selected `dataSourceQueryId` resolves through the
Semantic Query gateway and the surface's entity-compatible O0 bindings resolve
from the pinned operation catalog through the Semantic Operation gateway. The
issued `RequestRuntimeView` remains the only tenant, environment, principal,
release, and policy context.

This is a new shared packet inserted before the first Party walking slice. Its
ledger ID is `G2-P3a`; the formerly planned `G2-P3` Party packet is resequenced
as `G2-P3b`. It moves generic surface-to-gateway data binding out of the planned
G2-P4 packet, narrowing G2-P4 to the plan §8.6 grammar-conformance suite. It
composes the ratified G1 surface/pinning/gateway contracts and Freeze F, so no
debate is required.

Owned paths:

- `apps/web/src/surface-runtime.ts`
- `apps/web/src/component-registry.ts`
- `apps/web/src/surface-contract.ts`
- `apps/web/src/app-server.ts`
- `test/integration/surface-data-binding*.test.ts`
- `apps/web/test/browser/surface-data-binding*.spec.ts`
- `test/architecture/surface-data-binding*.test.ts`
- this packet record and `docs/execution/ledger.md`

Out of scope: the full five-archetype/focus/contrast/44px/compact grammar suite
(G2-P4), rich table paging/sort/search/saved-filter behavior (G2-P5), real
Party/Catalog/Location definitions, agent UI, compiler/runtime/provider
contract changes, migrations, and schema changes.

## Contract and implementation

- The server accepts exact Semantic Query and Semantic Operation gateway
  instances as injected ports; `apps/web` has no provider, PostgreSQL, SQL, or
  direct database seam.
- A surface's compiled query ID is validated against the pinned query catalog.
  Collection queries bind only to list surfaces; singular queries bind only to
  form/record surfaces, so a compiler-valid but cardinality-incompatible pair
  fails closed before a query or operation runs.
  Its source entity selects the active O0 create/update/archive/restore entries
  from the pinned operation catalog. Duplicate bindings, unknown/destructive
  effects, and malformed projection envelopes fail closed.
- GET builds only Q0 arguments appropriate to the compiled query kind and
  renders DTOs through the component registry. Exact, empty, ambiguous,
  not-found, unsupported, policy-denied, and unavailable outcomes have bounded
  safe states; exception text and physical storage details are never rendered.
- POST accepts a semantic intent, record/revision facts, and compiled field
  values. It never accepts an operation ID, handler name, trusted identity, or
  SQL. The operation ID is resolved from the pinned catalog, dispatched through
  the operation gateway, then its authoritative gateway read-back is reflected
  directly in the same pinned request view without a second query displacing
  the affected record. Compiled human-confirmation requirements are carried by
  create/update and lifecycle forms.
- The accepted G1 data-less renderer/server composition remains supported for
  the shell fixture. Live binding is enabled only when the composition root
  provides both semantic gateways.

The P2c fixture is compiled at test time. Integration and browser tests use
its surface/query/operation projections with a generic in-memory executor so
the binding layer can be tested deterministically; the required full
PostgreSQL gate separately reruns the accepted P2c interpreter, trust
transaction, RLS, role-assumption, and cross-tenant evidence unchanged.

## Decisive review charter

Threat model: honest-code data-binding defects—per-module hardcoding, policy
bypass, tenant/environment bleed, physical table leakage, or a mutation/trust
split. Hostile input, grammar conformance, rich table behavior, real modules,
and agent UI are out of scope.

The Critical review answers only:

1. Is the binding generic for any compiled surface using
   `dataSourceQueryId` and pinned operation bindings, with zero module/surface
   branches?
2. Do reads pass through the Semantic Query gateway with the issued view's
   policy and tenant/environment scope, without physical metadata in the
   client DTO/diagnostic?
3. Do writes pass through the Semantic Operation gateway, preserve its
   trust-wrapped atomic path, and reflect gateway read-back?
4. Do all frozen Q0 outcomes render their correct bounded state without a
   crash or leak?
5. Is `apps/web` free of direct database/SQL/provider access and limited to
   the two semantic gateways plus the issued request view?

Review chain: one fresh naive Codex `gpt-5.6-sol` xhigh review, then Fable max
on the identical unchanged SHA. Any fix creates a new SHA and fresh review;
maximum two REVISE rounds.

## Evidence

The frozen candidate is
`f0ca4b51c051c9ada1c2adaccc0a1e03df5c794d`. The completed proof establishes:

- the exact P2c fixture definition compiles at test time and supplies the
  surface/query/operation projections; production web source contains no
  fixture, module, entity, query, operation, or surface literal;
- list DTOs remain tenant-scoped through the issued view and policy gateway;
  a second tenant's row never renders;
- create, update, archive, and restore browser intents resolve to the four
  compiled O0 effects without accepting an operation ID, and every result
  carries the four linked trust identities;
- exact data, empty, ambiguous, not-found, unsupported, denied, and thrown
  error paths render deterministic bounded states; planted physical table text
  in an exception is not reflected;
- a compiler-valid form-to-list mismatch fails closed before gateway execution,
  human-confirmed create/update forms submit confirmation, and a deliberately
  unavailable follow-up query cannot displace the authoritative operation
  read-back;
- the Chromium fixture journey displays live rows and fields, creates through
  the form, reflects read-back plus linked-trust status, and then shows the new
  row in the list; and
- the unchanged full PostgreSQL suite reruns the P2c generic interpreter,
  transactional trust facts, role assumption, RLS, coexistence, and
  cross-tenant proofs against all eight migrations.

| Gate | Result |
|---|---|
| `corepack pnpm typecheck` | PASS |
| `corepack pnpm check:boundaries` | PASS — 87 production files scanned |
| `corepack pnpm format` | PASS |
| `corepack pnpm test:integration` | PASS — 38/38 tests |
| `corepack pnpm test:architecture` | PASS — 41/41 tests |
| `corepack pnpm test:browser` | PASS — 4/4 Chromium journeys |
| `corepack pnpm test:postgres` | PASS — 57/57 tests |
| `corepack pnpm check:schema` | PASS — 8/8, clean drift |
| `git diff --check` and owned-path audit | PASS |

Fresh Codex `gpt-5.6-sol` xhigh review round 1 returned REVISE on
`13c6eb737a277008eea2aeef9ff410f18220b4a0`: singular surfaces could consume a
collection query, successful writes re-queried instead of rendering the
authoritative operation read-back, and human-confirmed create/update forms did
not submit confirmation. The bounded in-lease fixes above resolve all three;
fresh naive Codex `gpt-5.6-sol` xhigh returned PASS on all five charter
questions for replacement candidate `f0ca4b5`, with no material or out-of-scope
finding. Fable max then returned PASS on the identical unchanged SHA with no
material finding; its observations were explicitly immaterial or deferred UX
polish. No compiler, runtime, provider, migration, schema-snapshot, real-module,
or out-of-lease file changed.

## Test it yourself

From the repository root, the deterministic proof takes under ten minutes:

```bash
cd /home/rvham/2rain-greenfield
git show -s --format=%H f0ca4b51c051c9ada1c2adaccc0a1e03df5c794d
node --import tsx --test test/integration/surface-data-binding.test.ts
node --import tsx --test test/architecture/surface-data-binding.test.ts
corepack pnpm test:postgres
corepack pnpm check:schema
```

Expect the exact frozen SHA, 4/4 focused integration tests, 3/3 focused
architecture tests, 57/57 PostgreSQL tests, and `8 applied / 8 verified` with
clean drift.

For a screenshot-able browser walkthrough, run:

```bash
cd /home/rvham/2rain-greenfield
corepack pnpm exec playwright test \
  --config apps/web/playwright.config.ts \
  apps/web/test/browser/surface-data-binding.spec.ts \
  --debug --workers=1
```

In the Playwright inspector, step through the single journey. The browser first
shows `Existing live master` in the compiled fixture list. It then opens
`master form`, enters `Browser-created master`, submits `Create record`, shows
`Create complete` with linked trust evidence, and returns to the list where the
new row is visible. That browser is suitable for taking the checkpoint
screenshot; no application server or database setup is required outside the
test command.

## Program-review trigger assessment

No whole-app program review is due at this checkpoint: this packet is not a
clean integrated `main` checkpoint, and the first real Party walking slice has
not landed. Re-evaluate after accepted G2-P3b Party, immediately before the
Catalog/Location fan-out; that is the doctrine's highest-value milestone
trigger.

## Candidate next packet

The next user-selectable packet is G2-P3b, the real Party walking slice and
reusable module template. It has not been started.

Stop at this packet's reviewed checkpoint. Do not integrate and do not start
G2-P3b.
