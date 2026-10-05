# RETURNS — review round 1 prompt (ONLINE arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/RETURNS`, frozen executable SHA `HEAD_SHA`, base
`packet/PAYABLES` at `681f4675`. Read `docs/architecture/posting-kernel-guarantees.md`, then the diff
`681f4675..HEAD_SHA` of `packages/postgres-provider/src/inventory-posting-service.ts` and
`db/migrations/0029_returns_posting.sql`, and any other code you need. Not the packet records. Tests:
`test/postgres/customer-return.test.ts`, `test/postgres/vendor-return.test.ts`; controls: `test/evidence/RETURNS.expected-red.json`.
Question: is there a defect in production code under the claims below? For each, give the code path and the
input or interleaving that reaches it. List evidence, wording and naming points separately.

What changed. Two companion posting families: `customer_return` (fulfillment capability; `postCustomerReturn`,
`lockCustomerReturn`, `assertCustomerReturnBounds`, `returnedLedger`, `assertCustomerReturnCompensation`,
`verifyCustomerReturnPosting`) and `vendor_return` (receiving capability; `postVendorReturn`, `lockVendorReturn`,
`assertVendorReturnBounds`, `verifyVendorReturnPosting`); a shipment-correction guard
(`assertShipmentKeepsReturnedUnits`); roster, writer roots and verifier registrations; digest versions 7 and 8
(`currentCommandDigest`, `digestCommand`, `validateReceiptReplay`); migration 0029 admits both. Called and
changed: `goods-receipt.ts` (`receivedLedger` includes vendor returns), `received-quantity-projection.ts`
(`receivedFacts`, `reconstructedReceivedFacts`: reconciliation and the materializer's rebuild), `fulfillment.ts`,
and the command hydration in `fulfillment-capability-executor.ts` and `receiving-capability-executor.ts`.
Claims. B1 per sales order line, 0 <= net returned + attempted <= net shipped, checked inside the posting and
refused with its operands. B2 a return lands in its chosen location; shipped, the shipped row and reservations
are unchanged. B3 a shipment correction may not take net shipped below net returned. B4 returns and shipment
corrections of one order serialize on the order row and its line rows before either ledger is read. B5 a
correction or reversal takes back only movements of the posted return it names, each once, from where they went.
B6 every relation a return writes is read back before commit. B7 digest 7 covers all caller input; a duplicate
replays once; a retry under a later policy revision replays from the recorded evidence. V1 a vendor return never
takes a purchase order line's net received below zero. V2 received is net of vendor returns; a receipt correction
cannot take back returned units. V3 reconciliation counts vendor returns. V4 the rebuild reproduces each line net
of them. V5 vendor returns of one order serialize on its rows. V6 every relation a vendor return writes is read
back. V7 as B7, for digest 8.

Things to try: interleave two returns of one line, a return and a shipment correction, or a vendor return and a
receipt, amendment or close, into different locations, and consider what each reads before and after its locks;
name another return's, a shipment's or an already compensated movement in a correction; compare how a vendor-return
movement is attributed in the ledger, the sweep and the rebuild (joins, state, sign, unit, item); change one caller
input under the same key, replay after the document changed, retry after a grant change; look for lock-order
cycles with receipts, invoices, bills, reservations and the period lock. Known and filed (say if you rate them
differently): lines of posted documents carry no update guard of their own (shipment, receipt and return lines
alike); source-document reconciliation reports a return's companion transaction as an unrecognized type, as it
does a shipment's. Say plainly if this prompt steers you.
