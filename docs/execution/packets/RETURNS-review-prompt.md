# RETURNS — review round 2 prompt (ONLINE arm, user-run)

Repository `AnserBeg/2rain-greenfield`, branch `packet/RETURNS`, frozen executable SHA `98a83d8e`. Round 1 reviewed
`9c310635` against base `packet/PAYABLES` at `96ac2341`; this round's diff is `9c310635..98a83d8e`. Read
`docs/architecture/posting-kernel-guarantees.md`, that diff of `packages/postgres-provider/src/inventory-posting-service.ts`,
and any other code you need. Not the packet records. Tests: `test/postgres/customer-return.test.ts` (B7),
`test/postgres/vendor-return.test.ts` (V7), `test/postgres/inventory-posting.test.ts` (`RECEIPT posts ...`); controls:
`test/evidence/RETURNS.expected-red.json`. Run evidence: CI https://github.com/AnserBeg/2rain-greenfield/actions/runs/37342169158 (at `1420350b`, the executable tree of `98a83d8e`); controls https://github.com/AnserBeg/2rain-greenfield/actions/runs/37345593823 (the four named below, at `1420350b`).

Round 1's finding (B7, V7; shared with receipt digest 5): after the authorization evidence changed, a command under a
new key whose posting replayed a posted document by natural effect stored a receipt digested with the current
evidence but recording the original invocation; a duplicate of that key was digested with the original invocation's
evidence and was refused with `INVENTORY_POSTING_IDEMPOTENCY_CONFLICT`.

What changed, by function, in `inventory-posting-service.ts`:
- `digestCoversAuthorization(version, posting)`, new: true for digest version 5 with role `receipt`, 7 with
  `customerReturn`, 8 with `vendorReturn`. Before, this condition was inline in `validateReceiptReplay`.
- `withRecordedAuthorization(client, context, posting, invocationId)`, new: reads `policy_version` and
  `policy_evaluator_version` of that invocation from `platform.trust_action_invocations` (outcome `SUCCEEDED`, decision
  `ALLOW`); refuses with `INVENTORY_POSTING_IDEMPOTENCY_CONFLICT` unless exactly one row; returns the posting with
  `command.authorization` replaced by that evidence and every other field kept. Before, this was inline in
  `validateReceiptReplay`.
- `validateReceiptReplay`: calls the two above with the receipt's `invocation_id`; the principal and digest comparison
  is unchanged.
- `persistAdditionalReceipt`: when `digestCoversAuthorization(inputDigest.version, posting)`, the digest it passes to
  `insertReceipt` is `digestCommand` of `withRecordedAuthorization(..., result.trust.invocationId)` at the same version;
  otherwise the digest `#post` computed (`currentCommandDigest`), as before. A key that already has a receipt still
  goes to `validateReceiptReplay`. `#post` calls it after `findNaturalReplay` before any write, and after a 23505 inside
  savepoint `inventory_posting_write` followed by `findNaturalReplay` (the raced replay).
- Rename: `#post`'s local `stockCountRevision` is `sourceDocumentRevision` (it carries stock-count, shipment and return
  source revisions). The comment above `verifyVendorReturnPosting` names V6 (it said V4). No other production change.
- Tests: in B7, V7 and the RECEIPT test, after the existing policy-change retry, the same command under a new key with
  `policyVersion` suffixed `+later` is expected to replay, and its identical duplicate to replay with the same trust links.
  Controls: `additional-receipt-hashes-current-policy` (B7, V7) and `additional-receipt-hashes-current-policy-for-receipts`
  (RECEIPT) are new; `return-replay-hashes-current-policy` and `vendor-return-replay-hashes-current-policy` now mutate
  `digestCoversAuthorization`.

Claims, as reworded after round 1. B1 per sales order line, 0 <= net returned + attempted <= net shipped, read from the
ledger inside the posting and refused with its operands. B2 a return lands in its chosen location; shipped, the shipped
row and reservations are unchanged. B3 a shipment correction may not take net shipped below net returned. B4 returns and
shipment corrections of one order serialize on the order row, then its line rows, before either ledger is read. B5 a
correction or reversal names a posted return of the same order and takes back only that return's movements, from where
they went: each at most once per correction, never beyond the quantity it still adds; a reversal takes back all of it.
B6 the module-plane relations a return writes (the return, its companion transaction and lines) are read back column for
column before commit; platform trust rows are not column-verified, as for every family. B7 digest 7 covers the
normalized customer-return command except the idempotency key and the kernel-derived companion ids: the same key with a
changed return conflicts; a duplicate delivery replays without posting again; a receipt is digested with the
authorization evidence of the invocation it records, both when replayed (a retry under a later policy revision replays)
and when stored for a new key whose posting replays by natural effect (its duplicate replays); digests 5 and 8 alike.
Current authorization stays the gateway's separate decision. V1 a vendor return never takes a purchase order line's net
received below zero. V2 received is net of vendor returns; the line reopens to receive; a receipt correction cannot take
the order line's net received below zero (an order-line floor, not tracking of physical units). V3 reconciliation counts
each vendor-return movement. V4 the rebuild reproduces each line net of them. V5 vendor returns of one order serialize on
its order and line rows before the received ledger is read. V6 the module-plane relations a vendor return writes (the
return, its companion transaction and lines, each line's received row) are read back before commit; platform trust rows
as B6. V7 digest 8, on the same terms as B7.

Questions.
1. For digest versions 5, 7 and 8, after the authorization evidence changed: does a duplicate replay, and does a changed
   command under the same key conflict, in (a) a retry under the original key, (b) a new key whose posting replays by
   natural effect, and that key's duplicate, (c) the raced natural replay? For any case that does not hold, give the
   code path and the input or interleaving that reaches it.
2. Did this change break anything else? If so, give the code path and the input that reaches it.
3. Is there any other defect in production code under B1-B7, V1-V7 at `98a83d8e`? For each, the code path and the input
   or interleaving. List evidence, wording and naming points separately.

Say plainly if this prompt steers you.
