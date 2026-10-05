# VALUATION — moving average from retained operational facts

Owner-selected 2026-09-30, BUILD on `packet/VALUATION`, stacked on PAYABLES.
Rulings: moving average per item, company and currency; derived, never money on
movements; unknown inflows remain unvalued; no FX; landed cost after payables.
Authority amendment: ADR-0067. No accounting, FIFO inventory layers, journal,
standard cost, persisted valuation balance, write command or posting change.

## Inputs and authority

The read model consumes declared, plain semantic queries through the current
query gateway. Every company-owned dependency receives the same explicit
single-company operand; tenant/environment come from the pinned request view.
The catalog item remains tenant-shared; its valuation query adds the company
operand for its dependencies without making item storage company-owned.
No provider SQL bypass, cached privileged answer or nested read model is used.
A denied dependency refuses the item valuation read rather than reporting zero.
On a commercial document, supplementary cost and margin are withheld with a
current-policy coverage statement; its independently authorized stored facts
and commercial totals remain readable.
Paging reads every dependency page and verifies its echo; malformed/incomplete
history is refused. Draft receipt lines never value stock: movement lineage
must name the posted receipt and its line, item and unit exactly.

Movements supply signed quantity, effective/recorded time, source identity,
posting role and reversal identity. Actual unit cost/currency/status come only
from the receipt line. An explicit absence, missing receipt cost or an ordinary
adjustment/count inflow adds unvalued quantity. A zero *known* cost is valid.
Costs never come from selling prices or purchase-order estimates.

## Replay arithmetic and order

Replay by the kernel's frozen seven-key tuple: effectiveAt, recordedAt,
sourceType, sourceId, sourceLine, postingRole, movementId. Aggregate locations
within one item/company. A complete transfer's paired equal/opposite quantities
have no company cost effect; an incomplete transfer is refused.

Use exact BigInt rational arithmetic through the replay, including proportional
relief, and round half up only at display (average to six decimals, values to
cents). No binary floating point, locale-dependent order or accumulated rounding.
For a known inflow q at unit cost c in currency X: Q[X] += q; V[X] += q*c.
Unknown inflows change U, not any currency pool. On an outbound q, each pool
and U are relieved in proportion to its share of total on hand immediately
before that movement. Each currency's average is V[X]/Q[X]; its relieved value
is its relieved quantity times that average. This is the moving-average rule
applied to disjoint cost-coverage pools, never a choice of FIFO inventory.
No currency's amount is added to another. The unknown share has no guessed
amount. If a negative-stock history prevents a positive coverage denominator,
withhold monetary figures and disclose the uncovered quantity; never repair
history or infer a cost from a subsequent receipt.
Compensation can also leave residual value at zero covered quantity; withhold
monetary figures in that case rather than silently dropping the residual.

A compensating movement restores/removes the exact proportional cost and
unknown-quantity contribution of its named movement, scaled to its compensated
quantity. A receipt correction with newly captured cost is a fresh receipt
inflow; a reversal negates its named effect. Replaying after a late receipt or
bill intentionally recomputes later averages and relief. These are operational
estimates, not immutable financial postings.

## Slice 1 — stock value

A supported `northstar.inventory:capability.valuation` read capability and
registered item binding are authored in canonical metadata, projected by the
compiler and registered in the shared composed runtime. Catalog -> Inventory
value is a List of catalog items in the selected company. One item occupies one
row, preserving the ordinary List's paging/count/search/export semantics.
Columns: item, on hand, average cost, value, unvalued quantity. Average cost and
value display currency-labelled summaries, one independent figure per currency;
there is no cross-currency total. With unknown quantity, value explicitly reads
as the known value and U remains visible. No-stock is zero quantity/value and
no average. The item record uses the same binding and facts, with its company
entry, valuation figures and existing selling prices; its editor and ordinary catalog queries stay plain.
Read-model columns are supplementary unsorted values under the existing v6
vocabulary, so no language-version change is required.

## Slice 2 — shipment relief and margin

The same replay returns signed relief by movement/source line. A shipment line
shows relieved value and unvalued quantity, with currency-labelled figures;
corrections restore the original relief, rather than using today's average.
Shipment, sales order and invoice read models sum the relevant effects by their
persisted lineage. An invoice's billed quantities are matched in chronological
live-invoice order to net shipped quantities per sales-order line; partial
invoices take the same proportional share of that line's relieved cost.
Margin is the invoice's pretax line subtotal less relieved cost, and is stated
only when its billed quantity is fully costed in the invoice currency. Freight,
fees, taxes, payments and credits do not become product margin. Voided invoices
have no cost/margin. No-FX means mixed-currency relief cannot produce a margin
in one currency; disclose that absence instead of converting or dropping it.
The order margin compares net shipped quantity at the stored order-line price
and discount with its relieved cost; unshipped revenue is excluded. Shipment
line relief is a separate read-only child table beside the original packed
facts. Cost, coverage and margin are internal record fields, excluded from the
customer invoice print declaration. Original stored get identities stay plain for release admission and its
declared probes. Dedicated valuation gets serve the document compositions;
their existing company operands preserve document URLs. Row-query operands
are query-local in the adopted grammar. Other consumers of stored facts do
not depend on derived costing.

## Slice 3 — landed cost

Read live vendor bills and their lines (open, partially paid, paid; drafts/voids
excluded). The bill's persisted `charges` is its freight + other fee, pretax;
tax and subsequent payments/credits do not change receipt cost. Match each live
bill line's quantity to the net receipts of its purchase-order line, oldest
receipt first by the same deterministic movement order. This establishes the
billed receipt portions from PAYABLES' order-line provenance; it is not an
inventory-cost FIFO layer. Live bills are matched by bill date and record id.
Reversal quantities reduce the available receipt portions. A shortage, unknown
cost, currency mismatch or zero allocation basis leaves landed-cost coverage
unstated; it never allocates against an estimate or silently loses a charge.
Allocate each bill's charges by the actual captured value of its matched
receipt portions. Exact rational shares sum to the exact charge, including
fractional cents; rounding is presentation only. Attribute shares back to their
original receipt inflows and replay, so remaining value and prior shipment
relief both re-derive. Missing captured receipt cost remains unvalued: a bill's
order price cannot cure it. No source fact is updated by this read.

## Delivery and gates

Owned: valuation metadata/arithmetic/read-model files; application composition,
List declarations and runtime registration; compiler money-boundary amendment;
ADR/design/record/test-it-yourself; focused unit/integration/web contracts,
PostgreSQL stored-row oracle and operations browser spec; reachability registries,
release/coverage artifacts and measured pins. Small bridges are disclosed.
Critical set untouched: posting kernel/serializer, trigger/rebuild, activation,
verification, trust, migrations, RLS/grant SQL. If needed, stop that slice and
charter a separate Critical packet with one expected red per claim and an
owner-run prompt. No review arm owed for this design's implementation.
Each pushed slice rebuilds exactly one release entry from origin/packet/PAYABLES,
then checks freshness. No storage addition is intended. All counts come from
compilation; coverage is re-derived. Container tests serialize through the
exclusive lock; browsers use one worker. Startup failures retain the existing
bounds and go to hosted CI. CI green at the slice SHA precedes the next slice.
Final: draft PR against packet/PAYABLES, <=150-line record with record-claim,
test-it-yourself steps under ten minutes/slice. Never merge or deploy.
