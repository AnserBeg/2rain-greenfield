# CUSTOMIZE-4 — tenant-authored Goods Receipt Inspection

Status — checkpoint, STOP at the document editor runtime capability version. Base `99371b43`. No Critical path changed or slice merged.

## Claims

1. An ordered change set compiles to one candidate and one diff. A member can use a record type created by an earlier member. The inverse dependency order, nested sets and multiple drafting tool calls are refused.
2. The compiler accepts a company-owned tenant record type with scoped queries and identifies its company ownership in the diff. A company-owned source can link to a goods receipt. A tenant-shared source is refused by the compiler for the same link.
3. The lifecycle patch compiles a materialized state and guarded transition operations. An undeclared state endpoint is refused. These are compiler proofs; attachment to the Customize screen and assistant execution are pending.

## Decisions

- An ordered change set has two to sixteen individual patches and replays as one lineage entry. Approved migration 0034 uses a bounded identifier check with the versioned application parser as authority. Main has 0032. Wait for 0033 before landing 0034.
- Company ownership is declared on a new type. The additive v6 `companyOwnership` key leaves earlier revisions' storage intact. The compiler preserves first-party classifications and reuses scoped create and query metadata. See ADR-0015.
- Use the existing editor's sequential per-row saves. A parent with active lines is refused on archive. Atomic parent-and-line O1 is filed for later.
- The floor-23 reader starts the document editor only with exactly one company in page, fragment and submit paths. A tenant-shared form has an empty scope and silently falls back to header-only. The editor definition also requires an editable-state field, so it cannot express a line-only record type without a lifecycle. Both extensions need a new surface-manifest capability version. Approve that version or limit this packet's line tables to company-owned types with a lifecycle.

## Gates

- Six focused unit tests, typecheck, lint on the changed sources, formatting and `scripts/check-records.sh` passed locally. Hosted CI, PostgreSQL replay, browser authoring, assistant transition execution and integration are pending.

## Gaps

- Rung 4 receiving event subscription is the next packet. Quarantine changes only the inspection status.
- Line editor capability ruling, link authoring and rendered pickers, lifecycle UI and CUSTOMIZE-3 guards, mixed-request approval, migration 0034, and the full §10.5 Inspection proof are pending.

## Test it yourself

Run `node --import tsx --test --test-name-pattern='tenant lifecycle|tenant-shared source|company-owned tenant record|change set|separate proposals' test/unit/customization.test.ts test/unit/customization-ai-draft.test.ts`. Expect six passes covering ordered drafting, ownership, and lifecycle compilation and refusal.
