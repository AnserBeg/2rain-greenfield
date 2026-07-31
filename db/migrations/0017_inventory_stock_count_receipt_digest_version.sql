ALTER TABLE platform.semantic_operation_receipts
  DROP CONSTRAINT semantic_operation_receipts_input_digest_version;

ALTER TABLE platform.semantic_operation_receipts
  ADD CONSTRAINT semantic_operation_receipts_input_digest_version
  CHECK (input_digest_version IN (1, 2, 3));
