# CUSTOMIZE-4 — tenant-authored Goods Receipt Inspection

Status — compiler checkpoint. STOP at combining header links with the floor-23 document editor. Base `99371b43`. No slice merged.

## Claims

1. An ordered change set compiles to one candidate and one diff. A member can use a record type created by an earlier member. The inverse dependency order, nested sets and multiple drafting tool calls are refused.
2. The compiler accepts a company-owned tenant record type with scoped queries and identifies its company ownership in the diff. A company-owned source can link to a goods receipt. A tenant-shared source is refused by the compiler for the same link.
3. A lifecycle compiles a materialized state, guarded transition operations, a status column and the record's stepper. An undeclared state endpoint is refused.
4. One line table on a company-owned tenant type with a lifecycle compiles to generated child storage, a parent-scoped list, contextual CRUD surfaces and the sequential document editor. A shared type or a type without a lifecycle is refused. The initial state governs header and line editing.

## Decisions

- An ordered change set has two to sixteen individual patches and replays as one lineage entry. Approved migration 0034 uses a bounded identifier check with the versioned application parser as authority. Main has 0032. Wait for 0033 before landing 0034.
- Company ownership is declared on a new type. The additive v6 `companyOwnership` key leaves earlier revisions' storage intact. The compiler preserves first-party classifications and reuses scoped create and query metadata. See ADR-0015.
- Use the existing editor's sequential per-row saves. A parent with active lines is refused on archive. Atomic parent-and-line O1 is filed for later.
- The orchestrator kept floor 23 and limited line tables to company-owned types with a lifecycle. Support for shared types or types without a lifecycle is filed in the archive.
- The child uses an ordinary contextual list, record and form, with a read scenario as the compiler requires. A text field identifies a line in search and resolve.
- The existing create-only relation contract remains the source of link targets. Inspection needs that contract on the same header that owns the inline line editor.

## Stop

- A compiler probe of a company-owned header with a required goods-receipt relation and a line table emitted the header relation in the create operation and only scalar fields plus the child's owning relation in the editor. The floor-23 editor's save plan sends `relations` only on child creates. A required header link would therefore refuse with `MODULE_REQUIRED_RELATION_MISSING`. An optional header link has no control or submit path in that editor.
- Option A — authorize a surface-manifest floor bump for a reusable document editor that reads the pinned header relation inputs and sends them on create. Gate the new shape so older readers refuse it. Keep create-only links and sequential writes.
- Option B — keep floor 23. Use the generic relation form for the header and open the separate document editor for lines after the header is saved. This changes the requested single editor for creating the document and its lines.
- Recommend A. Keep the approved 0034 bounded-identifier check and authoritative patch parser, after 0033.

## Gates

- Seven focused tests, typecheck, changed-file lint and formatting, and `scripts/check-records.sh` passed. Hosted CI at a complete slice, PostgreSQL replay, browser authoring, assistant transition execution and integration are pending.

## Gaps

- Rung 4 receiving event subscription is the next packet. Quarantine changes only the inspection status.
- Header link support in the line editor, link authoring and list filtering/search, visual authoring, CUSTOMIZE-3 validation guards, mixed-request approval, migration 0034 and the §10.5 Inspection proof remain open. No inspection-specific implementation exists in the first-party packages.

## Test it yourself

Run `node --import tsx --test --test-name-pattern='tenant lifecycle|tenant line tables|tenant-shared source|company-owned tenant record|change set|separate proposals' test/unit/customization.test.ts test/unit/customization-ai-draft.test.ts`. Expect seven passes covering ordered drafting, ownership, lifecycle and line-table compilation and refusal.
