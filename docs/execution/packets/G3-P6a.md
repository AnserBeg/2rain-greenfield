# G3-P6a — Mount Inventory and expose read-only views

Status: parked checkpoint; blocked on G3-P7a verification derivations

Tier: Behavioral

Branch: `packet/g3-p6a-v2`

Base: `ebea719af56aeac692390a6f872dad5e9207825f`

Rebased onto accepted G3-P6c: `8385e1357310ac9728b26ee9899d9ae8a8fa0331`

## Outcome

`composedApplicationDefinition()` now instantiates Party, Catalog, Location, and
Inventory under `northstar.app`. Inventory contributes the same canonical
collections and module definition used by its standalone contract; the builder
owns only the composed module order and package ownership.

Inventory List and Record surfaces are visible through the existing compiled
`SurfaceRuntime`. The browser journey creates a draft fixture, posts it through
`PostgresInventoryPostingService`, then reads the resulting movement and posted
transaction through the semantic query gateway. The posting service is test
setup, not a browser operation or route.

This checkpoint has already established four material facts:

- The Inventory posting suite passes 2/2 with all 34 G3-P3/G3-P4a controls
  executing, proving the repaired posting fixture composes Inventory exactly
  once instead of silently bypassing those controls.
- Compiled navigation contains four module parents and all nine active List
  leaves remain reachable through their owning module.
- The shared surface mutation guard refuses direct Inventory archive and restore
  submissions before dispatch.
- Eight structural defects were confirmed as real. Seven are repaired in this
  checkpoint; the eighth requires G3-P7a's compiler-owned executed/derived result
  partition and schema enablement before this packet can resume.

## Read-only boundary and visible incompleteness

Only Inventory surface declarations changed in
`packages/domain/src/inventory/definition.ts`:

- List retains `title` and `dataGrid`.
- Record retains `breadcrumb`, `titleStatus`, and `keyFacts`; `commandBar` is
  absent, so archive and restore are not rendered or accepted.
- The compiler still structurally requires Form declarations for the three
  mutable Inventory entities. Those declarations retain `breadcrumb`,
  `titleStatus`, and an `activity` slot whose declared
  `standard_surface_content` capability is not registered by this runtime.
  The existing closed component registry therefore renders
  `UNSUPPORTED_COMPONENT`, does not link those Forms from Lists or Records,
  renders no inputs or buttons, and refuses direct operation submissions.
- Inventory movement and period-lock entities remain without Form declarations.

No Inventory operation, posting service, entity, field, relation, compiler, or
provider declaration changed. The incomplete anatomy is intentionally visible;
G3-P6b owns the later anatomy burn-down and agent journeys.

The first candidate incorrectly introduced `SURFACE_GRAMMAR_INCOMPLETE` and
classified Forms by the presence of optional `commandBar` and `sections` slots.
Compiler-valid G2 fixtures deliberately omit one or both slots, so that test was
not a completeness authority. The correction deletes the duplicate diagnostic.
Component registration is now the single authority for both the visible
`UNSUPPORTED_COMPONENT` result and mutation refusal. Query binding and query
execution diagnostics are resolved before slots render, preserving the more
specific `QUERY_UNSUPPORTED` result when both query and component support are
absent.

The same closed registry also declares which registered slots render each
mutation intent. Rendering and submission both consult that declaration. A
Record lifecycle intent additionally requires a mutation-capable Form for the
same entity, so Inventory's unsupported Forms make archive and restore inert
even when a client posts directly around the absent controls. The browser
control submits both intents to a real posted Inventory transaction, observes
`OPERATION_UNSUPPORTED`, and then reads the transaction back unchanged.

## Navigation

The grouped surface payload contributes four compiled top-level module entries:

```text
Party
Catalog
Location
Inventory
```

The Inventory disclosure reaches these five active List surfaces:

```text
Inventory movement
Inventory period lock
Inventory transaction line
Inventory transaction
Legal entity
```

All nine composed List surfaces remain compiled navigation leaves exactly once.
At 390x844 the four module parents undergo the platform compact transformation
and remain below the binding maximum of five bottom entries; neither navigation
maximum was raised.

## Posting-fixture repair

`loadInventoryDefinition()` no longer appends Inventory to the composed
definition. It instantiates Inventory only as an expected-value oracle and
asserts that every Inventory assertion, entity, field, operation, permission,
query, relation, state machine, storage mapping, surface, and module occurs
exactly once in the composed fixture.

The G3-P3/G3-P4a controls still reach the same fixture because `buildFixture()`
continues to compile the return value of `loadInventoryDefinition()` and derive
its storage projection before every posting database setup. None of the posting
test body, control helpers, registrations, service calls, or assertions changed.
The new exact-once assertions fail before those controls if composition omits or
duplicates any Inventory construct, preventing the former manual merge from
silently bypassing them.

The real PostgreSQL posting suite passes 2/2 after the repair. All 34 G3-P3 and
G3-P4a controls execute, the exact-once assertions run before fixture creation,
and execution reaches the final timeout-leak control. That proves the repaired
fixture composes Inventory once without bypassing any posting control.

## Composed-startup defects exposed by the mount

Mounting a second module into the composed application exercised paths that no
standalone module or first-contributor fixture reached. It exposed eight real
structural defects in sequence:

1. Three fixtures manually appended Inventory after calling the now-mounted
   composed builder. Each now composes once and asserts exact collection
   cardinality before use.
2. Product assembly materialized Inventory's legal-entity master before
   provisioning the scope required by migration 0015. The provider now
   establishes that precondition before materialization; the migration refusal
   remains unchanged.
3. `abiFunctionChecks` was omitted from the additive identity strip and merge,
   so Catalog's Item and Inventory's distinct Item check conflicted. Checks now
   merge by physical name while same-name/different-body claims still fail
   `LIVE_SET_SHAPE_CONFLICT`.
4. Preparation allowed a pending constraint by one remembered element kind
   instead of the compiler's `preparationValidity` classification. Every
   `inAttemptOnly` constraint may now be absent only during preparation;
   `deferredOnlineFamily` remains separate and final verification has no
   allowance.
5. Generic verification generated `TRUE` for every boolean probe without
   consulting the compiled partial-unique constraint of its column. Fixture
   construction now selects outside that predicate; unsupported shapes and a
   fully constrained boolean domain fail closed.
6. Positive-search witness discovery treated every searchable entity as
   generically creatable. Append-only Inventory facts have search queries but
   correctly have no generic create operation, so witness selection now excludes
   those sources while retaining the missing-witness diagnostic.
7. A declared create operation was treated as constructible. Inventory
   Transaction and Inventory Transaction Line require the storage column
   `legal_entity_id`, but their operation inputs do not declare it. They are not
   selected as manufactured witnesses, and durable verification evidence reports
   `VERIFICATION_OPERATION_INPUT_UNCONSTRUCTABLE` with the exact operation and
   missing storage column instead of silently shrinking coverage.
8. The verification contract treated every compiler-emitted scenario as
   arrangeable. Of the composed product's 39 searchable-exclusion scenarios, 17
   target append-only entities with no generic create operation and 15 target
   create operations whose inputs cannot satisfy storage; only 7 are generically
   arrangeable. ADR-0020 permits the other 32 to remain unexecuted only with a
   durable, content-bound impact-analysis derivation per scenario and requires
   executed and derived counts to remain distinct. The current compiler result
   contract rejects every missing result and migration 0013 permits only `FULL`
   evidence with no derivation, so that contract/schema enablement is routed
   rather than replaced by a provider-local second authority.

All eight defects share one shape: an assumption true of Party, Catalog, and
Location was encoded as an enumeration or implication, then failed on the first
module with append-only facts and entity-owned scope. Three were literally a
list standing in for a property. The last three state the progression most
directly: searchable does not imply creatable, creatable does not imply
constructible, and emitted does not imply arrangeable. None was reachable in a
single-module test.

The PostgreSQL control observes the single legitimate active constrained row,
an archived verification probe outside the predicate, an append-only searchable
source, a constructible positive witness, the exact unconstructable-operation
findings, and durable evidence for the searchable-exclusion scenario.

Whether capability-mediated entities should declare generic create operations
at all remains an open contract question owned by a future packet. Today
verification cannot execute Inventory Transaction's generic create because its
input omits the legal-entity value required by storage. The constructibility
finding keeps that contract gap visible without teaching the generic press to
inject scope or widening Inventory's direct-write capability.

## Provenance, seeding, and the NULL-admitting CHECK (migration 0019)

Three further defects surfaced in adjudication, all in the last line of defence
rather than in the read/write path this packet added.

1. `platform.provision_inventory_scope` asserted every stored column identical,
   including `contract_release_root`. That is right for business policy and
   wrong for provenance: an already-provisioned tenant could never advance to a
   newly compiled contract. The first repair read the stored root and passed it
   back, which makes the parameter unfalsifiable — the equality it feeds can
   never disagree. Migration 0019 instead removes the column from the
   assert-identical set and UPDATEs it, so the row stays truthful by advancing.
   Policy fields gain no update path, the `'^[0-9a-f]{64}$'` format check
   stands, and `INVENTORY_POSTING_CONFIGURATION_CONFLICT` keeps its errcode and
   DETAIL. The assertion runs before the advancement, so a conflicting request
   raises with the stored provenance untouched.
2. The materializer seeded the default legal entity and the period-lock rows
   before `ENABLE ROW LEVEL SECURITY`. Because RLS is a table property, the
   first tenant's seeds slipped through and every later tenant hit 42501: the
   only INSERT policy was created for `north_star_module_runtime`. A seed INSERT
   policy for `north_star_module_materializer` now mirrors the existing narrow
   `ensureMaterializerSelectPolicy` precedent, carries the same trusted
   tenant/environment predicate, and is created only for the legal-entity master
   and the period-lock table. RLS enablement was not reordered.
3. Migration 0018's exact-partition CHECK compared
   `jsonb_typeof(impact_analysis_derivation)` without first establishing the
   column is non-NULL, so a v2 `EXACT_PARTITION` header carrying no derivation
   document evaluated to `FALSE OR NULL` and stored cleanly. The v2 arm now
   opens with `IS NOT NULL`; the v1 arm is unchanged.

## Surface-grammar debt movement

`test/architecture/surface-grammar-conformance.baseline.ts` moves Inventory from
103 to 127 in the same commit as the declaration that causes it. The whole delta
is the read-only boundary above, in two blocks:

- Seven Record surfaces dropped `commandBar`, each adding one `SG003` and one
  `SG009` violation: +14.
- Five Form surfaces traded `commandBar`/`sections` for `activity`, each losing
  one missing-`activity` violation and gaining two: +10.

No other rule, module, or surface moves. G3-P6b owns the anatomy burn-down that
takes this back down.

## Release artifact movement

| Artifact | Before packet | First mounted candidate | Corrected candidate | After G3-P6c grouping |
|---|---|---|---|---|
| `apps/web/release/app.authored.json` | `0e5103391c451bb95dbf52355a31ab41307e546f8b89280c3bb49b01957b2519` | `391a9700aa5c5c6913a955ec4ac688170144cc6bce78d3af0a1636d848168c9d` | `0709a47f22ae7c7acaf58badbd921286861eef5e2b49fa127b37ff025a1d355d` | `0709a47f22ae7c7acaf58badbd921286861eef5e2b49fa127b37ff025a1d355d` |
| `apps/web/release/app.compiled.json` | `78e24a5cae0a2e6a73fc41e239d585727f2038459f3cc3e4fb66a4c00ab60c1a` | `0c4b9f802f7d8eb13eb2700e587bde2d3c51b51f5f04de7d17bfafa45b4e8c8c` | `f9a77da493c8ed62993ee8204510125d2002178accb6388b9ffefd525e342db7` | `db9bb031f2f68e2aa3420ec34a3871b7f0e82ebc560a32375777f8837a83ddcb` |

The latest application release root moves from
`bf932f8a4a69edc23c7a62c4191e1e9cf92c9482d38fc8bcef90945461615783`
through the first mounted candidate
`19e8321d552a3d450d2f2bd53d406d215dd4f73b13c970d19264d9ae2455bc1e`
to corrected root
`4915cd2286ed092afbf159c08836cdb2b8f27b8f8778470f7bca4d1f62509ae6`.
Rebuilding after accepted G3-P6c navigation grouping moves the latest root to
`86df1a634e52cf4d8c215ce465cee20cc4f8951bfda6a85a4797402fa81a7f60`.
Earlier application lineage remains present. The diagnostic shell artifacts did
not move.

## Gates

The first rebased matrix at `feb5d103dd41d9e0afbe2f564e4d07b90802dfc1`
stopped at Integration with 56/59 passing; PostgreSQL and Browser did not run.
The corrected focused Integration suite passes 59/59. The writer handoff records
the complete matrix verdict at the later frozen correction SHA.

Focused PostgreSQL evidence before the final matrix:

- Inventory posting: 2/2, including all 34 G3-P3/G3-P4a controls.
- Additive ABI transition: 1/1, covering pending absence, approved
  installation, final catalog verification, and conflicting duplicate bytes.
- Composed startup: red at `VERIFICATION_CREATE_OPERATION_MISSING` because the
  current compiler/runtime/schema contract cannot represent 7 executed plus 32
  per-scenario derivations. The constructibility control is therefore not yet a
  completed runtime proof.

The checkpoint is intentionally committed with that known red and without a
full matrix. G3-P7a owns the blocking compiler result contract and database
schema enablement; P6a resumes its ordered gates only after that dependency
lands.

## Test it yourself

Run the focused browser journey:

```bash
corepack pnpm test:browser
```

The composed journey should show the four module parents above, with all nine
List links reachable through them, no more than five mobile entries, one real
`browser-posted-adjustment`
movement, its `ADJ-BROWSER-001` posted transaction, no Inventory New/Edit or
lifecycle controls, and a visible `UNSUPPORTED_COMPONENT` diagnostic if the
inert transaction Form URL is requested directly. Direct Form create and Record
archive/restore submissions must return `OPERATION_UNSUPPORTED` without
executing an operation.

## Recorded limits

- Inventory surface-anatomy violations remain visible and are not suppressed or
  allowlisted; G3-P6b owns their burn-down.
- G3-P6c's compiler-owned grouping keeps all required active List surfaces while
  bounding the composed projection to four top-level module entries. P6a does
  not add a browser heuristic or change either navigation maximum.
- The browser test invokes the admitted posting capability only to arrange real
  persisted read data. This packet adds no human or agent posting UI.
