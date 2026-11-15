# APPROVALS — design (read-only research, 2026-09-30)

Written by the orchestrator's research agents against `packet/PURCHASING-PARITY` at `3769ed9e`; every file:line is a hint to re-verify on this branch (paths: `kernel` packages/postgres-provider/src/inventory-posting-service.ts, `gr` goods-receipt.ts, `rt` composed-application-runtime.ts, `life` purchasing-order-lifecycle.ts, `pdef` packages/domain/src/purchasing/definition.ts, `trust` packages/platform-runtime/src/trust/contracts.ts, `rel` release approval, `root` apps/api/src/composition-root.ts; PaneFlow `adv` lib/server/advanced-domain.ts, `dom` lib/server/inventory-domain.ts, `rec` lib/server/inventory-records.ts). Owner rulings are taken (the owner's standing instruction: take the recommended choice).

## 0. Three facts that gate the whole program

1. **Lineage headroom.** `apps/web/release/app.compiled.json` is 74.4 MB at 25 entries, about +3 MB per entry. GitHub refuses files over 100 MB,
   so about 8 compiles remain, fewer than the packets below. The ADR-0066 re-baseline is the owner's call (PURCHASING-PARITY.md:61); rule on it first.
2. **Only one person exists.** LOCAL_DEMO runs every web request as one fixed human (`rt:710-713`, `rt:1036-1044`, `root:108`). `local-approver` serves only release activation.
   Nobody can approve anyone else's work until a second identity exists.
3. **Reserved seams.** "Only a stage that consumes one of these may implement it" (`plan:487-492`) covers unit conversion, valuation and dimension extension.
   Units, lot and valuation need plan amendments. Most other gaps are N2, N3 or N6 rows (`plan:3560-3569`), pulled forward by owner ruling, as SALES-PARITY rulings B and C were.


## 1. Approvals: PO approve/reject, place order, re-approval on amend (P5-P7); inventory approvals (I13)

**PaneFlow.**
- PO flow: Submit (draft|rejected → pending_approval, `adv:619-655`) → Approve/Reject (`adv:657-765`).
  Rejecting an amendment restores the prior approved revision (`adv:670-696`). Amend writes revision N+1 and sets pending_approval again (`adv:767-860`).
- Place order: "Mark as ordered" with a supplier reference (`adv:1673-1702`; `app:2505,2535`). Receiving needs approved **and** ordered (`dom:888-889`).
- Permissions: submit needs `read`, approve needs `approve` (`adv:43-60`). An approver may author an already-approved PO (`rec:460,502`). There is no maker-checker check anywhere.
- Records and queue: approvals are single-use (`consumed_*`, `schema:870-896`); revisions `schema:844-859`; queue `ops:258,1034`.
- Inventory: approval is needed for a count variance above 5 units or $1,000 (`dom:548-603`, `idb:308`), scrap above $500 (`adv:1046-1054`, `idb:309`)
  and over-receipt (`dom:849-861`). Request/decide `adv:862-915`; inbox `ops:1072-1083`. Transfers need none (`adv:974-1000`).

**Rain, and what blocks it.**
- POs: states draft/released/closed/cancelled (`pdef:58-63`), transitions `pdef:109-115`. Release opens receiving; the receipt refuses a non-released order inside the posting
  transaction (`gr:241-250`). An amendment is a staged intent applied at once through receiving (`life:145`). No approval record, no approve permission.
- Inventory: the kernel refuses over-threshold postings that lack `approvingHumanId` (`kernel:3760-3794`).
  - Thresholds are quantity-only (`icon:807`), all null (`root:61-80`), and have no update path (`mig/0019:4-16`).
  - The runtime issuer always supplies null (`rt:2208-2222`); the `resolve(context)` hook never sees the document being approved (`trust:63-66`).
- **Trap:** receipts and shipments count against the adjustment and correction thresholds (`kernel:3739-3744`). Setting a threshold would demand approval for every large receipt.
- Precedent to copy, release approval: the approver must be the trusted principal (`rel:417-433`), the maker cannot approve (`rel:612-620`; `mig/0007:570`), eligibility and expiry are checked.

**Plan.**
- Inventory thresholds are **IN** launch: "Reason, approval threshold" (`plan:1454`); "may require confirmation or independent approval" (`plan:1481-1482`);
  G3 build 7 "thresholds, and approval/confirmation" (`plan:2595-2596`). A launch item that was never built.
- PO approval is **OUT**: G4 needs only "submit or release" (`plan:2669-2670`); "purchase requisition, approval" is N3 (`plan:3187`);
  "Workflow and approvals" is N2 (`plan:3370`); v1 excludes "approval workflows" (`v1:145-148`).

**Rulings (→ recommended).**
- **A1 Model.** → A narrow approval-request record: one step, one approver, no timers. N2-01 absorbs it later. No new PO state (as the parity inventory's P5 row says).
- **A2 Who approves.** → POs: permission-gated, plus a tenant switch "POs require approval" that is off by default (PaneFlow has no maker-checker).
  → Inventory thresholds: independent, meaning approver ≠ requester, taken from the trusted principal (the plan's own word).
- **A3 Identity.** → A LOCAL_DEMO-only "acting as" switch between two seeded humans, Buyer and Manager. Real sign-in stays with AUTH.
- **A4 Place order.** → Release *is* "place order": relabel the command and add an optional supplier reference; the state stays "Released" (like SALES-PARITY claim 12).
  "Approved, not yet ordered" is a draft with an approved request, so `gr:241-250` stays unchanged.
- **A5 Amend.** → A staged amendment applies only once approved; receiving continues on current quantities meanwhile. PaneFlow blocks receiving (`dom:888`). A rejection restores nothing.
- **A6 Thresholds.** → Quantity-only (value thresholds wait for §5 valuation). Receipts and shipments exempt (a kernel change).
  A named, audited dial-change operation. The approval is consumed once, inside the posting transaction, bound to the draft revision.

**Critical?**
- PO approvals: No (authored entity plus executor; existing grants suffice, SALES-PARITY.md:58). Identity switch: No\*.
- Inventory approvals: **Yes**. `trust` (the hook needs the approval reference), `kernel` (verify and consume; the receipt/shipment exemption), and a migration (dial update path).

**Dependencies.** Identity → PO approvals → inventory approvals. Inventory approvals also need INVENTORY-PARITY S2 (adjustment document) and S5 (count posting). Value thresholds need valuation.

**Packets and first slice.**
- **APPROVAL-PO**, M. Smallest slice: Submit for approval → inbox Approve/Reject with a reason → "Place order" offered only on an approved current revision. It also carries the acting-as switch and amendment re-approval.
- **APPROVAL-INVENTORY**, L, Critical.
