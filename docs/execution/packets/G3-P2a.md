# G3-P2a — the tenant-completeness manifest

Status: evidence ready; human checkpoint pending
Tier: Critical
Lane: BUILD
Initial base: `7ee8dba4790ae9a4143a2269498f953fa425345f`

## Goal and scope

Freeze ADR-0019's tenant-completeness manifest before G3 adds more physical
tables. Every current table in every non-system plane resolves exactly once to
either a tenant-scoped classification naming its trusted tenant identifier or a
tenant-independent classification with a reviewed, non-tautological reason.
The verifier fails closed on zero input, unknown relation kinds, duplicate or
stale classifications, unclassified tables, invalid tenant columns, and a
business or tenant-bearing table declared independent.

This packet adds declarations and verification only. It creates no migration,
table, export operation, erasure behavior, movement storage, or legal-entity
provisioning. `db/schema.snapshot.json` was read and not changed. No domain,
canonical-model, compiler, migration, or PostgreSQL-provider source file moved.

## Enumeration and closure

The verifier first discovers every non-system schema from `pg_namespace`, then
passes that complete schema set to ADR-0011's existing versioned
`captureSchemaSnapshot` catalog walk. It derives tables and columns from that
result; it issues no tenancy-specific `pg_class` table enumeration and carries
no production table-name list. This includes `north_star_internal`, `platform`,
the currently empty `north_star_module` table plane, `public`, and any future
non-system schema.

The checked manifest is the reviewed classification artifact. The live walk is
the authority for what exists. Consequently:

- a new table has no default classification and is red;
- a new schema does not evade the gate;
- a managed-module table cannot be declared tenant-independent, and its named
  tenant column must exist as a required UUID;
- an entry matching no live table is stale and red; and
- each physical partition or foreign table is a table and needs its own entry.

## Meaning of tenant-independent

V1 defines tenant-independent narrowly:

> A table is tenant-independent only when its rows represent a database-wide
> kernel mechanism or immutable content deliberately shared across tenants;
> business records are never tenant-independent, and absence of a tenant column
> is not evidence.

Governed reason codes are migration history, kernel integrity witness, shared
immutable catalog, and shared immutable content. A free-text reason must explain
the database-wide mechanism or shared identity; “no tenant column” and equivalent
restatements fail. Any table in `north_star_module`, any table carrying
`tenant_id`, and `platform.tenants` cannot be declared independent.

`platform.tenants` is tenant-scoped by its required UUID `id`, because that row
is the root tenant identity. Every other current scoped table uses a required
UUID `tenant_id`. A different UUID field such as `environment_id` cannot be
substituted as the tenant authority.

## Honest count and full classification

The current checked schema contains **49 tables: 42 tenant-scoped and 7
tenant-independent**. The packet input's count of 45 was accurate immediately
before accepted commit `dc39ec7`; that commit added
`platform.saved_master_filters`. While this packet ran, accepted 1b migration
0013 added `platform.release_verification_evidence`,
`platform.release_verification_results`, and
`platform.tenant_release_admissions`. The integrated snapshot therefore has
four more tables than the prompt's baseline. All 49 current relations have
PostgreSQL kind `r`; the verifier also defines fail-closed treatment for
partitioned and foreign tables when they appear.

| Table | Classification | Tenant column or independent reason |
|---|---|---|
| `north_star_internal.module_fold_function_ddl_witnesses` | tenant-independent | kernel integrity witness: pins the database-wide Unicode fold-function definition used to detect materializer DDL drift |
| `north_star_internal.module_storage_attempt_claims` | tenant-scoped | `tenant_id` |
| `north_star_internal.module_storage_backfill_checkpoints` | tenant-scoped | `tenant_id` |
| `north_star_internal.module_storage_catalog_receipts` | tenant-scoped | `tenant_id` |
| `north_star_internal.module_storage_element_applications` | tenant-scoped | `tenant_id` |
| `north_star_internal.module_storage_elements` | tenant-independent | shared immutable catalog: physical-shape definitions are shared across tenant generations; tenant reachability lives in root membership |
| `north_star_internal.module_storage_generations` | tenant-scoped | `tenant_id` |
| `north_star_internal.module_storage_reference_counts` | tenant-scoped | `tenant_id` |
| `north_star_internal.module_storage_root_membership` | tenant-scoped | `tenant_id` |
| `north_star_internal.module_storage_tightening_debt` | tenant-scoped | `tenant_id` |
| `north_star_internal.schema_migrations` | tenant-independent | migration history: ordered migrations applied to the database as a whole |
| `platform.active_release_pointers` | tenant-scoped | `tenant_id` |
| `platform.app_package_revisions` | tenant-scoped | `tenant_id` |
| `platform.environments` | tenant-scoped | `tenant_id` |
| `platform.immutable_release_write_guard` | tenant-independent | kernel integrity witness: always-rejecting release immutability target that cannot retain rows |
| `platform.release_activation_attempt_outcomes` | tenant-scoped | `tenant_id` |
| `platform.release_activation_attempts` | tenant-scoped | `tenant_id` |
| `platform.release_activation_authority_epochs` | tenant-scoped | `tenant_id` |
| `platform.release_activation_control_events` | tenant-scoped | `tenant_id` |
| `platform.release_activation_history` | tenant-scoped | `tenant_id` |
| `platform.release_activation_outbox` | tenant-scoped | `tenant_id` |
| `platform.release_activation_phase_receipts` | tenant-scoped | `tenant_id` |
| `platform.release_activation_preparations` | tenant-scoped | `tenant_id` |
| `platform.release_activation_reconciliation_alarms` | tenant-scoped | `tenant_id` |
| `platform.release_activation_reconciliation_starts` | tenant-scoped | `tenant_id` |
| `platform.release_activation_swap_receipts` | tenant-scoped | `tenant_id` |
| `platform.release_activation_verification_receipts` | tenant-scoped | `tenant_id` |
| `platform.release_activation_write_guard` | tenant-independent | kernel integrity witness: always-rejecting activation append-only target that cannot retain rows |
| `platform.release_approvals` | tenant-scoped | `tenant_id` |
| `platform.release_approver_eligibility_events` | tenant-scoped | `tenant_id` |
| `platform.release_artifact_blobs` | tenant-independent | shared immutable content: content-addressed canonical bytes are shared; tenant reachability lives in tenant-release links |
| `platform.release_executor_authority_events` | tenant-scoped | `tenant_id` |
| `platform.release_verification_evidence` | tenant-scoped | `tenant_id` |
| `platform.release_verification_results` | tenant-scoped | `tenant_id` |
| `platform.saved_master_filters` | tenant-scoped | `tenant_id` |
| `platform.semantic_operation_receipts` | tenant-scoped | `tenant_id` |
| `platform.tenant_fixture_records` | tenant-scoped | `tenant_id` |
| `platform.tenant_release_admissions` | tenant-scoped | `tenant_id` |
| `platform.tenant_release_artifact_links` | tenant-scoped | `tenant_id` |
| `platform.tenant_release_chunk_links` | tenant-scoped | `tenant_id` |
| `platform.tenant_release_projection_links` | tenant-scoped | `tenant_id` |
| `platform.tenant_releases` | tenant-scoped | `tenant_id` |
| `platform.tenants` | tenant-scoped | `id` |
| `platform.transition_preparation_receipts` | tenant-scoped | `tenant_id` |
| `platform.trust_action_invocations` | tenant-scoped | `tenant_id` |
| `platform.trust_business_change_documents` | tenant-scoped | `tenant_id` |
| `platform.trust_domain_events` | tenant-scoped | `tenant_id` |
| `platform.trust_immutable_write_guard` | tenant-independent | kernel integrity witness: always-rejecting trust immutability target that cannot retain rows |
| `platform.trust_outbox` | tenant-scoped | `tenant_id` |

## Executed reds and anti-vacuity evidence

These diagnostics were emitted by the real verifier during the passing focused
architecture run. The first two table probes were actual DDL in disposable
PostgreSQL, followed by a fresh ADR-0011 snapshot walk; neither table was
inserted into a verifier fixture list.

| Vacuity vector | Deliberately executed case | Real output |
|---|---|---|
| An unclassified table is ignored | create `platform.g3_p2a_unclassified_probe` after migrations | `TENANT_TABLE_UNCLASSIFIED: platform.g3_p2a_unclassified_probe has no tenant-completeness classification` |
| A concurrently integrated migration silently widens the schema | merge accepted 1b migration 0013 before updating this manifest | `TENANT_TABLE_UNCLASSIFIED: platform.release_verification_evidence has no tenant-completeness classification` |
| Enumeration is bounded by known schemas or a hand list | create schema `g3_p2a_unlisted_plane` and table `shadow_business_records` | `TENANT_TABLE_UNCLASSIFIED: g3_p2a_unlisted_plane.shadow_business_records has no tenant-completeness classification` |
| A business table can claim independence | replace `platform.tenant_fixture_records` with a shared-catalog declaration | `TENANT_INDEPENDENT_BUSINESS_TABLE: platform.tenant_fixture_records is a business or tenant-bearing table and cannot be tenant-independent` |
| A scoped declaration need not name a real column | name `missing_tenant_id` on `platform.saved_master_filters` | `TENANT_COLUMN_MISSING: platform.saved_master_filters names missing tenant column missing_tenant_id` |
| “No tenant column” passes as a reason | replace the migration-history reason with that restatement | `TENANT_INDEPENDENT_REASON_INVALID: tables[10].reason must explain the platform-wide mechanism or shared immutable identity; absence of a tenant column is not a reason` |
| More than one classification still resolves | append a second classification for the fold witness | `TENANT_CLASSIFICATION_DUPLICATE: north_star_internal.module_fold_function_ddl_witnesses has more than one tenancy classification` |
| Zero input passes vacuously | verify the manifest against no tables | `TENANT_ENUMERATION_EMPTY: cannot verify tenant completeness against zero tables` |
| An unknown enumerated kind is silently skipped | replace one observed relation kind with `?` | `TENANT_ENUMERATION_OBJECT_KIND_UNKNOWN: unknown relation kind ? for north_star_internal.module_fold_function_ddl_witnesses` |
| A removed table leaves an accepted stale declaration | add a classification for absent `platform.removed_business_records` | `TENANT_CLASSIFICATION_STALE: platform.removed_business_records is classified but was not enumerated` |
| Any required UUID can impersonate tenant authority | name the real `environment_id` UUID on `platform.saved_master_filters` | `TENANT_COLUMN_INVALID: platform.saved_master_filters.environment_id must be a required uuid trusted tenant identifier` |
| Tenant column nullability is not checked | make the observed `tenant_id` nullable | `nullable: TENANT_COLUMN_INVALID: platform.saved_master_filters.tenant_id must be a required uuid trusted tenant identifier` |
| Tenant column type is not checked | make the observed `tenant_id` text | `non-uuid: TENANT_COLUMN_INVALID: platform.saved_master_filters.tenant_id must be a required uuid trusted tenant identifier` |
| Partitioned tables disappear from closure | add an unclassified `relkind=p` relation | `TENANT_TABLE_UNCLASSIFIED: g3_p2a_relation_kinds.unclassified_partitioned_records has no tenant-completeness classification` |
| Foreign tables disappear from closure | add an unclassified `relkind=f` relation | `TENANT_TABLE_UNCLASSIFIED: g3_p2a_relation_kinds.unclassified_foreign_records has no tenant-completeness classification` |
| Managed-module business data can claim independence when its tenant column is missing | classify `north_star_module.managed_business_records` as a shared catalog | `TENANT_INDEPENDENT_BUSINESS_TABLE: north_star_module.managed_business_records is a business or tenant-bearing table and cannot be tenant-independent` |
| The tenant registry can claim independence because its tenant column is named `id` | classify `platform.tenants` as a shared catalog | `TENANT_INDEPENDENT_BUSINESS_TABLE: platform.tenants is a business or tenant-bearing table and cannot be tenant-independent` |

Positive count evidence observes 49 live migrated tables before either DDL
probe, equal to the 49-entry checked manifest. The checked-snapshot listing
independently reports the same 42/7 split.

## Gates

- `corepack pnpm install --frozen-lockfile --reporter=append-only`
- `corepack pnpm format`
- `corepack pnpm lint`
- `corepack pnpm typecheck`
- `corepack pnpm build`
- `corepack pnpm check:boundaries`
- `corepack pnpm check:schema`
- `corepack pnpm test` with the PostgreSQL suite serialized and no overlapping
  lane matrix
- `.github/scripts/run-security-scans.sh`
- owned-path and whitespace checks against the initial base

Focused evidence before the frozen candidate:

- tenant-completeness test: 7/7 PASS, including live PostgreSQL enumeration;
- complete architecture suite: PASS with the final controls;
- architecture boundaries: PASS;
- typecheck and lint: PASS; and
- the deliberate user-facing unclassified-table command exits 1 with
  `TENANT_TABLE_UNCLASSIFIED`.

Two infrastructure reds occurred on the superseded pre-integration candidate
`692d997` and were reported rather than hidden. The first PostgreSQL invocation
used an unsupported direct Node flag and exited 7 with
`Filtered or unrecognized node:test argument: --test-concurrency=1`; the
unchanged package suite was then constrained to one available CPU and passed
92/92. The first browser invocation passed 16/17 but its Catalog fixture timed
out while reaching an ephemeral PostgreSQL endpoint; the unchanged candidate's
retry passed 17/17. Accepted 1b subsequently integrated the repository's
serial-test and readiness fixes, as well as three new tables, so all evidence
for `692d997` is historical rather than final-candidate evidence.

Exact final full-matrix and review evidence is reported with the frozen
candidate SHA so this document does not change the SHA whose evidence it names.
This packet changes no canonical bytes, compiled release artifact, golden root,
or release digest.

## Review evidence

The first fresh Critical-tier Codex xhigh review of `fb135d1` returned
`REVISE` with two in-scope findings. It found that the implementation's stale,
untrusted-column, partitioned/foreign, managed-module, and tenant-root branches
were not all directly exercised, and that the packet record attributed the
last focused test to an earlier complete-suite run. The successor adds direct
controls for each named branch, records their emitted diagnostics above, and
corrects the gate chronology. Fresh Codex xhigh and Fable max reviews both
passed successor `692d997`, but accepted 1b then changed the integrated schema.
Those verdicts are therefore invalidated. Any final successor SHA receives the
entire fresh review chain; no earlier verdict is acceptance evidence.

## Test it yourself

There is no runtime surface. Read the checked manifest and verifier, then list
all 49 classifications:

```bash
cd /home/rvham/2rain-greenfield-g3p2a
node --import tsx packages/dev-tooling/src/check-tenant-completeness.ts --list
```

Expected first line:

```text
tenant-completeness: PASS (49 tables; 42 tenant-scoped; 7 tenant-independent)
```

Then create a real unclassified table in disposable PostgreSQL and observe the
gate fail (the command intentionally exits 1 and removes its container):

```bash
node --import tsx test/architecture/tenant-completeness-negative-control.ts
```

Expected output:

```text
TENANT_TABLE_UNCLASSIFIED: platform.g3_p2a_unclassified_probe has no tenant-completeness classification
```

## What G3-P2b still owes

Once DEPLOY `1b` releases migrations and G3-P1b supplies the legal-entity
master, G3-P2b still owns every other Freeze K obligation: header/line and
quantity-only movement tables; legal-entity provisioning and references;
dimension-set version persistence; tenant calendar, configuration, and
per-entity period-lock storage; the base-unit binding lookup; tenant-business-
period partitioning; the natural effect key; the selected per-stock serializer
and bounded concurrency proof; no-update/no-delete authority; and the provider
and migration evidence. It also still owes G3-P0's two-tenant extract probe at
a stated recorded-time horizon over the physical schema. That probe is evidence
for completeness; the durable tenant export operation itself remains downstream
export/recovery work. G3-P2a supplies the complete table map, not either data
operation.

## Program-review trigger and next packets

The program-review trigger is not due at this checkpoint. This packet adds a
structural manifest and fail-closed verifier inside an already accepted tenancy
and recovery decision; it does not introduce a new end-to-end slice, change the
north-star approach, or accumulate cross-layer drift.

Candidate next packets remain dependency-driven:

1. `G3-P1b` after `1d`, to freeze the legal-entity family map and relation
   semantics.
2. `G3-P2b` after accepted `1b` and `G3-P1b`, to finish Freeze K.

No next packet starts without user selection.
