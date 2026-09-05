# The posting kernel — what it guarantees, where, and why

Written 2026-09-05 by the orchestrator from the tree at `65d9222`, every line verified at
the symbol named. **Read this instead of the records.** A record is cited only
where the reason for a guarantee lives there. Keep this under sixty lines; edit
it in the same commit as any change to a guarantee.

| guarantee | where | why |
|---|---|---|
| Every posting family runs through ONE `#post` in `PostgresInventoryPostingService` (`packages/postgres-provider/src/inventory-posting-service.ts`); execution is selected by the compiled family binding keyed `(capabilityId, familyId)` | `#post`, `resolvePostingFamilies` | ADR-0060: a family declares whether the kernel writes its companion transaction; three design passes that built receipt first were refuted by stock count (plan §7.16) |
| Stock-identity locks are taken first after `BEGIN`, in canonical order, then the request-key lock, then source row locks, then the period lock | `acquireStockIdentityLocks`, `stock-serializer.ts`, `enforcePeriodLock` | ADR-0026/0027: no cycle is possible when every writer takes advisory keys ascending then row locks ascending; proven under a real `40P01` |
| Negative stock is refused INSIDE the transaction against serialized state, for every family including reversal, never by preflight | `enforceNegativeStock` (persisted + planned movements sorted by `compareInventoryMovementOrderEntries`) | ADR-0016 dials; `negativeStock` default `reject`; a preflight races |
| Same-instant order is the frozen seven-key tuple `(effectiveAt, recordedAt, sourceType, sourceId, sourceLine, postingRole, movementId)` | `INVENTORY_CONTRACT_V1.sameInstantTieBreak`, `compareInventoryMovementOrderEntries` | one-way door V4 (`debates/g3-one-way-doors-verdict.md`); controls in `test/evidence/posting-kernel-admission.expected-red.json` |
| `recordedAt` never steps backward per stock identity: the sampled instant must be ≥ the max persisted `recordedAt` for the affected identities | the floor in `enforceNegativeStock` (`posting-kernel-admission`) | WSL steps its clock back ~2s; a backward step let an as-of read return a negative balance the kernel never admitted (`5g3-prog` A3) |
| Duplicate delivery cannot double-post: replay is decided by the receipt digest (v2 authored families, v4 stock count) and by the natural-effect reservation; a raced duplicate is refused with `23505` | `currentCommandDigest`, `digestCommand`, `findNaturalReplay`, `validateReceiptReplay`, `assertMovementEffectReservations` | ADR-0063: a digest covers exactly the caller's input; the reservation companion's primary key is the only thing that reserves a natural effect (ADR-0062) |
| Every relation a posting writes is read back column-for-column before commit, and the executed verifier set equals the observed write set (`pg_stat_xact_user_tables`) | `validateWriterInventory`, `assertObservedWriteSetIsDerived`, the executed-token comparison | ADR-0062: the writer inventory is derived from the compiled target; nine PUR-2a rounds found one unobserved column each until this became a class-level proof |
| Facts are append-only: movements carry a `BEFORE UPDATE OR DELETE` refusing trigger; `DELETE`/`TRUNCATE` are revoked from runtime and materializer roles | migration `0015`, `module-storage-materializer.ts` grants | ADR-0007 |
| `posted_stock_balance` is a provider-written, rebuildable transaction-snapshot projection: an `AFTER INSERT` trigger on the movement table maintains it; the posting refuses to commit unless the row equals `sum(quantity_delta)` recomputed in the same transaction | `ensurePostedStockBalanceTrigger`, `capturePostedStockBalances`, `assertPostedStockBalancesReconcile` | ADR-0057 and its 2026-09-01 amendment; ADR-0018 own-horizon column deferred to SALE |
| **Known gap:** reconciliation (`reconcile`) has no production caller and the rebuild in `ensurePostedStockBalanceProjection` runs on every storage transition without comparing first | `inventory-reconciliation-service.ts`, `rebuildPostedStockBalanceOnClient` | `5g3-prog` A1; RECEIPT's first slice closes it |
| One capability-version authority: the frozen contract in `packages/domain/src/inventory/contracts.ts`; the provider imports it; a release whose declared fact mismatches is refused before any posting path returns | `INVENTORY_POSTING_CAPABILITY_VERSION`, `validateRegistration`, the release-fact check | `posting-kernel-admission` R1; three encodings had drifted 1/2 silently |
| Backdating is bounded one-sidedly; forward dating is unbounded | `enforceBackdate`; `test/postgres/inventory-backdate-policy.test.ts` | unruled in the plan; RECEIPT rules a `maximumForwardDateDays` dial (`5g3-prog` A4) |
| Posting into a closed period is refused inside the transaction; the period lock has its own advance/reopen operations | `enforcePeriodLock`, `inventory_period_lock` | ADR-0018 |
| No movement carries a monetary amount; receipt lines capture actual cost as an immutable fact or explicit absence | compiler `monetaryBoundary` cells in `conformance.ts` | ADR-0017 |
| Received quantity is a provider-written rebuildable read model in the `posted_stock_balance` shape, one row per order line; over-receipt is refused inside `#post` on the order line as the serialization unit; open-to-receive is derived, never stored | not built yet — RECEIPT builds it | ADR-0065, ten named claims |
| The base unit of an item is immutable once any movement references it | migration `0015` `inventory_base_unit_change_allowed` | ADR-0016 |
| Every posting writes trust rows (audit, change, outbox, semantic receipt) in the same transaction; these are NOT yet column-verified | `platform-runtime/src/trust/` | filed: `posting-platform-plane-writes-not-row-complete` |

**One-way doors already closed** (do not reopen): legal-entity family classification
with no default; the stock tuple `(legalEntity, item, location)` with a versioned
dimension set; `reject` negative stock evaluated in-transaction; serialization at
first posting; movements never carry money; distinct effective and recorded time.

**Pre-tenant mode** (ADR-0066): a refused storage transition on the first-party
application is a lineage re-baseline, not a transition element.
