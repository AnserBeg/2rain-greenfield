# G3-P1a — the non-key inventory freeze

Status: evidence ready; human checkpoint pending
Tier: Critical
Lane: DEPLOY
Initial base: `9027a53bd0d4cbe386ec3c4b40285ef7c9ac2c06`

## Goal and scope

Freeze the portion of G3-P1 that does not depend on the composed unique-key
emitter: stock-dimension-set v1, base-unit immutability, the quantity-only
movement and temporal contracts, the movement-money prohibition, inventory
posting's authoritative dependency set, and its typed release-recorded
configuration. This packet emits declarations and a content-addressed contract
release only. It creates no table, handler, movement, balance, or UI.

Owned paths:

- `packages/domain/src/inventory/**`
- `packages/compiler/src/conformance.ts`
- `test/unit/**` and `test/compiler/**`
- `docs/execution/packets/G3-P1a.md`

Out of scope: the legal-entity family map, compiler-derived `legalEntityId`
column, `sameEntity` / `crossEntityAllowed` relations, physical tables,
partitioning, serialization, posting handlers, movement inserts, balance SQL,
reservations, UI, and receipt-cost capture. No file under `canonical-model`,
the compiler kernel/storage/projection paths, or the frozen domain subtrees is
touched.

## Contract release boundary

The canonical application language has no Tier-B capability/configuration
node at v2. This packet does not widen that language: inventory declaration
data compiles through the owned conformance seam into
`northstar.inventory-contract-release/v1`, canonicalized and content-addressed
by the existing canonical JSON authority. The release contains both the
contract and the materialized configuration. It emits no runtime or storage
representation.

The default contract release root is:

```text
f653a6365199f02186832bdab4e55e6009ba914a41fe2a6b3bb9c21e5c8579d5
```

There was no predecessor inventory-contract release digest. No existing app,
shell, storage-target, or provider-consumed release digest moves: this packet
adds the separately versioned inventory contract artifact. Its structural
golden lives at `test/compiler/inventory-contract.release.golden.json`.

## Frozen declarations

### Stock identity and dimension evolution

`northstar.stock-dimension-set/v1` is exactly:

```text
(legalEntityId, itemId, locationId)
```

All three values are required at posting. V1 accepts only the version stamp
`v1`; an absent or unknown stamp fails. An `unspecified` declaration or member
for any of these three dimensions fails
`INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN`. `unspecified` begins only
with a dimension added in v2 or later. Addition is a governed version event
and names `northstar.inventory:operation.re_baseline`; removal is unsupported.

### Base-unit immutability

Base unit changes use a named operation contract. A unit may change before an
item is referenced by a posted movement. After the first reference, the change
fails `INVENTORY_BASE_UNIT_IMMUTABLE`; the typed diagnostic carries the item and
the exact `bindingMovementId`. Later persistence/posting packets supply the
lookup and transactional constraint; this packet freezes the operation result.

### Quantity-only movement

The immutable declaration has no update path and contains these fields:

| Field | Semantic | Frozen shape |
|---|---|---|
| `movementId` | identifier | required |
| `stockDimensionSetVersion` | dimension-set version | required, `v1` only |
| `quantityDelta` | quantity | signed canonical decimal string, precision 38, scale 18 |
| `unitId` | unit | required |
| `effectiveAt` | instant | operation input |
| `recordedAt` | instant | trusted request context |
| `sourceType` | source type | required |
| `sourceId` | identifier | required |
| `sourceLine` | source line | required |
| `postingRole` | posting role | required |

No movement money/amount/cost/value/currency field compiles. A compiled
artifact sourced from movements with monetary output fails separately with
`INVENTORY_MOVEMENT_VALUE_DERIVATION_FORBIDDEN`. Receipt cost remains G4-owned
and valuation remains unsupported.

### Temporal authority

- `effectiveAt` is author-supplied operation input; `recordedAt` comes from
  trusted request context, is retained by projections, and has no update path.
- Tenant IANA zone and business-day boundary are required declarations. UTC is
  not a default.
- `closedThrough` is scoped per legal entity and enforced inside the posting
  transaction.
- Advance and reopen are distinct audited operations with distinct permissions:
  `advance_period_lock` / `advance_period_lock`, and `reopen_period` /
  `reopen_period` in the operation and permission namespaces respectively.

### Authoritative posting dependencies

The v1 release publishes 30 access-qualified dependencies. The compiler pins
their independently computed canonical set root as
`7ef50e86732818a0ec4ec2a03a001066ac59408ea260c65bf018646e4377a63d`
and checks both the declaration and posting access plan against it. Any
undeclared read, append, or state transition fails
`INVENTORY_POSTING_DEPENDENCY_UNDECLARED`; coordinated removal from both arrays
fails the independent root check.

| Authority | Published inputs/outputs |
|---|---|
| Trusted context | tenant, environment, actor, recorded time, release |
| Operation input | stock identity and version, quantity, unit, effective time, source identity, posting role, reason, approval |
| Catalog / Location / Party | item base unit and lifecycle; location lifecycle; legal-entity lifecycle |
| Inventory | period lock, posting configuration, existing movement quantities; transaction-state transition; movement append |
| Trust | idempotency-receipt read/append; invocation, business-change, domain-event, audit, and outbox appends |

Declaration and access-plan arrays and entries are deliberately distinct
objects. Appending an access or mutating an existing access cannot repair the
dependency set before conformance measures it. The compiled release is also a
detached, recursively frozen parse of its canonical bytes, so mutating authored
input after compilation cannot change the object named by the release root.
The eventual capability package must receive only a facade derived from this
release; runtime access is G3-P3, not this freeze.

### Posting configuration and the scope decision

The configuration scope is **per legal entity**. Stock authority, period close,
approval accountability, and the serialized negative-stock decision are
already legal-entity scoped. Tenant scope would let one entity's operating
posture silently control another. Legal-entity scope also imposes negligible
single-entity cost because provisioning supplies one default entity. The
alternative was per tenant; it remains technically narrowable later, but it is
not the v1 interpretation.

All values below are data in the contract and materialize into release bytes:

| Dial | Type/default | Enforcement contract |
|---|---|---|
| `negativeStock` | `reject \| allowWithFlag \| allow`; default `reject` | inside the posting transaction against serialized state, never preflight |
| `reasonRequirements` | complete posting-role map | adjustment/count/correction/re-baseline: code+narrative; transfer: code only |
| `approvalThresholds` | complete posting-role map of exact base-unit quantities or explicit no-threshold | absolute quantity comparison; precision 38, scale 18 |
| `maximumBackdateDays` | integer 0–3650; default 0 | declared temporal window; never crosses `closedThrough` |

Same-instant ordering is not a dial. One global rule sorts by ascending canonical
value order over `(effectiveAt, recordedAt, sourceType, sourceId, sourceLine,
postingRole, movementId)`. Configuration cannot replace or extend it.

## V2 decimal limit

The release records the unchanged v2 canonical-decimal pattern:

```text
^(?:0|-[1-9]\d*|[1-9]\d*)(?:\.\d*[1-9])?$
```

The movement field may declare signed precision/scale at v2, but `-0.25` does
not match that pattern and is inexpressible. The release marks signed sub-unit
values `inexpressibleUntilV3`. This packet does not widen canonical-model;
actual posting of such a value waits for the row-4b v3 adoption.

## Negative-control evidence

Each control constructs a failing candidate and observes the stable diagnostic;
none infers rejection from source text.

| Vacuity vector | Observed red |
|---|---|
| Required configuration dial absent | `INVENTORY_CONFIGURATION_REQUIRED` at `reasonRequirements` |
| Configuration value outside declared range | `INVENTORY_CONFIGURATION_OUT_OF_RANGE` for 3651 backdate days; over-scale approval quantity also rejected |
| `negativeStock` omitted from active values | compile succeeds only by reading declaration default `reject`; canonical release bytes contain `negativeStock: reject` |
| Money field added to movement declaration or ordinary movement candidate | `INVENTORY_MOVEMENT_MONEY_FORBIDDEN` |
| Movement-derived monetary artifact added | `INVENTORY_MOVEMENT_VALUE_DERIVATION_FORBIDDEN`; malformed artifact shapes fail `INVENTORY_CONTRACT_INVALID` |
| Dimension-set version absent | `INVENTORY_STOCK_DIMENSION_VERSION_REQUIRED` |
| Dimension-set version unknown | `INVENTORY_STOCK_DIMENSION_VERSION_UNKNOWN` |
| V1 `unspecified` declaration or member | `INVENTORY_STOCK_DIMENSION_UNSPECIFIED_FORBIDDEN` |
| Base unit changed after movement | `INVENTORY_BASE_UNIT_IMMUTABLE`, naming `movement-00017` |
| Undeclared posting read/append/transition added | `INVENTORY_POSTING_DEPENDENCY_UNDECLARED`; coordinated removal fails the pinned root |
| Extra or malformed configuration declaration | `INVENTORY_CONFIGURATION_MALFORMED` |

The integrated compiler suite passes 69 tests including these thirteen inventory
contract tests. Exact final full-matrix evidence is reported with the frozen
candidate SHA so this document does not change the SHA whose evidence it names.

The first full-matrix attempt at `52904a0` was honestly red in three
architecture checks: compiler hermeticity observed `localeCompare`, the press
law observed a Catalog ID in generic compiler code, and repository hygiene
observed a new standalone `*.test.ts` absent from its reviewed inventory. The
follow-up removes locale-sensitive comparison, validates the base-unit field by
generic canonical suffix rather than module identity, and imports the inventory
cases through the already-inventoried compiler conformance suite. Focused
architecture and compiler re-runs then passed 84/84 and 66/66 respectively.

An exact-SHA full-matrix run at `17bbee9` later recorded two further reds. The
untouched PostgreSQL activation test for overdue recovery observed one alarm
row instead of zero under shared suite load; the complete 15-test activation
file passed immediately in isolation, so no out-of-scope production or timing
test was changed. The subsequent aggregate run made every functional suite
green, including PostgreSQL 92/92, but executed-file reachability correctly
rejected `inventory-contract.cases.ts`: its `test()` registrations made a
non-`*.test.ts` helper look like an independently undiscovered test file. The
in-scope correction keeps the case bodies in that helper while registering
them through the already-inventoried `g2-module-conformance.test.ts` callsite.
The focused compiler suite then passed 66/66 and reachability observed all
74/74 discovered test files across nine producer artifacts. Exact final matrix
and review evidence belong to the later frozen SHA reported at checkpoint.

The first Critical-tier Codex xhigh review of `3fa216f` returned `REVISE` with
three in-scope findings: the movement-candidate seam ignored monetary extras;
the two dependency arrays could be shortened together and omitted the trust
domain-event/idempotency effects; and malformed artifact/extra-dial shapes
compiled. The correction validates the complete ordinary movement shape, pins
the independent 30-entry dependency root, adds the missing trust accesses, and
closes artifact/config declaration shapes. Any corrected SHA receives the full
matrix and a fresh review; the `3fa216f` review is not acceptance evidence.

## Gates

- `corepack pnpm install --frozen-lockfile --reporter=append-only`
- `corepack pnpm format`
- `corepack pnpm lint`
- `corepack pnpm typecheck`
- `corepack pnpm build`
- `corepack pnpm check:boundaries`
- `corepack pnpm check:schema`
- `corepack pnpm test` (all CI-invoked suites plus executed-file reachability)
- `.github/scripts/run-security-scans.sh`
- owned-path and whitespace checks against the initial base

## Test it yourself

There is no runtime surface. Compile and inspect the frozen release with one
command:

```bash
cd /home/rvham/2rain-greenfield-g3p1a

node --import tsx --input-type=module - <<'NODE'
const { default: inventory } = await import(
  './packages/domain/src/inventory/index.ts'
);
const { compileInventoryContract } = await import(
  './packages/compiler/src/conformance.ts'
);
const result = compileInventoryContract(inventory.INVENTORY_CONTRACT_V1, {});
if (result.status !== 'compiled') throw new Error(JSON.stringify(result.diagnostics));
const release = result.release;
const contract = release.release.contract;
console.log(JSON.stringify({
  releaseRoot: release.releaseRoot,
  stockTuple: contract.stockDimensionSet.dimensions,
  movement: contract.movement,
  authoritativeDependencies: contract.authoritativeDependencies.dependencies,
  configurationScope: release.release.configurationScope,
  configurationWithDefaults: release.release.configuration,
}, null, 2));
NODE
```

Expect the exact stock tuple, `quantityOnlyMovement` with no money field, all 30
dependencies, `configurationScope: "legalEntity"`, and release-recorded
`negativeStock: "reject"`. The release root must match the digest above.

## Review evidence

Critical-tier logic receives one fresh naive Codex xhigh review to PASS, then
Fable max confirmation on the identical unchanged SHA. Prompts carry the
bounded charter from `review-tiers`; exact final verdicts and SHA are reported
in the mission-cadence checkpoint because embedding them would move the object
being reviewed.

## Ledger handoff

`docs/execution/ledger.md`, `current-plan.md`, and `lanes.md` remain
orchestrator-only under the active three-lane protocol. The orchestrator must
record this packet's final SHA, full-matrix result, review verdicts, and the
G3-P1a -> G3-P1b / G3-P2 queue transition after human acceptance. This lane
does not edit those files.

## Candidate next packets

| ID | Outcome | Tier | Prerequisite | User-testable checkpoint |
|---|---|---|---|---|
| **G3-P1b (recommended)** | Freeze legal-entity family classification, derived key participation, and relation semantics | Critical | accepted `1d` plus G3-P1a | Compile the exact family map and inspect entity-aware key/relation declarations |
| **G3-P2** | Physical movement/config/period-lock persistence and per-stock serializer | Critical | accepted G3-P1a and G3-P1b; migration lease | Inspect tables/constraints and race the selected serializer without any public posting path |
| **Q1-P3b** | Lower the accepted scalar `sum` through the generic query path | Critical | accepted v3 sequence | Execute the registered aggregate needed later by G3-P5 |

Stop after this checkpoint. No next packet starts without user selection.
