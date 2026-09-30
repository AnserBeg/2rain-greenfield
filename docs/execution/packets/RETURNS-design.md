# RETURNS — design (read-only research, 2026-09-30)

Written by the orchestrator's research agents against `packet/PURCHASING-PARITY` at `cb52d993`; every file:line is a hint to re-verify on this branch. Owner rulings are taken (the owner's standing instruction: take the recommended choice).

## B. CUSTOMER-RETURN: return into a chosen location, bounded by shipped − returned (Critical, largest)

**Model.** A new companion family, `customer_return`, under `northstar.sales:capability.fulfillment` (ADR-0049 §4: one kernel, one capability id per domain). Shipped stays shipped, returned has its own ledger, and credit stays a separate step (ruling D). PaneFlow says the same: "Original shipped quantity remains fulfilled" (dom.ts:2538). No new projection is needed; the bound reads the ledger.

**Kernel change** ([k]):
- **Family entry** in the roster (:150-235): companion `inventory_transaction` and its lines, prefix `RT`, source line `customer_return_line`; role `customerReturn` for the movement option, posting role and transaction type; source type `customerReturn`.
  - Skip the family when the target has no `customer_return` entity, as :2586-2599 does for receipts and shipments.
  - Add the role to the union (:481), and map reason/approval the same way as shipments (:3739).
- **`postCustomerReturn`**, beside `postShipment` (:1104):
  - initial lines are positive and name no reversed movement;
  - corrections and reversals are negative and name a return movement plus `supersedesReturnId`;
  - companion ids are derived.
- **Inside `#post`:**
  - `lockCustomerReturn` takes locks in `lockShipment`'s order (:4708): read the header, lock the order `FOR NO KEY UPDATE`, lock order lines in ascending order, then the header, then the lines.
  - `assertReturnBounds` checks:
    - the return is a draft at the expected revision, and its header and line attribution match;
    - the order is released or closed;
    - item and unit match the order line;
    - per order line, returned (net) + attempted ≤ shipped (net). Shipped comes from `shippedLedger` (:4667); returned comes from a new twin, `returnedLedger`.
  - `assertReturnCompensation`: a correction must name a posted return of the same order, reverse movements that belong to it, and not over-reverse.
  - Companion write (:1508-1512), update the return to posted, then `verifyCustomerReturnPosting` with coverage tokens (ADR-0062).
- **Shipment corrections.** `assertShipmentCompensation` (:5086) refuses when net shipped − restored < net returned.
- **Digest v7**, following the v5 receipt and v6 shipment precedent: `currentCommandDigest` (:9236), `digestCommand` (:9251) and replay decoding (:9310).
- **Migration 0029**: `CHECK input_digest_version IN (1..7)`, following the pattern at 0028:3-7.
- **`fulfillment.ts`**: optional entities for the return and its lines.

**New codes:** `FULFILLMENT_RETURN_QUANTITY_OUT_OF_BOUNDS` `{orderLineId, shippedQuantity, returnedBefore, attemptedQuantity}`; `FULFILLMENT_RETURN_INVALID` (state, attribution, compensation); `FULFILLMENT_SHIPMENT_BELOW_RETURNED` `{orderLineId, shippedAfter, returned}`.

**Effect on existing tests.**
- Shipment paths are unchanged while nothing has been returned, so the correction tests in `fulfillment.test.ts` still pass.
- Tests that pin the list of migrations need updating: `migrations.test.ts`, `trust-substrate`, `module-storage-transition`, `inventory-storage`, `release-persistence-boundary`.
- Also affected: the full-replay schema snapshot, `document-numbering` (new `RMA-` sequence) and `composed-application`.

**Claims and controls** (`test/evidence/CUSTOMER-RETURN.expected-red.json`; the tests live in `test/postgres/customer-return.test.ts`):

| claim | control: mutation → test that kills it |
|---|---|
| B1. Per order line, net returned ≤ net shipped, checked inside the transaction. | `return-bound-removed` → "an over-return is refused with its four operands". |
| B2. A return lands in its chosen location and does not reduce shipped, reservations or invoiced quantity. | `shipped-ledger-counts-returns` (:4692 `='shipment'` → `IN ('shipment','customerReturn')`) → "after 2 of 5 are returned, 3 remain returnable and a 4th is refused". |
| B3. A shipment correction cannot take back returned units. | `shipment-guard-removed` → "a shipment reversal below the returned quantity is refused". |
| B4. Returns on one order line serialize on the order row lock. | `return-order-lock-dropped` → two concurrent returns of 3 against 5 shipped, into **different** locations (so the stock locks do not serialize them): exactly one is refused. |
| B5. A correction reverses only movements of the posted return it names. | `return-correction-accepts-foreign-movement` → "a correction naming a shipment movement is refused". |
| B6. Every relation a return writes is read back before commit. | `return-verifier-call-deleted` → the success test fails with "wrote module relations no executed verifier observed". |
| B7. Replay: the same key with a changed input conflicts, and a duplicate delivery posts once. | `return-digest-drops-lines` → "same key, different quantity → `INVENTORY_POSTING_IDEMPOTENCY_CONFLICT`". |

**Where the user sees it** (outside the Critical set):
- Sales gains `customer_return` and its lines:
  - numbering `RMA-`, with relations to the order and the order line;
  - a location picker offering any active location; quarantine and damaged statuses come later with the audit's S6;
  - reason choices and notes;
  - the companion relations cannot be written.
- `customer_return_post` operation, and a "Receive return" task on a shipped order line, modelled on the purchasing receive task (`purchasing/workspace.ts:193-235`).
- A Returned column on order lines via the commercial read model, and a Returns list.
- A "Reverse return" command, where the executor derives the reversal lines from the return's own movements. This gets around "a task cannot name the movement it compensates".

**Round-1 prompt outline.** Critical paths: [k] and `db/migrations/0029_*`, with `fulfillment.ts` as context. Claims B1-B7.

**Size.** Kernel about 550 lines, migration about 8, executor about 150, Sales domain/workspace/read model about 450, tests about 700, a 7-entry manifest, one lineage entry.


## Vendor returns (from the structural note)

**Vendor returns.**
- **PaneFlow:** `postVendorReturn` (`dom:1605-1660`). At most net received (`:1614`), from a usable, quarantine or damaged location (`:1618`).
  Replacement or repair leaves the line open to receive; refund adds to `closed_qty` (`:1653`). VRT- numbers; value relieved.
- **Rain:** nothing.
  - v1 rules a return is "a SEPARATE DOCUMENT" posting "negative movements against a received lineage" (`v1:797-806`).
    The customer mirror also needs "a customer-return posting family in the Critical kernel" (SALES-PARITY.md:61).
  - The kernel admits three capability families (`kernel:323-337`). Each new family has needed a migration (`mig/0027`) and a verification refusal (rvs:235-257).
  - Received is the ledger sum attributed to the PO line (ADR-0065), so a return lowers it and reopens open-to-receive: PaneFlow's "replacement expected" for free.
- **Plan:** "NOT in v1's four packets and it is NOT excluded either" (`v1:807-808`). N3: "returns, RMA, supplier returns, and disposition" (`plan:3186`; N3-03).
- **Rulings (→ recommended).**
  - **R-A** → Return net of received. A refund is the return, then the existing "Close open remainder" (PURCHASING-PARITY claim 8).
  - **R-B** → One RETURNS vertical: customer returns (ruling D) plus vendor returns, with one Critical arm.
  - **R-C** → Any active location is a valid source until §4 status lands.
- **Critical:** Yes. **Packet RETURNS, L.** First slice: return N units of a received PO line from a location (VRT-). One negative movement; received −N.

(Drop ship is a separate packet, not part of RETURNS.)
