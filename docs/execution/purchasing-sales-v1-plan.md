# Purchasing and sales — the v1 charter, and what it rests on

**Status: proposed, unreviewed. Written 2026-08-08.**

The goal in the user's words: *an office worker can receive inventory and send it
out.* This document charters that as four packets and records what each one rests
on, so the plan can be judged before it is built rather than after.

**It is deliberately written to be refutable.** §5 lists the assumptions that would
sink it.

---

## 1. What the program plan already specifies

`docs/greenfield-north-star-erp-platform-plan.md` gives a matched inbound/outbound
pair and nothing else:

- **In:** purchase order + lines → goods receipt + lines → positive movements
- **Out:** sales order + lines → reservation → shipment + lines → negative movements

Entity shapes at **§1276–1282**, lifecycles at **§1372–1378**
(`draft → released → closed`, `cancelled` from draft), operations at
**§1418–1427**.

**Two gaps in the source material, both verified:**

- The plan references `docs/purchasing-inventory-plan.md` at line 2650 as the
  detailed specification. **That file does not exist.** The sections above are the
  whole specification.
- **"Invoice" appears exactly once in the plan, and it is a negative** — line 1355:
  goods receipts *"record facts only; they do not create invoices, tax, or ledger
  postings."* [ADR-0017](../decisions/ADR-0017-cost-capture-without-valuation.md)
  reinforces it: receipt lines capture actual cost or an explicit absence,
  movements carry no amount, `inventory.value` is `unsupported`.

**User ruling 2026-08-08:** the outbound document is a **shipment document** — a
packing-slip listing what shipped, no amounts, no tax. This keeps v1 inside
ADR-0017 and requires no new ruling. A priced document or a real AR invoice were
both offered and declined for v1.

---

## 2. The four packets

| Packet | Deliverable | Depends on |
|---|---|---|
| **`PUR-1`** | `purchase_order` + `purchase_order_line`. Create, edit while draft, release, browse. **No inventory movement.** | current `main` |
| **`PUR-2`** | `goods_receipt` + `goods_receipt_line`. Receive against a released PO, partial and full, posting positive movements. | `PUR-1` |
| **`SAL-1`** | `sales_order` + `sales_order_line`. Mirror of `PUR-1`. | `PUR-1` reviewed |
| **`SAL-2`** | `shipment` + `shipment_line`, negative movements, and the printable shipment document. | `SAL-1` |

**They are serial, and the reason is mechanical rather than stylistic.** Every
module mount touches three shared *sequential* things: `builder.ts` destructures a
fixed tuple with a hard-coded count and error string; `apps/web/release/app.compiled.json`
is a content-addressed lineage (8 entries, last root `b0177bf4…`) to which each
mount appends the next entry; and the migration number. Two lanes mounting
concurrently do not merely conflict — the second lane's appended entry is invalid
once the first lands, so it must regenerate, **voiding its reviewed artifact and
the matrix that was green at it.**

Work that authors no definition — UI packets under `apps/web/src/` — is genuinely
parallel-safe against this chain.

---

## 3. What the platform already provides

The reason this is small rather than large:

- **Parent-scoped lines are exercised.** `party/definition.ts:221` uses
  `ownership: 'parentScopedChild'`.
- **Generic create/update/archive/restore operations and form surfaces are
  auto-emitted** per entity. Mounting an entity gets screens without per-module
  platform code.
- **Terminal-state protection is built and hardened.**
  [ADR-0034](../decisions/ADR-0034-terminal-state-operation-preconditions.md)
  evaluates `operationDefinition.precondition` at `prepareMutation` against every
  image an effect consumes or produces, **plus a generic parent-aggregate rule**:
  a mutating operation on the parent of an active `parentScopedChild` relation must
  satisfy the parent's precondition. **So a not-released predicate on the header
  covers every line with zero line-level declarations.** It shipped with ten
  controls and two rounds of fail-open defects already found and fixed.
- **A posting service exists** —
  `packages/postgres-provider/src/inventory-posting-service.ts`, one private
  `#post` for every command family, with lock ordering proven under a real `40P01`.

## 4. Decisions taken, with their reasons

**Do not use `stateMachines`.** The canonical language declares it, the compiler
materializes it into a `derivedStateFields` column — and `packages/runtime/`
contains **zero** references to it. Every first-party module declares
`stateMachines: []`. The concept has never executed; queue row `5g3-sm` owns its
fate. Author `state` as an ordinary enumeration and guard it with ADR-0034
preconditions, exactly as `stock_count` does over `draft | counting | reviewed | posted`.

**Classify every new family.** `LEGAL_ENTITY_FAMILY_MAP_V1` in
`packages/domain/src/inventory/contracts.ts` — an undeclared family is a compile
failure with no default. All eight new entities are `entityOwned`.

**Mount only in `packages/domain/src/app/builder.ts`.** Composing in
`generate-app-authored.ts` instead would create a second desired-state authority.

**Accept a lineage entry per mount.** Routine — `G3-P4b` did it for two entities —
but measured rather than assumed, with before and after roots reported.

---

## 5. Assumptions that would sink this plan

Listed so a reviewer can attack them directly.

1. **That receiving and shipping can reuse the posting service by adding a role.**
   `INVENTORY_POSTING_ROLES` is `adjustment | transfer | count | correction | reBaseline`
   and it exists **twice** — `packages/domain/src/inventory/contracts.ts:12` and
   `packages/compiler/src/conformance.ts:198` — byte-identical, with **no test
   referencing either constant and nothing binding them.** `conformance.ts:3115`
   gates on `hasExactKeys`. If adding a role is not cheap, `PUR-2` and `SAL-2` are
   much larger than charted.
2. **That the composition model scales.** `builder.ts` destructures a fixed
   four-tuple and throws `'the composed application requires four modules'`. Eight
   more entities across four modules means editing that load-bearing line four
   more times. Whether this is fine or a smell is a real question.
3. **That the lineage cost per module stays flat.** Each mount appends an entry and
   re-derives pinned expectations. If that cost grows with lineage length, the
   fourth module is not the price of the first.
4. **That reservations are needed at all for v1.** The plan puts reservation
   between sales order and shipment. A v1 that ships directly from a confirmed
   order, refusing when stock is short, may be adequate — or may be a rework trap.
5. **That an ERP with no money is usable.** No valuation, no invoice, no AR. The
   office worker sees quantities and documents. This is the plan's deliberate
   boundary, not an oversight — but whether it clears the bar for *usable v1* is a
   product judgement, not a code one.
6. **That enum-plus-precondition is a durable lifecycle pattern.** It works and is
   proven once, on `stock_count`. Four more documents with richer lifecycles is a
   different load.

---

## 6. What v1 explicitly does not include

Supplier pricing and cost capture beyond what ADR-0017 already permits; any
valuation; invoicing, tax or ledger postings; back-orders; drop-ship;
multi-currency; approval workflows; and any agent journey beyond what the existing
fixed-tool set already covers.
