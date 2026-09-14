# RAIN-META-SALES — metadata-composed fulfillment workspace

Status: blocked on one canonical surface-contract decision; no product implementation.
Owner: sole local BUILD; review online only; no merge or deployment.
Base: `fe97b63baedf8bdd42146318bb89d4be1aa948f6` (main and origin/main after fetch).
Draft PR: https://github.com/AnserBeg/2rain-greenfield/pull/5 (decision only).
Branch: `packet/RAIN-META-SALES`; worktree: `/home/rvham/2rain-greenfield-rain-meta-sales`.
Reference: `AnserBeg/temp_inventory@d057daffd17a199309675a6b0a31c8bdbca05282`.
Reference checkout has local edits; all source reads used `git show` at that pin.

## Charter

Outcome: open a released stocked order; read customer/item/location labels and line
progress; reserve 8 of stock 10, ship 5, release 3, and open complete packing.
Slices: metadata-rendered order/lines; contextual fulfillment tasks; parity and usability.
Application composition belongs to canonical definitions; shared interpretation belongs
in runtime code. Reuse accepted fulfillment, policy, exact quantities, retry and audit.
Planned paths: canonical-model/compiler/domain/application/runtime/postgres-provider,
web runtime/release/scripts, affected tests and inventories, and execution records.
Those directories exist; the current BUILD and SUPPORT rows are idle. No other worktree
is modified. Critical paths are not changed; touching them would require online review.
Gates after implementation: focused tests, generators, affected suites including PostgreSQL,
real-gateway fixture, two compiled presentation variants, renamed-ID reuse and browser checks.
Stop: necessary canonical version/invariant decision, as explicitly required by the user.
No receiving/fulfillment redevelopment, whole-order authoring, pricing, finance or integrations.
Live customization and actual AI execution remain the next milestone before ERP expansion.

## Supported / missing map at the base

| Behavior | Existing symbol | Remaining work |
|---|---|---|
| Canonical Sales graph | `salesModuleDefinition`, `surfaces` in domain Sales definition | Surface composition currently declares one data source and opaque slots only |
| Compiled fields and commands | `surfaceManifestPayload`; `readCompiledSurfaceDataBinding` | Fields equal query selections; commands inferred by source entity; no authored child/context/action carrier |
| Registered grammar | `renderSurfaceRuntime`; `surfaceSlotRegistry` | Shared child/task interpretation must replace Sales-specific section rendering |
| Current order workspace | `loadSalesOrderSection`; `renderSalesOrderSection` | Company-wide reservation/projection reads, UI arithmetic, raw references and handwritten links |
| Exact packing children | `loadShipmentPackingDocument` and shared-list `parentScope` | Reuse exact-parent restriction and coverage check through declared composition |
| Accepted stock mutation | `FulfillmentCapabilityExecutor.prepareAuthorization`, `executeFulfillmentLifecycle`, `PostgresInventoryPostingService` | Reuse gateways; preserve current policy, trusted scope/revision, confirmation and replay |
| Agent projection | compiler `agentDiscoveryPayload` | Inspect emitted contracts and prove UI-free gateway parity after implementation; no LLM claim |
| PaneFlow reference | `SalesOrdersView`, `SalesOrderDetail`, `SalesStageQueue`, reference-picker and CSS | Reference only: connected order actions, readable labels, explicit effect previews and responsive controls |

## One decision request

Approve a versioned, reusable canonical surface-composition extension for this packet.
Recommended carrier: a new readable language version with matching compiler/runtime
capability fencing, preserving historical release reproduction. Keep the five archetypes.
The bounded extension declares ordered labeled field/relation columns; child query bindings
with exact parent scope; operation/navigation actions with explicit order, narrowing
conditions and typed input mappings from the current record, selected child and task inputs.
Mapped input remains untrusted: the existing gateway resolves scope/revision and checks
policy, confirmation and idempotency. No metadata can replace those checks.
Each child binding resolves independently as pending/ready/empty/failed; a failed binding
renders its error and disables dependent actions while successful siblings remain visible.
This also resolves the multiple-binding question explicitly reserved by ux-grammar.
Alternative: retain the existing language and defer this workspace. Bespoke Sales branches
or an opaque renderer reference cannot satisfy the selected requirement.
The exact schema spelling is implementation work after approval; the decision is to admit
this bounded contract and its version boundary, not a broader customization product.

## Evidence and reason for stopping

`normalizedSurfaceDefinition` (`packages/canonical-model/src/schemas.ts:674`) is strict;
its slot content has no child queries, columns, action bindings or context mappings.
`surfaceManifestPayload` (`packages/compiler/src/projections.ts:663`) projects a single
query's selections. `readCompiledSurfaceDataBinding` requires those exact selections.
The reserved renderer escape hatch is refused as `COMPILER_RENDERER_FORM_UNSUPPORTED`
in `packages/compiler/src/conformance.ts`; it would also violate the user's composition rule.
ADR-0056 requires a new carrier decision when the next multi-command workflow needs a
primary action other than Release. ADR-0054 section 2 and ux-grammar's slot-resolution
section reserve the question of independent resolution when a surface gains another binding.
This is a demonstrated contract gap, not a request for ordinary implementation permission.

## Reproduce the schema measurement

From the packet worktree, after `corepack pnpm install --offline --frozen-lockfile`:

```sh
node --import tsx --input-type=module <<'JS'
import { VersionedAuthoredApplicationPackageSchema as schema } from './packages/canonical-model/src/index.ts';
import { salesModuleDefinition } from './packages/domain/src/sales/definition.ts';
const base = salesModuleDefinition();
const cases = [['base', base, true]];
const renamed = structuredClone(base);
renamed.surfaces[0].label = 'Fulfillment workspace';
cases.push(['label variation', renamed, true]);
for (const key of ['fields', 'columns', 'children', 'actionBindings', 'contextMappings']) {
  const candidate = structuredClone(base);
  candidate.surfaces[0][key] = [];
  cases.push([key, candidate, false]);
}
for (const [label, candidate, expected] of cases) {
  const result = schema.safeParse(candidate);
  console.log(label, result.success, result.success ? [] : result.error.issues);
  if (result.success !== expected) process.exitCode = 1;
}
JS
```

Measured 2026-09-14: exit 0; base and label variation admitted; all five new keys
rejected with `unrecognized_keys` at `surfaces[0]`. This proves schema rejection,
not the correctness of a future schema, compiler or UI.
Formatting of the four changed Markdown files passed; `scripts/check-records.sh`
passed (146 records, 166 unique ledger rows). Log: `/tmp/rain-meta-sales-records.log`.
Docker preflight succeeded: server 29.5.2. Offline dependency installation exited 0.
No containers, databases, demonstrations or reference files were changed.
No acceptance journey, browser screenshot, stock result, customization or agent execution
is claimed. No product URL exists for this packet yet. No local review or stage review ran;
this is a pre-implementation decision boundary, not a stabilized stage milestone.
Record-only changes need no executable record-claim block. Publication is a draft decision
checkpoint on the requested branch, to be continued by implementation after the ruling.
