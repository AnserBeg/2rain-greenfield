# DROP-SHIP-RELATION-INSTALL — proposed Critical dependency

Status: proposed only; not selected or implemented. Blocks DROP-SHIP's linked sales/purchase lines and every install-dependent gate.

## Observed failure

The exact PAYABLES base plus one DROP-SHIP release compiles, but
`node scripts/run-with-test-lock.mjs exclusive -- node --import tsx test/helpers/generate-fresh-tenant-full-replay-schema.ts`
fails while preparing the DROP-SHIP storage transition:
`ModuleStorageMaterializationError`, `ELEMENT_TARGET_MISSING`, element
`2b828dfa413110397acdb317c4b248284eaf27fd67ec312fdafa9fa630f06660`.
This is the `addColumn` for `northstar.app:relation.purchase_order_line_sales_line`.

`module-storage-materializer.ts`'s `applyDdlElement` handles an added folded column or calls `locateColumn`, which searches only `entity.columns`. A relation-backed column lives in `storage.relations[].relationColumn`, so it cannot be located. The reverse sales-to-purchase reference has the same exposure.

## Bounded proposed packet

- Tier: Critical, because installing writable columns on existing company-owned tables must preserve the column-level grant contract.
- Own only relation-column preparation/materialization and its grant admission plus focused transition/provider tests and this dependency's evidence. No stock movement, posting trigger, serializer or delivery business-rule change.
- Resolve relation-backed `addColumn` targets from the pinned storage target; preserve company/environment scope, inert nullable preparation and deterministic names.
- Observe persisted column, foreign-key/index and privilege effects through a real PostgreSQL base-to-head transition, including a governed write. Do not infer permission from a declaration or broaden table grants.
- Negative controls: relation target missing, foreign-company target, and the required per-column write grant absent. The selected Critical packet gets its own fresh review arm.
- Re-run the exact DROP-SHIP full replay, regenerate its schema snapshot, then its delivery/browser tests and full CI. Rebuild one release entry from the accepted updated base; do not raise readiness or time bounds.

## Safe alternatives checked

A company-owned intermediary link record with no public mutation surface was normalized, then refused by mandatory compiler conformance (create/update/archive/restore, Form/List/Record and executable verification). That experiment was removed. No conformance requirement was weakened, no unsupported metadata was retained, and no unreviewed grant change was made.

DROP-SHIP retains its canonical bidirectional order-line references and unfinished implementation until this dependency is admitted. Do not merge or deploy it.
