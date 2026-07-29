# G3-P1b — legal-entity family map and key participation

Status: post-packet-9 review candidate; serialized integration matrix pending
Tier: Critical
Lane: FIX
Initial base: `0722ac43204331e13819f8039aaace272108b997`

## Goal and scope

Freeze the remainder of G3-P1 as a pinned inventory domain contract:

- the settled `tenantShared` / `entityOwned` family map with no default;
- compiler-derived, non-null, immutable `legal_entity_id` storage metadata for
  `entityOwned` families;
- `legal_entity_id` participation in both physical business-key enforcers;
- the settled `sameEntity` / `crossEntityAllowed` relation endpoint map; and
- storage-target payload v2 for targets containing an entity-owned family,
  while tenant-shared targets remain byte-identical v1.

This packet consumes ADR-0015, the G3 one-way-doors verdict, G3-P1a, and packet
1d's archive-excluding unique emitter. It does not add canonical syntax. The
family and relation maps are compiler-enforced pinned contracts over existing
canonical entity and relation endpoints.

Owned and granted paths are the inventory contract, compiler conformance and
storage/projection paths, the storage protocol v2 declaration, the narrowly
split compiler payload-family recognizer, the two granted compiler test
artifacts, and this record. It does not touch canonical-model, the existing
Party/Catalog/Location/Platform definitions, provider materialization,
migrations, posting, queries, operations, applications, or release artifacts.

## Frozen legal-entity contract

### Family classification

| Family | Classification |
|---|---|
| `legal_entity` | `tenantShared` |
| `party` | `tenantShared` |
| `party_role` | `tenantShared` |
| `item` | `tenantShared` |
| `location` | `tenantShared` |
| `inventory_movement` | `entityOwned` |
| `inventory_transaction` | `entityOwned` |
| `inventory_transaction_line` | `entityOwned` |
| `reservation` | `entityOwned` |
| `stock_count` | `entityOwned` |
| `stock_count_line` | `entityOwned` |

An unknown family in a governed Catalog, Inventory, Location, or Party package
fails compilation with `INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED`. There is no
fallback classification. Families outside this G3 contract remain outside it
until the G6 generalization; that is not a hidden `tenantShared` default.

### Relation semantics

| Source | Target | Semantics |
|---|---|---|
| `inventory_movement` | `location` | `sameEntity` |
| `inventory_movement` | `inventory_transaction` | `sameEntity` |
| `inventory_movement` | `item` | `crossEntityAllowed` |
| `party_role` | `party` | `crossEntityAllowed` |

The compiler derives the endpoint pair from the canonical
`sourceEntity`/`targetEntity` references. A pair involving this pinned contract
that is absent from the table fails
`INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED`; no permissive relation default
exists. The exact table is also part of
`northstar.legal-entity-family-contract/v1` and the content-addressed inventory
contract release.

### Derived storage and key participation

An `entityOwned` target carries compiler-owned `legal_entity_id` metadata:
`uuid`, non-null, immutable after create, and referencing the `legal_entity`
family. The ABI-frozen primary key, tenant/environment service scope, RLS
template, and relation-index prefixes remain unchanged. Business keys instead
lower as:

```text
UNIQUE (tenant_id, environment_id, legal_entity_id, folded_key)
  WHERE archived_at IS NULL
```

Both packet 1d physical enforcers use that same column vector: the semantic
unique key and the `caseInsensitiveUnique` index. A `tenantShared` target emits
no legal-entity metadata and retains tenant/environment business-key scope.

### Payload evolution

`northstar.storage-target-payload/v2` is emitted only when a target contains an
entity-owned family. The emitted payload, release-manifest projection reference,
and projection-manifest envelope all carry the same version. The compiler
recognizes v1 and v2 as the managed storage-target structural family for
physical-mapping validation, completeness, and storage transitions; without
that recognition v2 falls into the incompatible legacy `fields` shape.

Tenant-shared targets continue to emit v1. `check:app-release` and
`check:demo-release` pass without regenerating any artifact, proving the current
Party/Catalog/Location composed outputs did not move merely because v2 now
exists.

## Deliberate deferrals

A canonical per-entity classification field and canonical per-relation
cross-entity flag remain the eventual shape when a non-inventory module needs
author-controlled declarations, expected in G6. Adding those spellings now
would move every existing module's canonical bytes for a distinction no current
author needs to express. This follows ADR-0021's deferred comparison spellings
and packet 1d's deferred per-key archive option: semantics are ruled now;
serialized syntax is paid for when exercised.

Provider DDL, the non-null and legal-entity-master foreign key, write-time
relation enforcement, operation-input resolution, and query exposure remain
G3-P2 work. This packet freezes the compiler target they consume; it does not
silently implement a partial provider path.

## Artifact and canonical-byte accounting

- Existing Party, Catalog, Location, Platform, application, and shell canonical
  sources/artifacts are untouched. The focused release checks pass against the
  checked-in bytes without regeneration.
- The separately versioned inventory contract release moves because the family
  and relation maps are now part of that contract:
  `f653a6365199f02186832bdab4e55e6009ba914a41fe2a6b3bb9c21e5c8579d5`
  -> `c65517349623a30f3ddce75e57dca0af404646e82f27e73ce0b6586b4c1d17fb`.
- No canonical-language byte moves. No application release root moves. If a
  later product-code advance reaches `main` before this packet's matrix slot,
  the candidate is re-integrated and all SHA-bound evidence is repeated.

## Executed negative controls

Each fault was injected into production code, the named focused test was run,
and the fault was restored before the green run.

| Vacuity vector | Injected regression | Observed red |
|---|---|---|
| Family ownership silently defaults | Returned `tenantShared` for an unknown governed family | Expected `INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED` for `northstar.party:entity.undeclared_role`; actual diagnostic list was `[]` |
| Relation semantics silently defaults | Returned `crossEntityAllowed` for an absent endpoint pair | Expected compile status `failed`; actual status was `compiled` |
| Derived column is absent or classification is inverted | Treated `tenantShared` as the entity-owned branch | Expected exact `legal_entity_id` target; actual was `undefined` |
| Semantic business key omits entity | Restored the old tenant/environment-only semantic unique columns | Expected third column `legal_entity_id`; actual third column was the physical business-key column |
| Second physical enforcer omits entity | Restored tenant/environment-only columns only on `caseInsensitiveUnique` | Expected both enforcers to include `legal_entity_id`; the index vector omitted it while the semantic vector retained it |
| Manifest advertises stale v1 | Hard-coded the projection plan's schema version to v1 while the payload emitted v2 | Expected `northstar.storage-target-payload/v2`; manifest reference reported v1 |
| Tenant-shared bytes move speculatively | Forced every non-empty target to v2 | Expected tenant-shared v1; actual was v2 |
| Compiler does not admit the v2 managed family | Removed v2 from the compiler's managed-target recognizer | Compilation crashed in the legacy branch with `TypeError: entity.fields is not iterable` at `collectStorageFields` |

These controls separately observe the no-default decisions, both physical key
paths, the cross-layer manifest agreement, the v1 preservation constraint, and
the compiler-family bridge that prevents a latent legacy-shape mismatch.

Exact failure excerpts, in the table's order:

1. Governed-family fallback:

   ```text
   Expected values to be strictly deep-equal:
   + actual - expected

   + []
   - [
   -   {
   -     code: 'INVENTORY_LEGAL_ENTITY_FAMILY_UNDECLARED',
   -     path: '$.entities.entityId',
   -     subjectId: 'northstar.party:entity.undeclared_role'
   -   }
   - ]
   ```

2. Relation fallback:

   ```text
   Expected values to be strictly equal:
   + actual - expected

   + 'compiled'
   - 'failed'
   ```

3. Missing derived column:

   ```text
   Expected values to be strictly deep-equal:
   + actual - expected

   + undefined
   - {
   -   column: 'legal_entity_id',
   -   familyClassification: 'entityOwned',
   -   immutableAfterCreate: true,
   -   nullable: false,
   -   postgresqlType: 'uuid',
   -   referencedFamilyId: 'legal_entity'
   - }
   ```

4. Semantic unique key without entity participation:

   ```text
   Expected values to be strictly deep-equal:
   + actual - expected

     [
       'tenant_id',
       'environment_id',
   +   'nsm_c_gdlzi3mw5bv2flq4acmlvtovk23irtoky4yqcijkzecqqlqoflvq'
   -   'legal_entity_id'
     ]
   ```

5. Case-insensitive physical index without entity participation:

   ```text
   Expected values to be strictly deep-equal:
   + actual - expected

     [
       'tenant_id',
       'environment_id',
   -   'legal_entity_id',
       'nsm_c_gdlzi3mw5bv2flq4acmlvtovk23irtoky4yqcijkzecqqlqoflvq'
     ]
   ```

6. Stale manifest version:

   ```text
   Expected values to be strictly equal:
   + actual - expected

   + 'northstar.storage-target-payload/v1'
   - 'northstar.storage-target-payload/v2'
                                        ^
   ```

7. Tenant-shared target forced to v2:

   ```text
   Expected values to be strictly equal:
   + actual - expected

   + 'northstar.storage-target-payload/v2'
   - 'northstar.storage-target-payload/v1'
                                        ^
   ```

8. Compiler v2 recognizer removed:

   ```text
   error: 'entity.fields is not iterable'
   code: 'ERR_TEST_FAILURE'
   name: 'TypeError'
   stack: |-
     collectStorageFields (/tmp/2rain-greenfield-g3-p1b/packages/compiler/src/compiler.ts:1778:32)
     verifyCompleteness (/tmp/2rain-greenfield-g3-p1b/packages/compiler/src/compiler.ts:1492:11)
     compileApplication (/tmp/2rain-greenfield-g3-p1b/packages/compiler/src/compiler.ts:297:35)
   ```

## Gate evidence

Focused development evidence on the authored tree:

- `corepack pnpm typecheck` — PASS.
- `corepack pnpm format` — PASS.
- `corepack pnpm lint` — PASS after one development red:
  `@typescript-eslint/no-unused-vars` identified a stale local `reference` in
  the refactored test artifact reader; removing that unused binding made the
  unchanged assertion path lint-clean.
- `corepack pnpm build` — PASS.
- compiler conformance/storage focused run — PASS, 49/49.
- `corepack pnpm check:app-release` — PASS without regeneration.
- `corepack pnpm check:demo-release` — PASS without regeneration.
- `corepack pnpm check:boundaries` — PASS, 131 files scanned.
- `git diff --check` — PASS.

Accepted `main` through `8a2d320` was merged without conflict. This brings in
packet 9's publish-path breadth test/inventory and the orchestrator's lease
records; none overlaps G3-P1b's implementation or assertions. The resulting
merge was `fbc139e9323550d92c205b328f6855d83215d222`; the review candidate adds
only this completed evidence record on top.

The full serialized CI matrix has not started. KERNEL 4c still holds that slot;
starting another matrix would invalidate both lanes' evidence. Partial
clearance freezes and reviews this post-packet-9 candidate now. Once the slot is
released, the full matrix runs once at the unchanged reviewed SHA. If `main`
instead advances with product code first, lanes.md requires a new integration
SHA, repeated byte comparison and matrix, and fresh SHA-bound reviews.

## Test it yourself

Run the four focused observations (under two minutes on the packet worktree):

```bash
cd /tmp/2rain-greenfield-g3-p1b

node --import tsx --test \
  --test-name-pattern="legal-entity families|canonical relation endpoints|pinned family ownership|storage-target payload versions" \
  test/compiler/g2-module-conformance.test.ts \
  test/compiler/g2-module-storage.test.ts
```

Expect four passing tests. They show the exact family/relation tables and typed
unknown-family/relation failures; the entity-owned column plus both key
enforcers; tenant-shared absence; payload v2 for entity-owned storage; payload
v1 for tenant-shared storage; and agreement between payload, projection
manifest, and release manifest.

Then inspect
`test/compiler/inventory-contract.release.golden.json`: all eleven family rules,
all four relation rules, and both observed storage-target versions must be
present.

## Review, ledger, and checkpoint

Under the orchestrator's partial clearance, Critical review begins before the
serialized full-matrix slot is available. The frozen SHA receives one fresh
naive Codex xhigh review to PASS and Fable max confirmation on the identical
unchanged SHA. Any correction invalidates both and produces a new candidate.
The full matrix remains mandatory at that same SHA before acceptance.

`docs/execution/ledger.md`, `current-plan.md`, and `lanes.md` remain
orchestrator-only. At acceptance the orchestrator records the final SHA, full
matrix, review verdicts, the single inventory-contract root movement above, and
the G3-P1b -> G3-P2 sequencing transition.

No next packet starts from this lane before the human checkpoint.
