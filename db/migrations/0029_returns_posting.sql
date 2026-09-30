-- Returns are two companion posting families. Digest version 7 covers caller
-- customer-return input and version 8 caller vendor-return input, each
-- excluding the kernel-derived companion identities. Existing receipt
-- versions remain readable.
ALTER TABLE platform.semantic_operation_receipts
  DROP CONSTRAINT semantic_operation_receipts_input_digest_version;
ALTER TABLE platform.semantic_operation_receipts
  ADD CONSTRAINT semantic_operation_receipts_input_digest_version
  CHECK (input_digest_version IN (1, 2, 3, 4, 5, 6, 7, 8));
