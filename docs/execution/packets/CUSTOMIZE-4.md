# CUSTOMIZE-4 — tenant-authored Goods Receipt Inspection

Status — STOP at legal-entity ownership for tenant record types. The Inspection proof is pending.

## Claims

1. The focused compiler test produces one candidate and one diff for an ordered change set. A member that references a record type created by an earlier member fails when the order is reversed.
2. A scripted drafting request produces one ordered change set. Separate tool calls, invalid members and nested change sets are refused. An unknown patch kind is named by the parser.

## Decisions

- `changeSet` uses an ordered list of two to sixteen existing patches. It has one position in the replay chain.
- Approved migration 0034 will use a bounded spelling check, keeping the versioned application parser authoritative. It waits for 0032 and 0033.
- The compiler probe rejected declared links from a tenant type to Goods Receipt, Purchase Order, Party, Item and Location as `INVENTORY_RELATION_ENTITY_SEMANTICS_UNDECLARED`. ADR-0015 requires an explicit ownership and relation classification.
- Recommend declaring Inspection company-owned at creation, inheriting that company on its result lines and enforcing same-company links to company-owned records. Existing tenant record types retain their original storage.

## Gates

- Focused unit tests, typecheck and lint pass locally. PostgreSQL replay, browser use, agent transitions, hosted CI and integration are pending.

## Gaps

- Rung 4 receiving event subscription remains the next packet. It creates an inspection from a receipt event. Quarantine changes only the inspection status.
- Resolve company ownership before completing links, result lines, declared states and the no-inspection-specific-code proof. Migration 0034 and the one-row PostgreSQL proof are pending.

## Test it yourself

Run `node --import tsx --test --test-name-pattern='unknown patch kind|change set|separate proposals' test/unit/customization.test.ts test/unit/customization-ai-draft.test.ts`. Expect three passes. The sandbox test produces a single candidate for two changes and refuses the reversed dependency order.
