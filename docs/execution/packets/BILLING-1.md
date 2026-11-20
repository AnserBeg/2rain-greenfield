# BILLING-1 — period and usage billing

Slice 0 proposes [the Tier B billing design](../../decisions/ADR-0083-period-and-usage-billing.md) for the orchestrator’s Fable read. Implementation awaits its ruling.

## Design decisions

- A rate plan binds to any declared interval or usage query. Its immutable versions supply the terms behind each charge.
- Time minimums and caps belong to the service’s pricing window. Crossing an invoice date preserves the amount already used.
- Receivables needs a billing-origin draft operation alongside its shipped-order flow. A person confirms the exact invoice before issue.
- WORKFLOW-1 can schedule a draft proposal. Its Tier B write requires approval under ADR-0073.
- The equipment-hire and subscription proofs use the same add-only Customize vocabulary.

## Gates

Slice 0 changes documentation only and allocates no migration or reader rung. The record check passed. All 18 jobs passed at `6fd58698`. The packet then synchronized with the BOOKING-1 documentation under the docs-only re-run rule. [Hosted CI](https://github.com/AnserBeg/2rain-greenfield/actions/runs/44670135739)

## Test it yourself

1. Open **How a line earns its amount** in the ADR. Starting with ten days, subtract the one-day pause and check that one CAD 100 week plus two CAD 30 days is CAD 160.
2. Use the subscription example. Half the cycle earns half the CAD 31 fee and five included units. Eight units leave three at CAD 2. The two draft lines total CAD 21.50 before tax.
3. In **Who may write a draft and issue it**, follow a second Generate request for an already covered cycle. Find the original draft, the duplicate protection and the separate human confirmation needed to issue.
4. From the repository root run `scripts/check-records.sh`. Expect exit status zero.
