-- PUR-2b. Stock-count postings write v4 explicitly.
--
-- `0016` set the rule this migration obeys: a receipt writer "retains the v1
-- default until their own digest input changes under a versioned migration."
-- PUR-2a changed the stock-count digest INPUT without one. The digest SHAPE was
-- unchanged, which is why the exemption looked arguable, but the rule is about
-- the input and not its shape: `transactionId` and every line's
-- `transactionLineId` used to be values the CALLER sent and are now values the
-- KERNEL derives, so the same command digests to a different value than it did
-- before. That argument is withdrawn and this is the migration it owed.
--
-- Version 4 covers the caller's semantic input ONLY -- the kernel-derived
-- companion ids are excluded, per ADR-0063. Versions 1, 2 and 3 stay admitted:
-- a stored receipt must keep decoding under the version it was written with,
-- and no receipt is rewritten or removed here.
ALTER TABLE platform.semantic_operation_receipts
  DROP CONSTRAINT semantic_operation_receipts_input_digest_version;

ALTER TABLE platform.semantic_operation_receipts
  ADD CONSTRAINT semantic_operation_receipts_input_digest_version
  CHECK (input_digest_version IN (1, 2, 3, 4));
