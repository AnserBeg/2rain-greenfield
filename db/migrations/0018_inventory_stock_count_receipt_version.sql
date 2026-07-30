-- G3-P4b extends the shared inventory-posting receipt payload with stock-count
-- evidence. Versions 1 and 2 remain readable; new receipts are written as v3.
ALTER TABLE platform.semantic_operation_receipts
  DROP CONSTRAINT semantic_operation_receipts_input_digest_version;

ALTER TABLE platform.semantic_operation_receipts
  ADD CONSTRAINT semantic_operation_receipts_input_digest_version
  CHECK (input_digest_version IN (1, 2, 3));
