# CUSTOMIZE-4 — tenant-authored Goods Receipt Inspection

Status — build checkpoint started at `99371b43` and synchronized with `8b61740a`. Integration depends on CUSTOMIZE-3's 0033.

## Claims to verify

1. One ordered change set carries a record type, links, lines and lifecycle through one diff, approval and lineage row. An unknown member or inverse dependency is refused.
2. A company-owned header and its lines use company-scoped reads and writes. Tenant-shared types use unscoped requests and can link to tenant-shared targets.
3. The document editor selects declared header links and saves the header before its lines. An active child restricts parent archive. Lists search and filter by linked labels and records.
4. A lifecycle supplies the status and available actions. Quarantine and Release act on the inspection; the assistant asks for confirmation.
5. Inspection is authored in the Customize screen and as an ordered patch fixture. Its implementation uses the same surfaces, operations and storage as other tenant record types.

## Decisions

- Floor 25 admits create-time header links and shared or lifecycle-less editors, including their declared List relation columns. CUSTOMIZE-3 uses floor 24 for saved views. See ADR-0072.
- Links are chosen at creation and restrict archiving a target with active dependents. Multiple inspections can refer to the same receipt, so Inspection needs no new uniqueness rule.
- List search matches linked labels. Selecting a linked value narrows the list by that record's ID.
- The editor uses sequential per-row saves and refuses parent archive while there are active lines. Company ownership follows ADR-0015.
- The visual path publishes a record type, then drafts its lines, links and lifecycle together. A plain-English request can draft both steps as one change set.
- Approved 0034 replaces the SQL kind allowlist with a bounded identifier check. The versioned parser still refuses unknown kinds at write and replay.

## Gates

- Typecheck, changed-file format and lint, record checks and compiled release freshness passed. Five focused tests cover ordered drafting, ownership, lifecycle, lines, links and refusal by older surface readers.
- The full Inspection change normalized against the synchronized trunk with four relations, owned lines and five transitions. The re-baseline retained the first-party authored definition and every projection digest except the bootstrap storage transition.
- Hosted PostgreSQL, browser and scripted assistant evidence are pending. Migration 0033 is on CUSTOMIZE-3's branch. Its [CI run](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44441030550) reached TS2742 in `loadDeclaredListCounts` during Build and was cancelled. Trunk still ends at 0032.

## Gaps

- Next packet — receiving event subscription (rung 4) for automatically starting an inspection. Keep the resulting writes inside Tier A.
- Reuse CUSTOMIZE-3's validation predicates as action guards once that dependency lands.

## Test it yourself

After integration, open Customize, add a company-owned **Goods Receipt Inspection** with a **Name** field, approve and activate it. From **Lines, links and actions**, give it an **Inspection results** table and add **Goods receipt**, **Supplier**, **Item** and **Location** links. Declare **Pending**, **Quarantined** and **Released**, then add **Quarantine** and **Release** with those endpoints. Approve and activate. Create an inspection with a receipt and a result line. The record shows the linked receipt and result. Confirm **Quarantine** and check that **Release** appears.
